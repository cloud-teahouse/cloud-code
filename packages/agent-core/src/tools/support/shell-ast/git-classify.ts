/**
 * Git subcommand classifier (design doc §3.1,
 * docs/phase5/guardian-and-bash-permissions.md).
 *
 * Pure function over the tokens of one simple command (the output of
 * `parts()`: command name plus word/string arguments). It produces data
 * only — nothing here feeds rule generation or permission matching.
 *
 * Order of decisions:
 *   1. The command name basename must be `git` (`/usr/bin/git` qualifies);
 *      otherwise the result is `undefined` (not a git command).
 *   2. Global-option scan before the subcommand: `-c` / `--exec-path` /
 *      `--config-env` in any spelling means `config-injection` (a borrowed
 *      git binary can run arbitrary commands through aliases/exec-path).
 *   3. Subcommand table lookup, with flag-driven escalation for the
 *      subcommands whose danger depends on their flags (`commit --amend`,
 *      `branch -D`, `tag -f`, `reflog expire`).
 *
 * Global-option consumption table (git stops global-option parsing at the
 * first non-option token, so this scan mirrors real git):
 *
 *   token                          meaning                       action
 *   -----------------------------  ----------------------------  ----------------
 *   `-c`, `-c<name>=<value>`       inline config (alias/exec)    config-injection
 *   `--config-env[=<name>=<var>]`  config from env var           config-injection
 *   `--exec-path[=<path>]`         exec-path override            config-injection
 *   `-C <path>`                    chdir — a path, NOT injection  consume value
 *   `--git-dir[=<path>]`           repository dir                consume value
 *   `--work-tree[=<path>]`         work tree                     consume value
 *   `--namespace[=<name>]`         namespace                     consume value
 *   `--attr-source[=<tree>]`       attribute source              consume value
 *   any other `-…` token           valueless global option       skip
 *   first non-option token         the subcommand                stop scanning
 *
 * Known limitations (every one fails toward over-classification, never
 * under-classification):
 *   - Subcommand flag scans treat any flag-looking argument as a flag:
 *     `git commit -m --amend` reads `--amend` as the flag, not the commit
 *     message — may escalate local-write to history-write, never down.
 *   - Short-option bundles match by character (`git branch -mD tmp` hits
 *     the `D` check although `D` is the `-m` value) — same safe direction.
 *   - Quoted command names (`'git' push`) keep their quotes in `parts()`
 *     and classify as non-git, exactly the legacy visibility.
 *   - Subcommands not listed below (including external ones like
 *     `filter-repo`) classify as `unknown`, which downstream treats as a
 *     mutation — an alias like `git co` intentionally lands there too.
 */

export type GitSegmentClass =
  | 'config-injection' // git -c / --exec-path / --config-env: arbitrary execution via git
  | 'shared-remote' // push: shared state leaves, cannot be taken back
  | 'history-write' // reset/rebase/commit --amend/update-ref/filter-branch/reflog expire/branch -D/tag -f
  | 'local-write' // commit/add/checkout/switch/restore/merge/stash/pull/fetch/tag/branch (plain)
  | 'read' // status/log/diff/show/blame/grep/ls-files/rev-parse/describe etc.
  | 'unknown' // unknown subcommand (may be an alias) — treated as a mutation downstream
  | undefined; // not a git command

/** Subcommands that never mutate repository state. */
const READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'blame',
  'cat-file',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'status',
  'whatchanged',
]);

/**
 * Plain local mutations. `commit`/`branch`/`tag` are NOT here — their class
 * depends on their flags, so they get dedicated escalation branches below.
 */
const LOCAL_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'fetch',
  'init',
  'merge',
  'mv',
  'pull',
  'restore',
  'revert',
  'rm',
  'stage',
  'stash',
  'switch',
]);

/** History rewriting regardless of flags. */
const HISTORY_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'filter-branch',
  'rebase',
  'reset',
  'update-ref',
]);

export function classifyGitSegment(tokens: readonly string[]): GitSegmentClass {
  const name = tokens[0];
  if (name === undefined) return undefined;
  const slash = name.lastIndexOf('/');
  if ((slash === -1 ? name : name.slice(slash + 1)) !== 'git') return undefined;

  // Global-option scan: runs until the first non-option token (git's own
  // grammar) and short-circuits on the config-injection trio.
  let subcommandIndex = 1;
  for (; subcommandIndex < tokens.length; subcommandIndex++) {
    const token = tokens[subcommandIndex]!;
    if (!token.startsWith('-')) break;
    if (
      // `-c` and its attached-value spelling `-c<name>=<value>`; long
      // options start with `--` and cannot collide with this prefix.
      token.startsWith('-c') ||
      token === '--config-env' ||
      token.startsWith('--config-env=') ||
      token === '--exec-path' ||
      token.startsWith('--exec-path=')
    ) {
      return 'config-injection';
    }
    if (
      token === '-C' ||
      token === '--git-dir' ||
      token === '--work-tree' ||
      token === '--namespace' ||
      token === '--attr-source'
    ) {
      // Separate-value global options: skip their value too. The `=`
      // spellings are self-contained and fall through to the plain skip.
      subcommandIndex++;
    }
  }

  const subcommand = tokens[subcommandIndex];
  if (subcommand === undefined) {
    // git without a subcommand (bare `git`, `git --version`, a dangling
    // `git -C`) prints usage/version or errors out — there is no
    // repository operation to classify.
    return 'read';
  }
  const args = argsBeforeDoubleDash(tokens, subcommandIndex + 1);

  if (READ_SUBCOMMANDS.has(subcommand)) return 'read';
  if (subcommand === 'push') return 'shared-remote';
  if (HISTORY_WRITE_SUBCOMMANDS.has(subcommand)) return 'history-write';
  if (subcommand === 'commit') {
    return hasFlag(args, 'amend') ? 'history-write' : 'local-write';
  }
  if (subcommand === 'branch') {
    return hasShortFlag(args, 'D') || (hasFlag(args, 'delete', 'd') && hasFlag(args, 'force', 'f'))
      ? 'history-write'
      : 'local-write';
  }
  if (subcommand === 'tag') {
    return hasFlag(args, 'force', 'f') ? 'history-write' : 'local-write';
  }
  if (subcommand === 'reflog') {
    return args[0] === 'expire' || args[0] === 'delete' ? 'history-write' : 'read';
  }
  if (LOCAL_WRITE_SUBCOMMANDS.has(subcommand)) return 'local-write';
  return 'unknown';
}

/** Subcommand arguments, stopping at the `--` pathspec separator. */
function argsBeforeDoubleDash(tokens: readonly string[], start: number): readonly string[] {
  const end = tokens.indexOf('--', start);
  return end === -1 ? tokens.slice(start) : tokens.slice(start, end);
}

/**
 * Long-flag (`--force`) or bundled short-flag (`-f`, `d` inside `-ad`)
 * presence. Bundles match by character anywhere after the dash, so a value
 * glued to a bundle can over-match (safe direction, see the header).
 */
function hasFlag(args: readonly string[], long: string, short?: string): boolean {
  return args.some(
    (arg) => arg === `--${long}` || (short !== undefined && shortBundleHas(arg, short)),
  );
}

function hasShortFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => shortBundleHas(arg, flag));
}

/** True for a single-dash token whose bundle contains `flag` (`-ad` has `d`). */
function shortBundleHas(arg: string, flag: string): boolean {
  return arg.length > 1 && arg[0] === '-' && arg[1] !== '-' && arg.slice(1).includes(flag);
}
