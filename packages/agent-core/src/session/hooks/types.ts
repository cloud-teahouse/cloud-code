import type { ContentPart } from '@cloud-code/kosong';

export const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'TaskCreated',
  'TaskCompleted',
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export interface HookDef {
  readonly event: HookEventType;
  readonly matcher?: string;
  /**
   * Optional permission-rule-syntax condition (e.g. `Bash(git *)`) evaluated
   * against the tool call before spawning the hook process. A hook whose
   * condition does not match is skipped without spawning anything. Conditions
   * carrying an argument pattern (`Bash(git *)` vs bare `Bash`) can only be
   * evaluated when the trigger supplies a rule matcher — see
   * {@link HookIfConditionContext}.
   */
  readonly if?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type HookPermissionDecision = 'allow' | 'deny' | 'ask';

export interface HookResult {
  readonly action: 'allow' | 'block';
  readonly message?: string;
  readonly reason?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
  /**
   * Structured `hookSpecificOutput.permissionDecision`. `deny` is also
   * reflected as `action: 'block'` for backward compatibility; `ask` means
   * the hook escalates the call to human approval instead of deciding itself.
   */
  readonly permissionDecision?: HookPermissionDecision;
  /** Structured `hookSpecificOutput.updatedInput` (PreToolUse): replacement tool input for this call. */
  readonly updatedInput?: Record<string, unknown>;
  /** Structured `hookSpecificOutput.additionalContext`: text the host feeds back to the model. */
  readonly additionalContext?: string;
}

export interface HookBlockDecision {
  readonly block: true;
  readonly reason: string;
}

export type HookMatcherValue = string | readonly ContentPart[];

/**
 * Tool-call context used to evaluate hook `if` conditions without spawning
 * the hook process. `execution` mirrors the permission-chain matchers of a
 * resolved tool execution; when absent (e.g. PostToolUse, where the execution
 * is no longer retained), conditions with an argument pattern cannot match —
 * the hook is skipped rather than spawned on a guess.
 */
export interface HookIfConditionContext {
  readonly toolName: string;
  readonly execution?: {
    readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
    readonly ruleToolName?: string | undefined;
    readonly ruleMatch?:
      | {
          readonly subjects: readonly string[];
          matches(ruleArgs: string, subject: string): boolean;
        }
      | undefined;
  };
}

export interface HookEngineTriggerArgs {
  readonly matcherValue?: HookMatcherValue;
  readonly inputData?: Record<string, unknown>;
  readonly ifContext?: HookIfConditionContext;
  readonly signal?: AbortSignal;
}

export type HookTriggeredCallback = (event: string, target: string, count: number) => void;

export type HookResolvedCallback = (
  event: string,
  target: string,
  action: string,
  reason: string | undefined,
  durationMs: number,
) => void;

export interface HookEngineOptions {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly onTriggered?: HookTriggeredCallback;
  readonly onResolved?: HookResolvedCallback;
}
