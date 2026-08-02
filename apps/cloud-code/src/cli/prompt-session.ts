/**
 * Minimal harness/session surface consumed by `cloud-code -p` (print mode).
 *
 * `run-prompt.ts` only needs a small subset of the SDK `CloudCodeHarness` / `Session`
 * API. Coding the print-mode driver against these narrow interfaces — instead of
 * the concrete SDK classes — keeps the driver runnable against an alternate
 * engine (e.g. the experimental agent-core-v2) that structurally satisfies them.
 * The v1 `CloudCodeHarness` / `Session` already do, so no adapter wrappers are
 * needed on the v1 path.
 */

import type {
  ApprovalHandler,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  Event,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  CloudCodeConfig,
  ListSessionsOptions,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  ResumeSessionInput,
  SessionStatus,
  SessionSummary,
  Unsubscribe,
} from '@cloud-code/sdk';

export interface PromptHarness {
  readonly homeDir: string;

  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<Pick<CloudCodeConfig, 'defaultModel'>>;
  getConfigDiagnostics(): Promise<ConfigDiagnostics>;
  listSessions(options: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  createSession(options: CreateSessionOptions): Promise<PromptSession>;
  resumeSession(input: ResumeSessionInput): Promise<PromptSession>;
  close(): Promise<void>;
}

export interface PromptSession {
  readonly id: string;
  readonly workDir: string;

  getStatus(): Promise<SessionStatus>;
  setModel(model: string): Promise<void>;
  setPermission(mode: PermissionMode): Promise<void>;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  onEvent(listener: (event: Event) => void): Unsubscribe;
  prompt(input: string | PromptInput): Promise<void>;
  waitForBackgroundTasksOnPrint(): Promise<void>;
  handlePrintMainTurnCompleted?(): Promise<'finish' | 'continue'>;
  createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalToolResult>;
  getCronTasks(): Promise<GetCronTasksResult>;
}
