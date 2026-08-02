import type { PrepareToolExecutionResult, ResolvedToolExecutionHookContext } from '../../loop';
import type { ToolInputDisplay } from '../../tools/display';

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

/**
 * Rule provenance. `session-runtime` stores rules produced by
 * "approve for session"; `turn-override`, `project`, and `user` are
 * reserved for static-loaded rules surfaced by external callers.
 */
export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

/**
 * Top-level user-facing permission posture. Controls how non-deny rules
 * are treated when the closure is constructed. Independent of rule
 * merging: deny rules always fire regardless of mode.
 *
 *   - `manual` — rule set drives decision; unmatched tool calls ask
 *   - `yolo`   — only deny rules can block; everything else allows
 *   - `auto`   — caller may bypass rule checks entirely
 */
export type PermissionMode = 'manual' | 'yolo' | 'auto';

/**
 * A single permission rule. `pattern` is the DSL form (`Read(/etc/**)`,
 * `Bash(rm *)`, or bare `Write`). Rule arguments are interpreted only by
 * tools that provide a matcher; other tools match by name only.
 */
export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  action: string;
  display: ToolInputDisplay;
}

export interface ApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  /**
   * `session` — remember the approval rule in memory for this session only
   * (`session-runtime` scope). `always` — persist the rule to the user config
   * file (`permission.rules`, scope `user`) so it applies permanently; on
   * write failure the permission manager degrades the approval to `session`.
   */
  scope?: 'session' | 'always';
  feedback?: string;
  selectedLabel?: string;
  /**
   * Optional permission-mode switch requested alongside the decision
   * (plan-review "approve and switch mode" variants). Applied by the
   * resolving policy only when the decision is 'approved'.
   */
  mode?: PermissionMode;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  /**
   * All session-approval rules written by one approval. Present when the
   * tool decomposes a call into per-segment rules (e.g. compound Bash
   * commands); additive — old records carry only `sessionApprovalRule` and
   * replay unchanged, so no wire migration is needed.
   */
  readonly sessionApprovalRules?: readonly string[] | undefined;
  readonly result: ApprovalResponse;
}

export interface PermissionData {
  mode: PermissionMode;
  rules: PermissionRule[];
}

/**
 * Provenance of one session-scoped approval grant (C3 P5, design doc §3.4).
 * Replaces the flat pattern-string storage: the pattern stays the lookup
 * key, the metadata records which tool was approved, at which turn, and
 * through which approval surface. Grants never expire and carry no
 * risk-tier matching semantics (explicitly out of scope, design doc §3.4).
 */
export interface SessionApprovalGrant {
  /** Rule pattern string; also the storage key. */
  readonly pattern: string;
  /** Tool the approval was granted for (already on the record). */
  readonly toolName: string;
  /** Turn the approval was granted at (already on the record). */
  readonly grantedAtTurnId: number;
  /** Approval surface that issued the grant. */
  readonly surface: 'tool-approval' | 'git-mutation-gate';
}

export type PermissionDecision = 'approve' | 'deny' | 'ask';

export type PermissionReasonValue = string | number | boolean | null;

export type PermissionDecisionReason = Readonly<Record<string, PermissionReasonValue>>;

export type PermissionPolicyResolution =
  | PermissionPolicyResult
  | ({ readonly kind: 'result' } & PrepareToolExecutionResult);

export interface PermissionPolicyContext extends ResolvedToolExecutionHookContext {}

export type PermissionPolicyResult =
  | {
      readonly kind: 'approve';
      readonly reason?: PermissionDecisionReason;
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: 'deny';
      readonly reason?: PermissionDecisionReason;
      readonly message?: string;
    }
  | {
      readonly kind: 'ask';
      readonly reason?: PermissionDecisionReason;
      /**
       * Approval-prompt text override (additive, C3 P3). Absent → the
       * permission manager derives the prompt from the execution's
       * description, as before. Policies that know WHY the call is being
       * asked about (e.g. the git mutation gate's risk class) supply a
       * graded line so the human sees the reason, not just the command.
       */
      readonly approvalAction?: string;
      readonly resolveApproval?: (
        result: ApprovalResponse,
      ) => PermissionPolicyResolution | undefined;
      readonly resolveError?: (error: unknown) => PermissionPolicyResolution | undefined;
    };

export interface PermissionPolicy {
  readonly name: string;
  /**
   * Returning a full `PermissionPolicyResolution` (rather than only a
   * decision) lets a policy pass loop-control payloads through — e.g. a
   * PreToolUse hook's `updatedArgs` rewrite via `{ kind: 'result' }`.
   */
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResolution | undefined | Promise<PermissionPolicyResolution | undefined>;
}
