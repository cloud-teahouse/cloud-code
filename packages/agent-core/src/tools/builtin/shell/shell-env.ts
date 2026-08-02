/**
 * Shared non-interactive terminal environment knobs for the shell tools.
 *
 * The one-shot Bash tool and persistent PTY sessions (ExecSession) both want
 * output free of colour escapes and pager prompts; the overlap between
 * `bash.ts`'s `noninteractiveEnv` and the PTY session env lives here so the
 * two never drift (RFC `docs/rfc/unified-exec-pty.md` §3.3).
 */

/**
 * Common subset: no colour, and a `dumb` TERM so full-screen cursor
 * addressing degrades to plain lines. For one-shot commands `TERM=dumb`
 * merely reflects the piped stdio; for PTY sessions the pty satisfies
 * `isatty()` and `dumb` is what suppresses the escape sequences.
 */
export const NONINTERACTIVE_TERM_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  TERM: 'dumb',
};

/**
 * Environment for persistent PTY sessions (codex process_manager.rs:70-81
 * parity): the common subset plus pager suppression and a stable UTF-8
 * locale so REPL/banner output is predictable.
 */
export const PTY_SESSION_ENV: Readonly<Record<string, string>> = {
  ...NONINTERACTIVE_TERM_ENV,
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  LC_ALL: 'C.UTF-8',
};
