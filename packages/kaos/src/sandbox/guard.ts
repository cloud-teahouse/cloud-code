/**
 * Sandbox execution guard — denyWrite + post-exit scrub for paths a sandboxed
 * command must never (re)create. Ported from Claude Code's
 * `sandbox-adapter.ts` two-phase bare-repo defence
 * (anthropics/claude-code#29316):
 *
 * The threat is a timing blind spot: the permission layer judges a command
 * BEFORE it runs, but a sandboxed command can PLANT files that only become
 * dangerous afterwards —
 *
 *  1. Bare-repo escape: git's `is_git_directory()` treats a cwd containing
 *     `HEAD` + `objects/` + `refs/` as a bare repo. A command planting those
 *     (plus a `config` carrying e.g. a malicious `core.fsmonitor`) escapes the
 *     sandbox the next time the host runs an UNSANDBOXED git command there
 *     (internal git probes, approved sandbox-escalation retries).
 *  2. Control-plane poisoning: skills / agent definitions / MCP server
 *     configs are auto-discovered and auto-loaded with full capabilities on
 *     the next session, so a planted `.cloud-code/skills/...` or
 *     `.cloud-code/mcp.json` is a persisted privilege escalation.
 *
 * The guard splits candidates by existence at exec time:
 *
 *  - EXISTING paths → appended to `policy.readOnlySubpaths`, so bwrap
 *    re-binds them read-only over the writable root (the denyWrite
 *    equivalent; upstream does exactly this with ro-binds). A bind-mounted
 *    file or directory is a mountpoint, so unlink/rename of the path itself
 *    also fails (EBUSY) — real files/dirs are fully protected.
 *  - MISSING scrub candidates → remembered; after the process exits the host
 *    removes whatever appeared at those paths. Missing read-only candidates
 *    are dropped (bwrap cannot bind a non-existent source, and their parent
 *    being read-only already prevents creation).
 *  - SYMLINKS (either group) → ro-bind the link TARGET as above, plus a
 *    {@link SandboxSymlinkWatch}: the mount lands on the target's canonical
 *    path, so the link path itself stays a plain writable dentry and
 *    `rm link && mkdir link` swaps the whole entry without touching the
 *    protected target. The watch records the link identity (inode + target
 *    string) at exec time; at exit, a replaced link (identity mismatch or
 *    no longer a symlink) is treated as planted and the replacement is
 *    scrubbed. A deleted link with nothing planted in its place is left
 *    alone — vandalism, not a poisoning vector.
 *
 * Scrubbing is keyed on "did not exist when the command started", so
 * pre-existing legitimate content (a real bare repo the user works in, a
 * checked-in `.cloud-code/skills`) is never deleted — it was ro-bound
 * instead.
 *
 * Known bounds, accepted deliberately (upstream accepts equivalents):
 *
 *  - PROCESS-LIFETIME BINDING: the scrub runs when the spawned process
 *    exits. A payload planted by a still-running long-lived background task
 *    (or a persistent ExecSession PTY, whose scrub granularity is the whole
 *    session) sits exposed until that process ends; ro-binds still apply
 *    for the run itself.
 *  - HOST RACE WINDOW: if the HOST legitimately creates a scrub candidate
 *    while the command is running (a Write-tool skill, `/add-dir` persisting
 *    `local.toml`), the post-exit scrub removes it. The window is one
 *    command's lifetime; upstream's variant (unconditional denyWrite
 *    stubs) is more destructive, not less.
 *  - SILENT SCRUB: the model gets no feedback that its command's output
 *    files were scrubbed (the action is logged via the onScrub sink only).
 *    Re-injecting a reminder into the conversation is a deliberate
 *    follow-up, not an oversight.
 */

import { lstatSync, readlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Files git's `is_git_directory()` checks when deciding a directory IS a
 * bare repository: `HEAD` + `objects/` + `refs/` are the detection triplet;
 * `hooks/` and `config` carry the executable payloads (hook scripts,
 * `core.fsmonitor` / `core.sshCommand` style command injection).
 */
export const BARE_GIT_REPO_FILES: readonly string[] = ['HEAD', 'objects', 'refs', 'hooks', 'config'];

/**
 * Identity of a symlink candidate captured at exec time. bwrap ro-binds the
 * link's TARGET (canonicalized), which cannot freeze the link path itself:
 * inside the sandbox the link is a plain writable dentry, so
 * `rm .cloud-code && mkdir .cloud-code` swaps the entry wholesale while the
 * protected target stays intact — and the planted replacement would
 * survive. At exit the identity is re-checked; any replacement is scrubbed.
 */
export interface SandboxSymlinkWatch {
  /** Absolute link path. */
  readonly path: string;
  /** `lstat` inode at exec time; a recreated link always gets a fresh one. */
  readonly ino: number;
  /** `readlink` target string at exec time (kept verbatim, may be relative). */
  readonly target: string;
}

export interface SandboxGuardPlan {
  /**
   * Existing paths to append to `policy.readOnlySubpaths` (bwrap re-binds
   * them read-only after the writable-root binds, so they win). Symlink
   * candidates appear here too — the backend canonicalizes them onto the
   * link target.
   */
  readonly readOnlySubpaths: readonly string[];
  /**
   * Scrub candidates that do not exist right now; if the command plants
   * anything there, the host deletes it once the process exits.
   */
  readonly scrubPaths: readonly string[];
  /**
   * Candidates that were symlinks at exec time: ro-bound via their target
   * AND identity-watched, so a link swap is scrubbed as planted at exit.
   */
  readonly symlinkWatches: readonly SandboxSymlinkWatch[];
}

export interface SandboxGuardPlanInput {
  /**
   * Paths that must never be CREATED by a sandboxed command: existing ones
   * are ro-bound, missing ones are scrubbed from the host after exit.
   */
  readonly scrubCandidates?: readonly string[];
  /**
   * denyWrite equivalents whose creation is already impossible (read-only
   * parent) or whose mid-command host creation is legitimate (session state
   * the CLI itself writes): existing ones are ro-bound, missing ones are
   * left alone.
   */
  readonly readOnlyCandidates?: readonly string[];
}

/** Bare-repo guard paths for every distinct base directory. */
export function bareGitRepoGuardPaths(baseDirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const dir of baseDirs) {
    const base = resolve(dir);
    if (seen.has(base)) continue;
    seen.add(base);
    for (const file of BARE_GIT_REPO_FILES) {
      paths.push(resolve(base, file));
    }
  }
  return paths;
}

/**
 * Partition guard candidates by current existence. Pure with respect to its
 * inputs except the `lstatSync`/`readlinkSync` probes (lstat semantics: any
 * link counts as existing, including a dangling one, so a pre-planted
 * symlink is never mistaken for an empty slot — it is ro-bound via its
 * target and identity-watched, and `rmSync` on a link only ever removes the
 * link itself).
 */
export function planSandboxGuard(input: SandboxGuardPlanInput): SandboxGuardPlan {
  const readOnlySubpaths: string[] = [];
  const scrubPaths: string[] = [];
  const symlinkWatches: SandboxSymlinkWatch[] = [];
  const seen = new Set<string>();
  const addExisting = (p: string, stat: import('node:fs').Stats): void => {
    readOnlySubpaths.push(p);
    if (stat.isSymbolicLink()) {
      try {
        symlinkWatches.push({ path: p, ino: stat.ino, target: readlinkSync(p) });
      } catch {
        // readlink raced a concurrent swap — the watch falls away, but the
        // ro-bind still covers whatever the target resolves to at buildCommand
        // time, and a replaced link at exit matches no identity anyway.
      }
    }
  };
  for (const raw of input.scrubCandidates ?? []) {
    const p = resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    const stat = lstatOrNull(p);
    if (stat === null) {
      scrubPaths.push(p);
    } else {
      addExisting(p, stat);
    }
  }
  for (const raw of input.readOnlyCandidates ?? []) {
    const p = resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    const stat = lstatOrNull(p);
    if (stat !== null) {
      addExisting(p, stat);
    }
  }
  return { readOnlySubpaths, scrubPaths, symlinkWatches };
}

/**
 * Host-side scrub of paths planted by a finished sandboxed command.
 * `rmSync` never follows symlinks (a planted link is removed, its target
 * untouched) and `force` makes the common nothing-was-planted case a silent
 * no-op. Returns the paths actually removed so callers can log them.
 */
export function scrubSandboxGuardPaths(paths: readonly string[]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    if (lstatOrNull(p) === null) continue;
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // Best effort: a path we cannot remove is no worse than before the
      // guard existed; surface nothing and keep scrubbing the rest.
    }
  }
  return removed;
}

/**
 * Post-exit counterpart of {@link SandboxSymlinkWatch}: detect link swaps a
 * sandboxed command used to bypass the target ro-bind
 * (`rm .cloud-code && mkdir .cloud-code`). A replacement — whether a real
 * directory/file or a fresh symlink (inode / target mismatch) — is treated
 * as planted and scrubbed; a vanished link with nothing in its place is
 * left alone. Returns the paths actually removed.
 */
export function scrubReplacedGuardSymlinks(watches: readonly SandboxSymlinkWatch[]): string[] {
  const removed: string[] = [];
  for (const watch of watches) {
    const stat = lstatOrNull(watch.path);
    if (stat === null) continue;
    if (stat.isSymbolicLink() && linkIdentityMatches(watch, stat)) continue;
    try {
      // rmSync never follows symlinks, so a swapped-in link loses only the
      // link; a swapped-in real directory is scrubbed wholesale (planted).
      rmSync(watch.path, { recursive: true, force: true });
      removed.push(watch.path);
    } catch {
      // Best effort, same rationale as scrubSandboxGuardPaths.
    }
  }
  return removed;
}

function linkIdentityMatches(
  watch: SandboxSymlinkWatch,
  stat: import('node:fs').Stats,
): boolean {
  if (stat.ino !== watch.ino) return false;
  try {
    return readlinkSync(watch.path) === watch.target;
  } catch {
    return false;
  }
}

function lstatOrNull(path: string): import('node:fs').Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
