/**
 * Sandbox-denial heuristic — a direct port of codex
 * `sandboxing/src/denial.rs` (`is_likely_sandbox_denied`).
 *
 * Callers must only invoke this for runs that actually went through the
 * sandbox; for unsandboxed runs the same keywords commonly describe
 * ordinary program errors (codex gates on `SandboxType::None` for the same
 * reason — `SandboxedKaos.wasSandboxed` plays that role here).
 */

export interface SandboxDenialOutput {
  readonly exitCode: number;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  /** Aggregated stdout+stderr, when the caller does not separate streams. */
  readonly output?: string | undefined;
}

const SANDBOX_DENIED_KEYWORDS: readonly string[] = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'seccomp',
  'sandbox',
  'landlock',
  'failed to write file',
  // EBUSY. Replacing (rename/unlink over) an ro-bind mountpoint fails with
  // "Device or resource busy" rather than EROFS — this is the denial shape
  // of tools that write via a lock+rename protocol (e.g. `git config`
  // against a ro-bound `.git/config`), i.e. exactly the guard's
  // mountpoint-replacement class. False positives (genuinely busy devices)
  // cost one extra escalation prompt — the fail-safe direction.
  'device or resource busy',
];

/** Shell-level failures that are never sandbox denials on their own. */
const QUICK_REJECT_EXIT_CODES: ReadonlySet<number> = new Set([2, 126, 127]);

const EXIT_CODE_SIGNAL_BASE = 128;
const SIGSYS = 31;

/**
 * Returns whether a failed command was likely denied by the sandbox.
 * False positives are acceptable: the worst outcome is one extra
 * escalation approval prompt (fail-safe direction).
 */
export function isLikelySandboxDenied(output: SandboxDenialOutput): boolean {
  if (output.exitCode === 0) return false;

  const hasSandboxKeyword = [output.stderr, output.stdout, output.output].some(
    (section) =>
      section !== undefined &&
      SANDBOX_DENIED_KEYWORDS.some((needle) => section.toLowerCase().includes(needle)),
  );
  if (hasSandboxKeyword) return true;

  if (QUICK_REJECT_EXIT_CODES.has(output.exitCode)) return false;

  // Killed by SIGSYS (128 + 31). Retained from codex's seccomp path even
  // though the bubblewrap-only backend has no seccomp filter — a nested
  // sandbox or kernel-level filter can still produce it.
  if (output.exitCode === EXIT_CODE_SIGNAL_BASE + SIGSYS) return true;

  return false;
}
