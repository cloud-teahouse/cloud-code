/**
 * Control-plane self-protection for the OS sandbox (modeled on Claude
 * Code's rule: skills are auto-discovered, auto-loaded, full-capability, so
 * they need the same OS-level sandbox protection).
 *
 * Everything auto-loaded with elevated privilege is a poisoning target for
 * sandboxed commands, which can write anywhere under the workspace:
 *
 *  - `<project>/.cloud-code/` — project skills, custom agent definitions,
 *    `local.toml` (workspace `additional_dir`), `AGENTS.md` context, and
 *    `mcp.json` (project MCP servers; stdio entries SPAWN at session start,
 *    so a planted file is a persisted RCE).
 *  - `<cwd>/.cloud-code/` — the project-local `mcp.json` is resolved against
 *    the session cwd, not the project root, when the two differ.
 *  - `<project>/.agents/skills`, `<project>/.mcp.json` — the generic
 *    (Claude-compatible) skill and MCP load paths.
 *  - `~/.cloud-code` (brand home: `config.toml` permission rules, global
 *    `mcp.json`, OAuth credential store, user skills) and `~/.agents/skills`.
 *  - `<project>/.git/hooks` and `<project>/.git/config` — the executable
 *    surface of a REAL repo's `.git` (hook scripts, `core.fsmonitor` /
 *    `core.sshCommand` command injection into the next host-side git run).
 *    `.git` is deliberately NOT guarded wholesale: sandboxed `git commit` /
 *    `rebase` must keep working (objects/index/refs stay writable). Legit
 *    in-sandbox config writes (`git remote add`, `git config user.*`) are
 *    denied too (git's lock+rename onto the ro-bound mountpoint fails
 *    EBUSY) — an accepted tradeoff: the denial matches the sandbox-denial
 *    heuristic ("device or resource busy" / "read-only file system"), so
 *    the escalation approval channel can offer an unsandboxed retry instead
 *    of silently allowing the write.
 *
 * The returned lists feed `SandboxedKaos`'s guard (kaos `sandbox/guard.ts`):
 * scrub paths are ro-bound when they exist and host-deleted when a command
 * plants them; read-only paths are only ro-bound (the host itself writes
 * there mid-session, so post-exit deletion would eat legitimate state).
 *
 * User-level locations are never scrub candidates even when the workspace
 * overlaps them (a session whose cwd IS the home directory): the host
 * legitimately creates `~/.cloud-code` / `~/.agents/skills` at any time.
 *
 * Residual, documented rather than fixed (matches upstream): in a NON-git
 * workspace a command can plant a whole fake `.git/` directory
 * (`mkdir .git` needs no git binary) whose `config` the next host git call
 * would consume. Scrubbing `.git` on appearance cannot be distinguished
 * from a legitimate `git init` issued via Bash — a far more common flow —
 * so the hole stays open at this layer; the permission layer's git gate is
 * the control for the command-shaped variant.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'pathe';

export interface ControlPlaneGuardInput {
  /** Session working directory (the Bash tool's default cwd). */
  readonly cwd: string;
  /** Brand data dir — `~/.cloud-code` or `$CLOUD_CODE_HOME`. */
  readonly brandHomeDir: string;
  /** The OS user's home directory (hosts `~/.agents/skills`). */
  readonly userHomeDir: string;
  /**
   * Skill roots the registry actually loaded from (extra / plugin / builtin
   * dirs beyond the conventional ones). Guarded read-only: they may live
   * outside the workspace where the host also writes.
   */
  readonly skillRoots?: readonly string[];
  /** Existence probe, injectable for tests. Defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

export interface ControlPlaneGuardPaths {
  readonly scrubPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
}

export function collectControlPlaneGuardPaths(input: ControlPlaneGuardInput): ControlPlaneGuardPaths {
  const cwd = resolve(input.cwd);
  const brandHome = resolve(input.brandHomeDir);
  const userHome = resolve(input.userHomeDir);
  const exists = input.exists ?? existsSync;
  const projectRoot = findProjectRootForGuard(cwd, exists);

  const scrubPaths: string[] = [];
  const gitConfigPaths: string[] = [];
  for (const base of dedup([projectRoot, cwd])) {
    scrubPaths.push(
      join(base, '.cloud-code'),
      join(base, '.agents', 'skills'),
      join(base, '.mcp.json'),
      // A planted hooks directory is executable payload for the next host
      // git run: ro-bound when present, scrubbed when planted. See the
      // module header for why `.git` itself is not guarded.
      join(base, '.git', 'hooks'),
    );
    // ro-bind only: every real repo has a config, and a missing one must
    // NOT be scrubbed on appearance — a legitimate `git init` writes it.
    gitConfigPaths.push(join(base, '.git', 'config'));
  }

  const readOnlyPaths: string[] = [
    brandHome,
    join(userHome, '.agents', 'skills'),
    ...gitConfigPaths,
    ...(input.skillRoots ?? []),
  ];

  // Downgrade user-level paths from scrub to read-only: with cwd at (or
  // above) the home directory the conventional project paths alias the
  // user-level ones, and post-exit deletion of brand state or user skills
  // would be far worse than the poisoning gap it prevents.
  const protectedScrub: string[] = [];
  for (const candidate of scrubPaths) {
    if (candidate === brandHome || candidate.startsWith(brandHome + sep)) {
      readOnlyPaths.push(candidate);
      continue;
    }
    if (candidate === join(userHome, '.agents', 'skills')) {
      readOnlyPaths.push(candidate);
      continue;
    }
    protectedScrub.push(candidate);
  }

  return {
    scrubPaths: dedup(protectedScrub),
    readOnlyPaths: dedup(readOnlyPaths.map((p) => resolve(p))),
  };
}

/**
 * Synchronous `findProjectRoot` equivalent (nearest ancestor containing
 * `.git`, falling back to `cwd`), mirroring `config/workspace-local.ts` and
 * `skill/scanner.ts`. Sandbox policy is assembled synchronously at tool
 * construction, so this cannot go through the async kaos stat path.
 */
export function findProjectRootForGuard(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const initial = resolve(cwd);
  let current = initial;
  for (;;) {
    if (exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dedup(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
