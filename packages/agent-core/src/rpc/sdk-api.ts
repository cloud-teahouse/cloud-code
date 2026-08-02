import type { ContentPart } from '@cloud-code/kosong';

import type { PermissionMode } from '#/agent/permission/types';

import type { RPCMethods } from './client';
import type { AgentEvent, ToolInputDisplay } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
/**
 * `session` — remember the approval rule in memory for this session only.
 * `always` — persist the rule to the user config file (`permission.rules`,
 * scope `user`) so it permanently approves matching calls; on write failure
 * the approval degrades to `session`.
 */
export type ApprovalScope = 'session' | 'always';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
  /**
   * Optional permission-mode switch requested alongside the decision
   * (plan-review "approve and switch mode" variants). Applied by the
   * resolving policy only when the decision is 'approved'.
   */
  readonly mode?: PermissionMode | undefined;
}

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  /**
   * Leader permission bridge: present when the ask is routed from a
   * teammate through the leader's approval queue — the user sees WHO is
   * asking (CC's workerBadge equivalent). Absent for the leader's own asks.
   */
  readonly requester?: ApprovalRequester | undefined;
}

/** Identity of the teammate an approval request was bridged from. */
export interface ApprovalRequester {
  readonly name: string;
  readonly teamName?: string | undefined;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';
/**
 * Flattened answers keyed by question text; values are the chosen option
 * label(s) (comma-joined for multi-select) or free-form "Other" text.
 * `true` marks a question as answered without echoing a concrete value.
 */
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}

export interface SDKAgentAPI {
  emitEvent: (event: AgentEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  requestQuestion: (request: QuestionRequest) => Promise<QuestionResult>;
  toolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
}
export type SDKAgentRPC = RPCMethods<SDKAgentAPI>;

export type SDKSessionAPI = WithAgentId<SDKAgentAPI>;
export type SDKSessionRPC = RPCMethods<SDKSessionAPI>;

export type SDKAPI = WithSessionId<SDKSessionAPI>;
export type SDKRPC = RPCMethods<SDKAPI>;
