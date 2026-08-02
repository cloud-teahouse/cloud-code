import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@cloud-code/agent-core';

// Event union plus shared fields/payloads used across event families.
export type { CloudCodeErrorPayload, Event } from '@cloud-code/agent-core';

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@cloud-code/agent-core';

export {
  agentResultStructuredSchema,
  agentSwarmResultStructuredSchema,
  askUserQuestionStructuredSchema,
  backgroundTaskStructuredSchema,
  exitPlanModeStructuredSchema,
  goalSnapshotStructuredSchema,
  readMediaFileStructuredSchema,
} from '@cloud-code/agent-core';

// Session lifecycle/status events and their status payload.
export type {
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  GoalReasonCode,
  GoalUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ErrorEvent,
  WarningEvent,
  UsageStatus,
} from '@cloud-code/agent-core';

// Turn and step lifecycle events plus the turn-ending reason enum.
export type {
  TurnStartedEvent,
  TurnEndedEvent,
  TurnStepStartedEvent,
  TurnStepCompletedEvent,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
  TurnRateLimitPausedEvent,
  TurnRateLimitResumingEvent,
  TurnEndReason,
} from '@cloud-code/agent-core';

// Streaming content and hook-result events.
export type {
  AssistantDeltaEvent,
  HookResultEvent,
  ThinkingDeltaEvent,
} from '@cloud-code/agent-core';

// Tool-call events and incremental progress payloads.
export type {
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ToolResultDisplayRef,
  ToolResultStructured,
  ToolCallRequest,
  ToolCallResponse,
  ToolUpdate,
  McpOAuthAuthorizationUrlUpdateData,
} from '@cloud-code/agent-core';

// MCP tool-list and server status events.
export type {
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
  McpServerStatusEvent,
  McpServerStatusPayload,
} from '@cloud-code/agent-core';

// Approval reverse-RPC request and response/display payloads.
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalScope,
  ApprovalResponse,
  ToolInputDisplay,
} from '@cloud-code/agent-core';

// Question reverse-RPC request and answer payloads.
export type {
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
} from '@cloud-code/agent-core';

// Subagent lifecycle events.
export type {
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
} from '@cloud-code/agent-core';

// Team snapshots and mailbox activity (read-only swarm views).
export type {
  TeamUpdatedEvent,
  MailboxActivityEvent,
  TeamWire,
  TeamTaskWire,
  TeamMemberWire,
  TeamTaskWireStatus,
  MailboxActivityMessage,
} from '@cloud-code/agent-core';

// Compaction lifecycle events and compaction result payload.
export type {
  CompactionStartedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionResult,
} from '@cloud-code/agent-core';

// Background task lifecycle events emitted by the BPM. Covers both
// bash (`bash-*`) and agent (`agent-*`) tasks under one wire format.
export type {
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
} from '@cloud-code/agent-core';

export type { CronFiredEvent } from '@cloud-code/agent-core';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
