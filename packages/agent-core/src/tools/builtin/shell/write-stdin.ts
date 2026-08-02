/**
 * WriteStdinTool — write to / poll a persistent ExecSession shell session.
 *
 * codex `write_stdin` parity (RFC `docs/rfc/unified-exec-pty.md` §3.1/§3.4):
 * this is a *transport* for an already-approved session — it deliberately
 * does NOT re-run the permission chain (no tree-sitter, no policy review):
 *   - `chars` is a raw terminal byte stream (half-lines, REPL syntax,
 *     control characters, passwords) that shell parsing cannot judge;
 *   - the session's initial command was reviewed at ExecSession creation;
 *     approval of a session trusts that program's later input, the same
 *     exposure as a one-shot `python -c`.
 * The default-approve / Guardian-exempt wiring lives in
 * `agent/permission/policies/default-tool-approve.ts` and
 * `guardian-review.ts`.
 */

import { z } from 'zod';

import type { ShellSessionManager } from '../../../agent/shell-session';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import { renderSessionPollResult } from './session-result';
import writeStdinDescription from './write-stdin.md?raw';

export const WRITE_STDIN_TOOL_NAME = 'WriteStdin' as const;

/** codex clamp: write default 250ms / max 30s; poll default 5s / range 5s–300s. */
const DEFAULT_WRITE_YIELD_MS = 250;
const MAX_WRITE_YIELD_MS = 30_000;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MIN_POLL_YIELD_MS = 5_000;
const MAX_POLL_YIELD_MS = 300_000;

/**
 * After this many consecutive polls with zero output (process still
 * running), the result nudges the model to stop burning turns on an
 * idle/stuck session (RFC risk table: 刷屏轮询烧轮次).
 */
const EMPTY_POLL_GUIDANCE_THRESHOLD = 5;

export const WriteStdinInputSchema = z
  .object({
    session_id: z.string().min(1).describe('The session id returned by ExecSession.'),
    chars: z
      .string()
      .default('')
      .describe(
        'Bytes written to the session stdin verbatim (control characters allowed: "\\u0003" = Ctrl-C, "\\u0004" = Ctrl-D EOF, "\\n" submits a line). Empty = poll only.',
      )
      .optional(),
    yield_time_ms: z
      .number()
      .int()
      .positive()
      .describe(
        `How long to wait for output, in milliseconds. After a write: default ${String(DEFAULT_WRITE_YIELD_MS)}, max ${String(MAX_WRITE_YIELD_MS)}. Pure poll (empty chars): default ${String(DEFAULT_POLL_YIELD_MS)}, range ${String(MIN_POLL_YIELD_MS)}–${String(MAX_POLL_YIELD_MS)}.`,
      )
      .optional(),
    max_output_chars: z
      .number()
      .int()
      .positive()
      .describe(
        'Maximum characters of session output to include in this result. The full log is always written to output_path.',
      )
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.yield_time_ms === undefined) return;
    const isPoll = val.chars === undefined || val.chars.length === 0;
    const [min, max, label] = isPoll
      ? [MIN_POLL_YIELD_MS, MAX_POLL_YIELD_MS, 'poll']
      : [1, MAX_WRITE_YIELD_MS, 'write'];
    if (val.yield_time_ms < min || val.yield_time_ms > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['yield_time_ms'],
        message: `yield_time_ms must be ${String(min)}–${String(max)}ms for a ${label}`,
      });
    }
  });

export type WriteStdinInput = z.Infer<typeof WriteStdinInputSchema>;

export class WriteStdinTool implements BuiltinTool<WriteStdinInput> {
  readonly name = WRITE_STDIN_TOOL_NAME;
  readonly description: string = writeStdinDescription;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteStdinInputSchema);

  constructor(
    private readonly shellSessions: ShellSessionManager,
    private readonly options?: { readonly allowBackground?: boolean | undefined },
  ) {}

  resolveExecution(args: WriteStdinInput): ToolExecution {
    const writing = args.chars !== undefined && args.chars.length > 0;
    return {
      description: writing
        ? `Writing to session ${args.session_id}`
        : `Polling session ${args.session_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.session_id),
      execute: ({ signal }) => this.execute(args, signal),
    };
  }

  private async execute(args: WriteStdinInput, signal: AbortSignal): Promise<ExecutableToolResult> {
    const chars = args.chars ?? '';
    const yieldMs = normalizeYield(chars, args.yield_time_ms);
    let poll;
    try {
      poll = await this.shellSessions.interact(args.session_id, { chars, yieldMs, signal });
    } catch (error) {
      // Unknown/dead session id (e.g. after resume): the manager's message
      // already explains how to rebuild via ExecSession.
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    return renderSessionPollResult(this.shellSessions, poll, {
      maxOutputChars: args.max_output_chars,
      extraMetaLines: emptyPollGuidance(poll.consecutiveEmptyPolls),
      allowBackground: this.options?.allowBackground ?? true,
    });
  }
}

function normalizeYield(chars: string, yieldTimeMs: number | undefined): number {
  const isPoll = chars.length === 0;
  if (yieldTimeMs === undefined) return isPoll ? DEFAULT_POLL_YIELD_MS : DEFAULT_WRITE_YIELD_MS;
  if (isPoll) return Math.min(Math.max(yieldTimeMs, MIN_POLL_YIELD_MS), MAX_POLL_YIELD_MS);
  return Math.min(Math.max(yieldTimeMs, 1), MAX_WRITE_YIELD_MS);
}

function emptyPollGuidance(consecutiveEmptyPolls: number): readonly string[] | undefined {
  if (consecutiveEmptyPolls < EMPTY_POLL_GUIDANCE_THRESHOLD) return undefined;
  return [
    `guidance: no output for ${String(consecutiveEmptyPolls)} consecutive polls and the process is ` +
      'still running. It may be idle, stuck, or waiting for input — consider writing to it, ' +
      'sending Ctrl-C (chars="\\u0003"), or doing other work before polling again.',
  ];
}
