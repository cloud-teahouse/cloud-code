/**
 * Per-tool shapes for the `structured` channel of a tool result
 * (`ToolResultStructured`, see display.ts). The wire field itself stays a
 * loose JSON record so any tool can attach facts without a protocol
 * change; these schemas are the shared contract between the tool that
 * produces a payload and the client that would otherwise parse the
 * English output text. Producers build them typed; consumers `safeParse`
 * and fall back to parsing the raw output when validation fails (results
 * recorded before the tool emitted the payload, or version skew).
 */

import { z } from 'zod';

import { goalReasonCodeSchema } from './events';

/**
 * ExitPlanMode outcome, attached to every approval/rejection result. The
 * TUI previously recovered these facts from literal output markers
 * ('Exited plan mode.', '## Approved Plan:', 'Plan saved to: <path>',
 * 'User rejected the plan. Feedback:', …); old transcripts still parse
 * that way.
 *   - `approved` / `auto_approved`: plan mode exited; `auto_approved`
 *     means auto permission mode skipped user review.
 *   - `rejected`: the user rejected the plan (with `feedback` when given);
 *     plan mode may or may not still be active — the output text says.
 *   - `revise_requested`: the user asked for revisions without feedback.
 *   - `dismissed`: the approval prompt was cancelled; nothing changed.
 */
export const exitPlanModeStructuredSchema = z.object({
  outcome: z.enum(['approved', 'auto_approved', 'rejected', 'revise_requested', 'dismissed']),
  path: z.string().optional(),
  chosen: z.string().optional(),
  feedback: z.string().optional(),
});
export type ExitPlanModeStructured = z.infer<typeof exitPlanModeStructuredSchema>;

/**
 * Agent tool envelope, attached to background-launch and foreground
 * results. Clients previously recovered `agent_id` (background-task
 * routing) and the status from the `key: value` output lines.
 * `errorKind` classifies failed results so clients can tell a deliberate
 * user interruption from a fault without matching the English sentence.
 */
export const agentResultStructuredSchema = z.object({
  status: z.enum(['running', 'completed', 'failed']),
  agentId: z.string(),
  subagentType: z.string(),
  taskId: z.string().optional(),
  teammate: z.string().optional(),
  team: z.string().optional(),
  errorKind: z.enum(['user_cancelled', 'timeout', 'stopped']).optional(),
});
export type AgentResultStructured = z.infer<typeof agentResultStructuredSchema>;

/**
 * AgentSwarm result envelope: the summary counts and per-member outcomes
 * (positional, in `<subagent>` tag order). Member *text* is deliberately
 * not duplicated here — it is the subagents' own content and stays in the
 * XML bodies. `errorKind` is set instead of counts/members when the whole
 * swarm call failed (e.g. the user aborted the batch); clients previously
 * matched the English cancellation sentence.
 */
export const agentSwarmMemberStructuredSchema = z.object({
  outcome: z.enum(['completed', 'failed', 'aborted']),
  agentId: z.string().optional(),
  item: z.string().optional(),
  mode: z.literal('resume').optional(),
  state: z.enum(['started', 'not_started']).optional(),
});
export type AgentSwarmMemberStructured = z.infer<typeof agentSwarmMemberStructuredSchema>;

export const agentSwarmResultStructuredSchema = z.object({
  completed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  aborted: z.number().int().nonnegative().optional(),
  members: z.array(agentSwarmMemberStructuredSchema).optional(),
  errorKind: z.enum(['user_cancelled', 'error']).optional(),
});
export type AgentSwarmResultStructured = z.infer<typeof agentSwarmResultStructuredSchema>;

/**
 * Background-task envelope carried by results that start or report a
 * background task (Bash Ctrl+B detach, ExecSession, TaskStop, background
 * AskUserQuestion). agent-core's shell-command path previously sniffed the
 * `task_id: ` output prefix; `backgrounded: true` marks the results where
 * the call detached to background (as opposed to results that merely
 * mention a task id).
 */
export const backgroundTaskStructuredSchema = z.object({
  taskId: z.string(),
  backgrounded: z.literal(true).optional(),
  status: z.string().optional(),
});
export type BackgroundTaskStructured = z.infer<typeof backgroundTaskStructuredSchema>;

/**
 * AskUserQuestion outcome. Foreground results carry the collected
 * `answers` map (keyed by question text) and an optional `note` (e.g. the
 * dismissal notice) — clients previously JSON-parsed the raw output.
 * Background results carry the started task's envelope.
 */
export const askUserQuestionStructuredSchema = z.object({
  answers: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
  taskId: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
});
export type AskUserQuestionStructured = z.infer<typeof askUserQuestionStructuredSchema>;

/**
 * ReadMediaFile delivery facts: what kind of media was delivered, from
 * which path, and how (inline data URL vs hosted URL). Clients previously
 * regex-parsed the `<image path="...">` tag and the data URL out of the
 * serialized content parts.
 */
export const readMediaFileStructuredSchema = z.object({
  mediaKind: z.enum(['image', 'video']),
  path: z.string(),
  mimeType: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
});
export type ReadMediaFileStructured = z.infer<typeof readMediaFileStructuredSchema>;

/**
 * Goal snapshot facts carried by CreateGoal/GetGoal results. The JSON
 * envelope in the output stays the model-facing form; clients read these
 * fields (falling back to parsing that JSON) so they can localize the
 * status and the runtime-authored terminal reason.
 */
export const goalSnapshotStructuredSchema = z.object({
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  terminalReason: z.string().optional(),
  terminalReasonCode: goalReasonCodeSchema.optional(),
  terminalReasonDetail: z.string().optional(),
});
export type GoalSnapshotStructured = z.infer<typeof goalSnapshotStructuredSchema>;
