/**
 * Git operations backing the EnterWorktree/ExitWorktree tools.
 *
 * Every git invocation goes through kaos (`git -C <dir> ...`) so non-local
 * kaos backends behave identically, and no process-level `chdir` ever
 * happens — `LocalKaos` tracks cwd per instance, which also makes
 * `git worktree remove` safe while the session cwd sits inside the target.
 *
 * The worktree layout mirrors Claude Code's: worktrees live at
 * `<mainRepoRoot>/.cloud-code/worktrees/<flattened-slug>` on a branch named
 * `worktree-<flattened-slug>`, created with `-B` so an orphan branch left by
 * a deleted worktree directory is reset instead of blocking creation.
 */

import { Buffer } from 'node:buffer';

import ignore from 'ignore';
import * as pathe from 'pathe';

import type { Kaos } from '@cloud-code/kaos';

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

/** Quick probes stay well under this; `worktree add` on a large tree may not. */
const GIT_TIMEOUT_MS = 15_000;
const GIT_ADD_TIMEOUT_MS = 120_000;

export interface GitExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the process never produced an exit status (spawn error, timeout). */
  readonly exitCode: number | null;
}

/**
 * Run `git -C <cwd> <args>` and capture both streams. Never throws: spawn
 * failures and timeouts come back as `ok: false` with `exitCode: null` so
 * callers can fail closed without try/catch plumbing.
 *
 * The process is spawned from a kaos re-rooted at `cwd` itself: the agent's
 * kaos may legitimately point at a directory that no longer exists (e.g. a
 * worktree deleted mid-session), and a missing spawn cwd turns every git
 * call into a spurious ENOENT.
 */
export async function execGit(
  kaos: Kaos,
  cwd: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number },
): Promise<GitExecResult> {
  let proc: Awaited<ReturnType<Kaos['exec']>> | undefined;
  try {
    proc = await kaos.withCwd(cwd).exec('git', '-C', cwd, ...args);
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }

  try {
    proc.stdin.end();
  } catch {
    // stdin already closed
  }

  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  // Attach a rejection handler up front so a late rejection during the
  // timeout window is never flagged as unhandled.
  work.catch(() => {});
  const timeoutMs = options?.timeoutMs ?? GIT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, timeoutMs);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return {
      ok: exitCode === 0,
      stdout,
      stderr: stderr.trim(),
      exitCode,
    };
  } catch (error) {
    if (timedOut) {
      try {
        await proc.kill('SIGKILL');
      } catch {
        // process already gone
      }
    }
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await proc.dispose();
  }
}

async function collectStream(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Validates a worktree slug to prevent path traversal and directory escape.
 *
 * The slug is joined into `.cloud-code/worktrees/<slug>` via path joining,
 * which normalizes `..` segments — so `../../../target` would escape the
 * worktrees directory. Similarly, an absolute path (leading `/` or `C:\`)
 * would discard the prefix entirely.
 *
 * Forward slashes are allowed for grouping (e.g. `asm/feature-foo`); each
 * segment is validated independently against the allowlist, so `.` / `..`
 * segments and drive-spec characters are still rejected.
 *
 * Throws synchronously — callers rely on this running before any side
 * effects (git commands, record writes, cwd switches).
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    );
  }
  // Leading or trailing `/` would make the join produce an absolute path or a
  // dangling segment. Splitting and validating each segment rejects both
  // (empty segments fail the regex) while allowing `user/feature`.
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      );
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
}

/**
 * Flatten grouped slugs (`user/feature` → `user+feature`) for both the
 * branch name and the directory path. Nesting in either location is unsafe:
 *   - git refs: `worktree-user` (file) vs `worktree-user/feature` (needs a
 *     dir) is a D/F conflict git rejects.
 *   - directory: `.cloud-code/worktrees/user/feature/` lives inside the
 *     `user` worktree; `git worktree remove` on the parent deletes children
 *     with uncommitted work.
 * `+` is valid in git branch names and filesystem paths but NOT in the
 * slug-segment allowlist, so the mapping is injective.
 */
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+');
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}

export function worktreesDir(mainRepoRoot: string): string {
  return pathe.join(mainRepoRoot, '.cloud-code', 'worktrees');
}

export function worktreePathFor(mainRepoRoot: string, slug: string): string {
  return pathe.join(worktreesDir(mainRepoRoot), flattenSlug(slug));
}

export interface RepoContext {
  /** Working-tree root of the repository containing the session cwd. */
  readonly repoRoot: string;
  /**
   * Main working-tree root of that repository. Differs from `repoRoot` when
   * the session cwd sits inside a linked worktree: new worktrees are always
   * created under the main checkout's `.cloud-code/worktrees/`, never nested
   * inside another worktree.
   */
  readonly mainRepoRoot: string;
}

/**
 * Resolve the repository context for `cwd`, or null when `cwd` is not inside
 * a git working tree. `rev-parse --show-toplevel` reports the working tree
 * containing `cwd`. The main working-tree root is derived without trusting
 * `git worktree list` blindly:
 *   - main checkout (`--absolute-git-dir` == `--git-common-dir`): the
 *     toplevel IS the main root — covers plain repos and submodule checkouts.
 *   - linked worktree: the first `git worktree list --porcelain` entry names
 *     the main worktree — except for submodules, where git reports the
 *     module gitdir instead of the workdir; that case is resolved through
 *     the shared config's `core.worktree` (relative to the gitdir).
 */
export async function resolveRepoContext(kaos: Kaos, cwd: string): Promise<RepoContext | null> {
  const [top, gitDirResult, commonDirResult] = await Promise.all([
    execGit(kaos, cwd, ['rev-parse', '--show-toplevel']),
    execGit(kaos, cwd, ['rev-parse', '--absolute-git-dir']),
    execGit(kaos, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (!top.ok || top.stdout.trim().length === 0) return null;
  const repoRoot = pathe.normalize(top.stdout.trim());

  if (gitDirResult.ok && commonDirResult.ok) {
    const gitDir = pathe.normalize(gitDirResult.stdout.trim());
    const commonDir = pathe.normalize(commonDirResult.stdout.trim());
    if (gitDir === commonDir) {
      return { repoRoot, mainRepoRoot: repoRoot };
    }

    const list = await execGit(kaos, cwd, ['worktree', 'list', '--porcelain']);
    const first = list.ok
      ? list.stdout.split('\n').find((line) => line.startsWith('worktree '))
      : undefined;
    const listed = first?.slice('worktree '.length).trim();
    if (listed !== undefined && listed.length > 0) {
      const main = pathe.normalize(listed);
      if (main !== commonDir) {
        return { repoRoot, mainRepoRoot: main };
      }
      // Submodule quirk: the main "worktree" is reported as the module
      // gitdir. The real workdir is the shared config's core.worktree.
      const coreWorktree = await execGit(kaos, cwd, [
        '--git-dir',
        commonDir,
        'config',
        '--get',
        'core.worktree',
      ]);
      if (coreWorktree.ok && coreWorktree.stdout.trim().length > 0) {
        const configured = coreWorktree.stdout.trim();
        const resolved = pathe.isAbsolute(configured)
          ? configured
          : pathe.resolve(commonDir, configured);
        return { repoRoot, mainRepoRoot: pathe.normalize(resolved) };
      }
      return { repoRoot, mainRepoRoot: main };
    }
  }

  return { repoRoot, mainRepoRoot: repoRoot };
}

/** HEAD commit of the worktree at `path`, or null when it is not a git worktree. */
export async function readWorktreeHead(kaos: Kaos, path: string): Promise<string | null> {
  const result = await execGit(kaos, path, ['rev-parse', 'HEAD']);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Resolve `ref` to a commit sha within the repo containing `cwd`; null on failure. */
export async function resolveBaseCommit(
  kaos: Kaos,
  cwd: string,
  ref: string,
): Promise<string | null> {
  const result = await execGit(kaos, cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Current branch name of the repo containing `cwd`; undefined when detached. */
export async function currentBranch(kaos: Kaos, cwd: string): Promise<string | undefined> {
  const result = await execGit(kaos, cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!result.ok) return undefined;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : undefined;
}

/**
 * Create the worktree with `git worktree add -B <branch> <path> <baseSha>`.
 * `-B` (not `-b`) resets an orphan branch left behind by a removed worktree
 * directory. A branch checked out in another worktree, or a stale
 * non-worktree directory at `path`, fails here and surfaces git's stderr.
 */
export async function createWorktree(
  kaos: Kaos,
  mainRepoRoot: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await kaos.mkdir(worktreesDir(mainRepoRoot), { parents: true, existOk: true });
  const result = await execGit(
    kaos,
    mainRepoRoot,
    ['worktree', 'add', '-B', branch, path, baseSha],
    { timeoutMs: GIT_ADD_TIMEOUT_MS },
  );
  if (!result.ok) {
    throw new Error(`Failed to create worktree: ${result.stderr || 'git worktree add failed'}`);
  }
}

/**
 * Force-remove the worktree at `path`. Returns git's stderr on failure so
 * the caller can keep the session state untouched and report honestly.
 */
export async function removeWorktree(
  kaos: Kaos,
  mainRepoRoot: string,
  path: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const result = await execGit(kaos, mainRepoRoot, ['worktree', 'remove', '--force', path]);
  return { ok: result.ok, stderr: result.stderr };
}

/** Delete the temporary worktree branch. Best-effort: caller decides how to report failure. */
export async function deleteWorktreeBranch(
  kaos: Kaos,
  mainRepoRoot: string,
  branch: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const result = await execGit(kaos, mainRepoRoot, ['branch', '-D', branch]);
  return { ok: result.ok, stderr: result.stderr };
}

export interface WorktreeChangeSummary {
  readonly changedFiles: number;
  readonly commits: number;
}

/**
 * Count uncommitted files and commits ahead of `baseSha` in the worktree.
 * Returns null when state cannot be reliably determined — callers using this
 * as a removal gate must treat null as "unknown, assume unsafe" (fail-closed):
 * a silent 0/0 would let a removal destroy real work.
 */
export async function countWorktreeChanges(
  kaos: Kaos,
  path: string,
  baseSha: string,
): Promise<WorktreeChangeSummary | null> {
  const status = await execGit(kaos, path, ['status', '--porcelain']);
  if (!status.ok) return null;
  const changedFiles = status.stdout.split('\n').filter((line) => line.trim() !== '').length;

  const revList = await execGit(kaos, path, ['rev-list', '--count', `${baseSha}..HEAD`]);
  if (!revList.ok) return null;
  const commits = Number.parseInt(revList.stdout.trim(), 10) || 0;

  return { changedFiles, commits };
}

/**
 * Carry the workspace-local config (`.cloud-code/local.toml`, the analog of
 * Claude Code's settings.local.json) into the new worktree so workspace
 * settings such as additional_dir keep applying there. Best-effort: a
 * missing file is normal, other failures are logged and skipped.
 */
export async function copyWorkspaceLocalConfig(
  kaos: Kaos,
  repoRoot: string,
  worktreePath: string,
  warn: (message: string) => void,
): Promise<void> {
  const relative = pathe.join('.cloud-code', 'local.toml');
  const source = pathe.join(repoRoot, relative);
  let content: Buffer;
  try {
    content = await kaos.readBytes(source);
  } catch {
    // No local config to carry — the common case.
    return;
  }
  try {
    const dest = pathe.join(worktreePath, relative);
    await kaos.mkdir(pathe.dirname(dest), { parents: true, existOk: true });
    await kaos.writeBytes(dest, content);
  } catch (error) {
    warn(`Failed to copy workspace local config to worktree: ${errorMessage(error)}`);
  }
}

/**
 * Copy gitignored files matched by `.worktreeinclude` from the base checkout
 * into the worktree (gitignore syntax, one pattern per line, `#` comments).
 * This is how build-adjacent files a fresh checkout lacks — local env files,
 * downloaded fixtures — opt into propagation. Untracked-but-not-ignored files
 * are never copied: they are intentional local state, not inputs.
 *
 * Only files that are BOTH matched by `.worktreeinclude` AND gitignored are
 * copied. `git ls-files --others --ignored --exclude-standard --directory`
 * collapses fully-ignored directories into single entries so large build
 * outputs don't force a full tree walk; a pattern that explicitly targets a
 * path inside a collapsed directory expands just that directory with a
 * second scoped `ls-files` call.
 */
export async function copyWorktreeIncludeFiles(
  kaos: Kaos,
  repoRoot: string,
  worktreePath: string,
  warn: (message: string) => void,
): Promise<string[]> {
  let includeContent: string;
  try {
    includeContent = await kaos.readText(pathe.join(repoRoot, '.worktreeinclude'));
  } catch {
    return [];
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (patterns.length === 0) return [];

  const gitignored = await execGit(kaos, repoRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);
  if (!gitignored.ok || !gitignored.stdout.trim()) return [];

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean);
  const matcher = ignore().add(includeContent);

  // --directory emits collapsed dirs with a trailing slash; everything else
  // is an individual file.
  const collapsedDirs = entries.filter((entry) => entry.endsWith('/'));
  const files = entries.filter((entry) => !entry.endsWith('/') && matcher.ignores(entry));

  // Edge case: a pattern targets a path inside a collapsed dir (e.g.
  // `config/secrets/api.key` when all of `config/secrets/` is gitignored).
  // Expand only dirs where a pattern has that dir as its explicit path
  // prefix, the dir falls under an anchored glob's literal prefix, or the dir
  // itself matches a pattern. `**/` and anchorless patterns are excluded —
  // they match files in tracked dirs (already listed individually), and
  // expanding every collapsed dir for them would defeat the perf win.
  const dirsToExpand = collapsedDirs.filter((dir) => {
    if (
      patterns.some((pattern) => {
        const normalized = pattern.startsWith('/') ? pattern.slice(1) : pattern;
        if (normalized.startsWith(dir)) return true;
        const globIndex = normalized.search(/[*?[]/);
        if (globIndex > 0) {
          const literalPrefix = normalized.slice(0, globIndex);
          if (dir.startsWith(literalPrefix)) return true;
        }
        return false;
      })
    ) {
      return true;
    }
    return matcher.ignores(dir.slice(0, -1));
  });
  if (dirsToExpand.length > 0) {
    const expanded = await execGit(kaos, repoRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...dirsToExpand,
    ]);
    if (expanded.ok && expanded.stdout.trim()) {
      for (const file of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matcher.ignores(file)) files.push(file);
      }
    }
  }

  const copied: string[] = [];
  for (const relativePath of files) {
    const source = pathe.join(repoRoot, relativePath);
    const dest = pathe.join(worktreePath, relativePath);
    try {
      const content = await kaos.readBytes(source);
      await kaos.mkdir(pathe.dirname(dest), { parents: true, existOk: true });
      await kaos.writeBytes(dest, content);
      copied.push(relativePath);
    } catch (error) {
      warn(`Failed to copy ${relativePath} to worktree: ${errorMessage(error)}`);
    }
  }
  return copied;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
