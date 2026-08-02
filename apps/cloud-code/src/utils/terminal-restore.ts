/**
 * Best-effort terminal restoration for crash / emergency-exit paths.
 *
 * The normal shutdown path goes through pi-tui's `TUI.stop()`, which restores
 * raw mode, the cursor, bracketed paste, and the Kitty / modifyOtherKeys
 * keyboard protocols. When we bail out without running `TUI.stop()` — an
 * uncaught exception, a SIGTERM whose cleanup throws, or a SIGHUP — the
 * terminal would otherwise be left stuck in raw mode with a hidden cursor, and
 * the user's shell would look broken afterwards. Writing these sequences lets
 * the terminal recover.
 *
 * Every step is wrapped: the terminal may already be dead (EIO), and an exit
 * path must never throw.
 */

// Emergency restore, ordered from least to most disruptive so an early
// failure keeps the useful part: finish any synchronized-output block
// (`?2026l`), stop mouse reporting (`?1000l`, `?1006l`), focus reporting
// (`?1004l`) and color-scheme notifications (`?2031l`), clear the progress
// indicator (OSC 9;4), delete placed kitty images (`_Ga=d`), show the cursor
// (`?25h`), disable bracketed paste (`?2004l`), pop the Kitty keyboard
// protocol (`<u`), reset modifyOtherKeys (`>4;0m`), and only then leave the
// alternate screen (`?1049l`) so the user's shell content comes back last.
// Terminals ignore modes they never enabled, so this is safe everywhere.
const TERMINAL_RESTORE_SEQUENCE =
  '\u001B[?2026l' +
  '\u001B[?1000l\u001B[?1006l' +
  '\u001B[?1004l' +
  '\u001B[?2031l' +
  '\u001B]9;4;0;\u0007' +
  '\u001B_Ga=d\u001B\\' +
  '\u001B[?25h' +
  '\u001B[?2004l' +
  '\u001B[<u' +
  '\u001B[>4;0m' +
  '\u001B[?1049l';

export function restoreTerminalModes(): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore — raw mode may not be active, or stdin may not be a TTY.
  }
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    // ignore — the terminal may already be dead (EIO).
  }
}
