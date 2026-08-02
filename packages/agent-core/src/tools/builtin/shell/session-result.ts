/**
 * Shared tool-result rendering for the ExecSession / WriteStdin pair.
 *
 * Layout: a `key: value` metadata header, a blank line, then the drained
 * session output (head/tail truncated by the session buffer, then
 * line/char-capped here by ToolResultBuilder — the same treatment Bash
 * output gets). When the builder truncates, a `[Full output saved]`
 * reference points at the persisted `output.log` (F10), mirroring bash.ts.
 */

import type { ShellSessionManager, ShellSessionPollResult } from '../../../agent/shell-session';
import type { ExecutableToolResult } from '../../../loop/types';
import { ToolResultBuilder } from '../../support/result-builder';

/** Default `max_output_chars` — aligned with ToolResultBuilder's 50k default. */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export interface SessionPollRenderOptions {
  readonly maxOutputChars?: number | undefined;
  /** Extra header lines (e.g. WriteStdin's empty-poll guidance). */
  readonly extraMetaLines?: readonly string[];
  /**
   * When false, omit the TaskOutput hint from the truncation reference
   * (task tools are unavailable for this agent).
   */
  readonly allowBackground?: boolean;
}

export async function renderSessionPollResult(
  manager: ShellSessionManager,
  poll: ShellSessionPollResult,
  options: SessionPollRenderOptions = {},
): Promise<ExecutableToolResult> {
  const builder = new ToolResultBuilder({
    maxChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
  });
  builder.write(poll.output);

  const meta: string[] = [
    `session_id: ${poll.sessionId}`,
    `chunk_id: ${poll.chunkId}`,
    `status: ${poll.status}`,
  ];
  if (poll.exitCode !== null) meta.push(`exit_code: ${String(poll.exitCode)}`);
  meta.push(`wall_time_ms: ${String(poll.wallTimeMs)}`);
  if (poll.omittedBytes > 0) {
    meta.push(`omitted_bytes: ${String(poll.omittedBytes)}`);
  }
  if (poll.interrupted) {
    meta.push('interrupted: true (the wait was aborted; the session is still running)');
  }
  if (options.extraMetaLines !== undefined) meta.push(...options.extraMetaLines);

  const message =
    poll.exitCode !== null
      ? `Session ${poll.sessionId} exited with code ${String(poll.exitCode)}.`
      : poll.status === 'running'
        ? `Session ${poll.sessionId} is running.`
        : `Session ${poll.sessionId} exited.`;
  const rendered = builder.ok(message, { brief: message });
  let output = `${meta.join('\n')}\n\n${rendered.output}`;
  if (rendered.truncated) {
    output += await fullOutputReference(manager, poll.sessionId, options.allowBackground ?? true);
  }
  return {
    isError: false,
    output,
    message: rendered.message,
    truncated: rendered.truncated,
    structured: { taskId: poll.sessionId, status: poll.status },
  };
}

async function fullOutputReference(
  manager: ShellSessionManager,
  sessionId: string,
  allowBackground: boolean,
): Promise<string> {
  const snapshot = await manager.outputSnapshot(sessionId, 0);
  if (!snapshot.fullOutputAvailable || snapshot.outputPath === undefined) return '';
  const taskOutputHint = allowBackground
    ? `, or TaskOutput(task_id="${sessionId}", block=false)`
    : '';
  return (
    `\n\n[Full output saved]\n` +
    `task_id: ${sessionId}\n` +
    `output_path: ${snapshot.outputPath}\n` +
    `output_size_bytes: ${String(snapshot.outputSizeBytes)}\n` +
    `next_step: Use Read with output_path to page through the full log${taskOutputHint}.`
  );
}
