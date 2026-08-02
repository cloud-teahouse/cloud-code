/**
 * Safe-wrapper stripping for Bash permission rules (design doc §3.2.A,
 * docs/phase5/guardian-and-bash-permissions.md), ported from claude's
 * `stripSafeWrappers` semantics (claude-third-pass.md:11-13).
 *
 * Two pure entry points:
 *
 *   - {@link stripWrapperTokens} — token level, feeds arity-prefix rule
 *     generation: `sudo git push origin main` grants `Bash(git push *)`
 *     instead of the over-broad `Bash(sudo *)`.
 *   - {@link stripWrapperPrefixes} — string level, feeds rule matching with
 *     the allow/deny asymmetry: allow rules strip only {@link SAFE_ENV_VARS}
 *     assignments (so `DOCKER_HOST=evil docker ps` never auto-matches an
 *     allow rule), deny/ask rules strip every leading assignment (so
 *     `FOO=evil sudo rm x` still hits a `Bash(rm *)` deny).
 *
 * SECURITY invariants ported from claude:
 *
 *   - Two phases: leading `VAR=val` assignments are stripped only BEFORE
 *     any wrapper; after a wrapper, `VAR=val` is the command the wrapper
 *     execs (HackerOne #3543050), never an assignment to peel. At the
 *     token level this is structural — the parser keeps pre-command
 *     assignments out of the token stream, so only `env`'s own VAR=val
 *     arguments are ever consumed.
 *   - Wrapper flag values must match [A-Za-z0-9_.+-]; anything else (e.g.
 *     `timeout -k$(id)`) refuses the strip for the whole segment, falling
 *     back to the unstripped form.
 *   - String-level patterns use [ \t]+, never \s+: \s matches \n, a
 *     command separator — stripping across it would misidentify the
 *     command on the next line.
 *
 * KEEP IN SYNC: the token-level consumers and the string-level
 * SAFE_WRAPPER_PATTERNS encode the same wrapper table. The flag specs
 * (SUDO_FLAGS, DOAS_FLAGS, ENV_FLAGS, TIMEOUT_FLAGS) are the single source
 * both sides are built from.
 */

/**
 * Env vars that make a *different binary* run (injection or resolution
 * hijack). Never stripped for allow rules — they are excluded from
 * {@link SAFE_ENV_VARS} by construction and re-checked at strip time as
 * defense in depth. (Same regex as claude's BINARY_HIJACK_VARS.)
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/;

/**
 * Allow-rule env whitelist, ported from claude's SAFE_ENV_VARS (locale,
 * terminal, build/test knobs — no credentials, no binary-hijack vectors).
 * Deliberately absent: PATH, LD_*, DYLD_* (BINARY_HIJACK_VARS),
 * KUBECONFIG, NODE_OPTIONS, PYTHONPATH — they change what runs or where it
 * talks, so an allow rule must not ignore them.
 */
const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  // Go — build/runtime settings only
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  // Rust — logging/debugging only
  'RUST_BACKTRACE',
  'RUST_LOG',
  // Node — environment name only (not NODE_OPTIONS)
  'NODE_ENV',
  // Python — behavior flags only (not PYTHONPATH)
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  // Pytest — test configuration
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  // Locale and character encoding
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  // Terminal and display
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
]);

/** Allowlist for wrapper flag VALUES (durations `10`/`5s`, signals `TERM`/`9`). */
const WRAPPER_FLAG_VALUE = /^[A-Za-z0-9_.+-]+$/;

/**
 * `env` VAR=val argument at the token level. The value is NOT
 * charset-checked here: a token is a single argv element, and real env
 * treats any `NAME=<anything>` as an assignment — the command boundary it
 * implies is exact. Shell metacharacters in a value are expanded by the
 * shell before env runs, and their inner commands are separate segments
 * (tree-sitter recurses into substitutions). The string-level env pattern
 * below stays strict because a regex must not eat across metacharacters.
 */
const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface WrapperFlagSpec {
  /** Flags that take no value (`-E`, `--preserve-env`). */
  readonly free: readonly string[];
  /**
   * Flags taking one value; both fused (`-uroot`, `--user=root`) and
   * separate (`-u root`, `--user root`) spellings. Values must match
   * {@link WRAPPER_FLAG_VALUE}.
   */
  readonly value: readonly string[];
  /**
   * Long flags with an optional value that only comes `=`-fused
   * (`--preserve-env=FOO`); the separate form is NOT consumed (getopt
   * optional-argument semantics — `--preserve-env FOO` runs `FOO`).
   */
  readonly equalsValue?: readonly string[];
}

// sudo: `-l`/`--list` and `-e`/`--edit` are deliberately absent — they do
// not exec the following token as a command, so stripping around them
// would misidentify what runs.
const SUDO_FLAGS: WrapperFlagSpec = {
  free: [
    '-A',
    '-E',
    '-H',
    '-K',
    '-P',
    '-S',
    '-b',
    '-i',
    '-k',
    '-n',
    '-s',
    '-v',
    '--askpass',
    '--background',
    '--login',
    '--non-interactive',
    '--preserve-env',
    '--shell',
    '--stdin',
  ],
  value: [
    '-C',
    '-T',
    '-g',
    '-h',
    '-p',
    '-r',
    '-t',
    '-u',
    '--chdir',
    '--command-timeout',
    '--group',
    '--host',
    '--prompt',
    '--role',
    '--type',
    '--user',
  ],
  equalsValue: ['--preserve-env'],
};

const DOAS_FLAGS: WrapperFlagSpec = {
  free: ['-S', '-k', '-n', '-s'],
  value: ['-C', '-u'],
};

const ENV_FLAGS: WrapperFlagSpec = {
  free: ['-0', '-i', '-v', '--ignore-environment', '--null'],
  value: ['-C', '-u', '--chdir', '--unset'],
};

const TIMEOUT_FLAGS: WrapperFlagSpec = {
  free: ['-v', '--foreground', '--preserve-status', '--verbose'],
  value: ['-k', '-s', '--kill-after', '--signal'],
};

/* ------------------------------------------------------------------ */
/*  Token level (rule generation)                                      */
/* ------------------------------------------------------------------ */

export interface StrippedTokens {
  /** Tokens of the underlying command after peeling wrappers. */
  readonly tokens: readonly string[];
  /** False when nothing was peeled (including a refused strip). */
  readonly stripped: boolean;
}

/**
 * Strip wrapper commands from a segment's tokens. Pure function.
 *
 * Any wrapper whose arguments fall outside the safe grammar (unknown flag,
 * flag value outside [A-Za-z0-9_.+-], missing duration/command) refuses
 * the strip for the WHOLE segment: the original tokens come back with
 * `stripped: false`, and the caller keeps pre-P2 behavior.
 */
export function stripWrapperTokens(tokens: readonly string[]): StrippedTokens {
  let current = tokens;
  let stripped = false;
  for (;;) {
    const name = basenameOf(current[0]);
    const consume = name === undefined ? undefined : WRAPPER_CONSUMERS[name];
    if (consume === undefined) break;
    const next = consume(current);
    if (next < 0 || next >= current.length) {
      // Refused (unsafe arguments) or a bare wrapper with no command
      // behind it: keep the whole segment as-is.
      return { tokens, stripped: false };
    }
    current = current.slice(next);
    stripped = true;
  }
  return { tokens: current, stripped };
}

function basenameOf(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/** Consumer: index of the wrapped command's first token, or -1 to refuse. */
type WrapperConsumer = (tokens: readonly string[]) => number;

const WRAPPER_CONSUMERS: Readonly<Record<string, WrapperConsumer>> = {
  sudo: (tokens) => consumeFlags(tokens, 1, SUDO_FLAGS),
  doas: (tokens) => consumeFlags(tokens, 1, DOAS_FLAGS),
  env: consumeEnv,
  timeout: consumeTimeout,
  nice: consumeNice,
  nohup: consumePlainWrapper,
  time: consumePlainWrapper,
  stdbuf: consumeStdbuf,
  command: consumeShellKeyword,
  builtin: consumeShellKeyword,
};

/**
 * Consume wrapper flags per spec. Returns the index of the first
 * non-flag token (past an optional `--`), or -1 to refuse: unknown flag
 * or a value outside the allowlist.
 */
function consumeFlags(
  tokens: readonly string[],
  start: number,
  spec: WrapperFlagSpec,
): number {
  let i = start;
  for (; i < tokens.length; ) {
    const token = tokens[i]!;
    if (token === '--') return i + 1;
    if (!token.startsWith('-') || token === '-') return i;
    if (spec.free.includes(token)) {
      i++;
      continue;
    }
    const fused = attachedFlagValue(token, spec.value);
    if (fused !== undefined) {
      if (!WRAPPER_FLAG_VALUE.test(fused)) return -1;
      i++;
      continue;
    }
    const fusedEquals = attachedEqualsFlagValue(token, spec.equalsValue ?? []);
    if (fusedEquals !== undefined) {
      if (!WRAPPER_FLAG_VALUE.test(fusedEquals)) return -1;
      i++;
      continue;
    }
    if (spec.value.includes(token)) {
      const value = tokens[i + 1];
      if (value === undefined || !WRAPPER_FLAG_VALUE.test(value)) return -1;
      i += 2;
      continue;
    }
    return -1;
  }
  return i;
}

/** Fused value of a value-taking flag (`-uroot` → `root`, `--user=root` → `root`). */
function attachedFlagValue(token: string, valueFlags: readonly string[]): string | undefined {
  if (token.startsWith('--')) {
    for (const flag of valueFlags) {
      if (flag.startsWith('--') && token.startsWith(`${flag}=`)) {
        return token.slice(flag.length + 1);
      }
    }
    return undefined;
  }
  for (const flag of valueFlags) {
    if (!flag.startsWith('--') && token.startsWith(flag) && token.length > flag.length) {
      return token.slice(flag.length);
    }
  }
  return undefined;
}

/** Fused `=` value of an equals-only long flag (`--preserve-env=FOO` → `FOO`). */
function attachedEqualsFlagValue(token: string, flags: readonly string[]): string | undefined {
  for (const flag of flags) {
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * `env` consumes its own VAR=val arguments in addition to flags — they
 * are env's syntax, not shell-level assignments. The two-phase rule
 * (HackerOne #3543050) is still honored: the first token that is neither
 * flag nor assignment is the command, and nothing after it is peeled here.
 */
function consumeEnv(tokens: readonly string[]): number {
  let i = 1;
  for (; i < tokens.length; ) {
    const token = tokens[i]!;
    if (token === '--') return i + 1;
    if (ENV_ASSIGNMENT_TOKEN.test(token)) {
      i++;
      continue;
    }
    if (!token.startsWith('-') || token === '-') return i;
    const next = consumeFlags(tokens, i, ENV_FLAGS);
    if (next < 0) return -1;
    if (next === i) return -1; // flag-looking token outside env's grammar
    // consumeFlags stops at the first non-flag (possibly a VAR=val the
    // assignment branch above already handled) or past `--`; continue so
    // mixed `env -i FOO=bar --unset=X cmd` shapes work.
    if (tokens[next - 1] === '--') return next;
    i = next;
  }
  return i;
}

/** timeout: GNU flags (values allowlisted), then a mandatory DURATION. */
function consumeTimeout(tokens: readonly string[]): number {
  const i = consumeFlags(tokens, 1, TIMEOUT_FLAGS);
  if (i < 0) return -1;
  const duration = tokens[i];
  // A missing or non-numeric DURATION means timeout itself errors out —
  // refuse rather than guess which token is the command.
  if (duration === undefined || !/^\d+(?:\.\d+)?[smhd]?$/.test(duration)) return -1;
  return i + 1;
}

/** nice: optional `-n N` or legacy `-N`, optional `--`. */
function consumeNice(tokens: readonly string[]): number {
  let i = 1;
  const token = tokens[i];
  if (token === '-n') {
    const value = tokens[i + 1];
    if (value === undefined || !/^-?\d+$/.test(value)) return -1;
    i += 2;
  } else if (token !== undefined && /^-\d+$/.test(token)) {
    i++;
  }
  if (tokens[i] === '--') i++;
  return i;
}

/** nohup/time: no flags worth modeling, optional `--`. */
function consumePlainWrapper(tokens: readonly string[]): number {
  return tokens[1] === '--' ? 2 : 1;
}

/** stdbuf: one or more fused `-[ioe]MODE` flags, optional `--`. */
function consumeStdbuf(tokens: readonly string[]): number {
  let i = 1;
  while (i < tokens.length && /^-[ioe][LN0-9]+$/.test(tokens[i]!)) i++;
  if (i === 1) return -1; // bare stdbuf: fail closed, like claude
  if (tokens[i] === '--') i++;
  return i;
}

/**
 * command/builtin: strip only when the next token is not a flag —
 * `command -v ls` / `command -V ls` do not execute `ls`.
 */
function consumeShellKeyword(tokens: readonly string[]): number {
  const next = tokens[1];
  if (next === undefined || next.startsWith('-')) return -1;
  return 1;
}

/* ------------------------------------------------------------------ */
/*  String level (rule matching)                                       */
/* ---------------------------------------------------------------- */

export type WrapperStripMode = 'allow' | 'deny';

export interface StrippedCommand {
  readonly command: string;
  readonly stripped: boolean;
}

// Optional path before a wrapper name (`/usr/bin/sudo`), mirroring the
// token-level basename. Restricted charset: exotic paths simply don't
// strip (safe direction).
const PATH_PREFIX = '(?:/?[A-Za-z0-9_.+-]+/)*';

/**
 * Phase-1 assignment patterns (BEFORE any wrapper only).
 *
 * SECURITY: value character classes reject $ ` ; | & ( ) < > quotes and
 * whitespace, so an assignment can never smuggle a command separator or
 * substitution past the stripper. Trailing whitespace is [ \t]+, not \s+
 * (\n is a command separator — stripping across it would peel `FOO=1` off
 * one line and leave a different command on the next).
 */

// Strict pattern for allow rules (claude's ENV_VAR_PATTERN value class).
const SAFE_ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:+-]+)[ \t]+/;

// Broad pattern for deny/ask rules (claude's stripAllLeadingEnvVars):
// quoted values, concatenations and escapes included, so `FOO='a b' rm x`
// still hits a `Bash(rm *)` deny. $ and backtick stay excluded everywhere,
// which blocks $(cmd)/${var}/`cmd` smuggling.
const ANY_ENV_ASSIGNMENT =
  /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/;

function flagsToRegexAlternatives(spec: WrapperFlagSpec): string {
  const alternatives: string[] = spec.free.map(escapeRegExp);
  for (const flag of spec.value) {
    const escaped = escapeRegExp(flag);
    if (flag.startsWith('--')) {
      alternatives.push(`${escaped}=[A-Za-z0-9_.+-]+`, `${escaped}[ \\t]+[A-Za-z0-9_.+-]+`);
    } else {
      alternatives.push(`${escaped}[ \\t]+[A-Za-z0-9_.+-]+`, `${escaped}[A-Za-z0-9_.+-]+`);
    }
  }
  for (const flag of spec.equalsValue ?? []) {
    alternatives.push(`${escapeRegExp(flag)}=[A-Za-z0-9_.+-]+`);
  }
  return `(?:${alternatives.join('|')})`;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SUDO_PATTERN = new RegExp(
  `^${PATH_PREFIX}sudo(?:[ \\t]+${flagsToRegexAlternatives(SUDO_FLAGS)})*[ \\t]+(?:--[ \\t]+)?`,
);
const DOAS_PATTERN = new RegExp(
  `^${PATH_PREFIX}doas(?:[ \\t]+${flagsToRegexAlternatives(DOAS_FLAGS)})*[ \\t]+(?:--[ \\t]+)?`,
);
const ENV_PATTERN = new RegExp(
  `^${PATH_PREFIX}env(?:[ \\t]+(?:${flagsToRegexAlternatives(ENV_FLAGS)}|[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:+-]*))*[ \\t]+(?:--[ \\t]+)?`,
);
// timeout: claude's enumerated GNU flags — no-value long flags, value
// flags in both =fused and separate forms, short -v / -k / -s. Flag VALUES
// are allowlisted so `timeout -k$(id) 10 ls` does NOT strip.
const TIMEOUT_PATTERN = new RegExp(
  `^${PATH_PREFIX}timeout[ \\t]+` +
    '(?:(?:--(?:foreground|preserve-status|verbose)' +
    '|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+' +
    '|--(?:kill-after|signal)[ \\t]+[A-Za-z0-9_.+-]+' +
    '|-v' +
    '|-[ks][ \\t]+[A-Za-z0-9_.+-]+' +
    '|-[ks][A-Za-z0-9_.+-]+)[ \\t]+)*' +
    '(?:--[ \\t]+)?\\d+(?:\\.\\d+)?[smhd]?[ \\t]+',
);
const NICE_PATTERN = new RegExp(
  `^${PATH_PREFIX}nice(?:[ \\t]+-n[ \\t]+-?\\d+|[ \\t]+-\\d+)?[ \\t]+(?:--[ \\t]+)?`,
);
const STDBUF_PATTERN = new RegExp(
  `^${PATH_PREFIX}stdbuf(?:[ \\t]+-[ioe][LN0-9]+)+[ \\t]+(?:--[ \\t]+)?`,
);
const PLAIN_WRAPPER_PATTERN = new RegExp(`^${PATH_PREFIX}(?:nohup|time)[ \\t]+(?:--[ \\t]+)?`);
// `command -v ls` does not execute ls — only strip when a non-flag follows.
const SHELL_KEYWORD_PATTERN = new RegExp(`^${PATH_PREFIX}(?:command|builtin)[ \\t]+(?!-)`);

const SAFE_WRAPPER_PATTERNS: readonly RegExp[] = [
  TIMEOUT_PATTERN,
  NICE_PATTERN,
  STDBUF_PATTERN,
  PLAIN_WRAPPER_PATTERN,
  SUDO_PATTERN,
  DOAS_PATTERN,
  ENV_PATTERN,
  SHELL_KEYWORD_PATTERN,
];

/**
 * Strip leading env assignments and wrapper commands from a subject
 * string, for permission-rule matching. Pure function.
 *
 * Phase 1 peels `VAR=val` assignments only BEFORE the first wrapper —
 * after a wrapper, `VAR=val` is the command being exec'd (HackerOne
 * #3543050) and must survive into the matched text. Phase 2 peels
 * wrappers whose flags fit the safe grammar; anything else simply does
 * not match the patterns and stays put (the string-level equivalent of a
 * refused strip).
 *
 * Mode asymmetry: 'allow' strips only {@link SAFE_ENV_VARS} assignments
 * (BINARY_HIJACK_VARS never), 'deny' strips every assignment — deny rules
 * must be hard to circumvent.
 */
export function stripWrapperPrefixes(command: string, mode: WrapperStripMode): StrippedCommand {
  let current = command;
  let stripped = false;

  // Phase 1: leading assignments, before any wrapper.
  for (;;) {
    const match = (mode === 'allow' ? SAFE_ENV_ASSIGNMENT : ANY_ENV_ASSIGNMENT).exec(current);
    if (match === null) break;
    if (mode === 'allow') {
      const name = match[1]!;
      if (!SAFE_ENV_VARS.has(name) || BINARY_HIJACK_VARS.test(name)) break;
    }
    current = current.slice(match[0].length);
    stripped = true;
  }

  // Phase 2: wrappers (never assignments).
  for (;;) {
    let next = current;
    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      next = next.replace(pattern, '');
    }
    if (next === current) break;
    current = next;
    stripped = true;
  }

  return { command: current.trim(), stripped };
}
