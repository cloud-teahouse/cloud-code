import { ErrorCodes, isCloudCodeError, type PermissionMode } from '@cloud-code/sdk';

import {
  GoalStartPermissionPromptComponent,
  type GoalStartPermissionChoice,
} from '../components/dialogs/goal-start-permission-prompt';
import {
  GoalQueueEditDialogComponent,
  GoalQueueManagerComponent,
  type GoalQueueEditResult,
  type GoalQueueManagerAction,
} from '../components/dialogs/goal-queue-manager';
import {
  GoalSetMessageComponent,
  GoalStatusMessageComponent,
  UpcomingGoalAddedMessageComponent,
} from '../components/messages/goal-panel';
import { LLM_NOT_SET_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  updateGoalQueueItem,
  type GoalQueueSnapshot,
} from '../goal-queue-store';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
// Sent to the model as a normal user input; kept in English deliberately since
// it is prompt content, not UI chrome.
const RESUME_GOAL_INPUT = 'Resume the active goal.';

type GoalCommandHost = Pick<
  SlashCommandHost,
  | 'state'
  | 'session'
  | 'requireSession'
  | 'setAppState'
  | 'showError'
  | 'showStatus'
  | 'mountEditorReplacement'
  | 'restoreEditor'
  | 'restoreInputText'
  | 'sendNormalUserInput'
>;

export interface GoalStartOptions {
  readonly beforeSend?: () => boolean | Promise<boolean>;
  readonly sendInput?: (objective: string) => void;
}

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
    }
  | { readonly kind: 'next-add'; readonly objective: string }
  | { readonly kind: 'next-manage' }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`status`/`replace`) are only honored as the first
 * token; use `/goal -- <objective>` to start a goal whose text begins with one
 * of those words. (`cancel` is the single discard action — it removes the
 * current goal.) Stop conditions are expressed in the objective in natural
 * language (e.g. "…or stop after 20 turns"); the model honors them when it
 * self-audits each turn and reports `complete`/`blocked` via UpdateGoal.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first === 'next') {
    return parseNextGoalCommand(tokens);
  }
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  // (e.g. `/goal -- pause the rollout`).
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    // A usage hint, not a failure — shown in the same calm style as the other
    // "nothing to act on" messages (no goal to pause/resume/cancel).
    return {
      kind: 'error',
      severity: 'hint',
      message: t('commands.goal.objectiveRequired'),
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: t('commands.goal.objectiveTooLong', { max: MAX_GOAL_OBJECTIVE_LENGTH }),
    };
  }
  return { kind: 'create', objective, replace };
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      return;
    case 'status':
      await showGoalStatus(host);
      return;
    case 'pause':
      await pauseGoal(host);
      return;
    case 'resume':
      await resumeGoal(host);
      return;
    case 'cancel':
      await cancelGoal(host);
      return;
    case 'next-add':
      await queueNextGoal(host, parsed);
      return;
    case 'next-manage':
      await showGoalQueueManager(host);
      return;
    case 'create':
      await createGoal(host, parsed, args);
      return;
  }
}

function parseNextGoalCommand(tokens: readonly string[]): ParsedGoalCommand {
  if (tokens.length === 2 && tokens[1] === 'manage') return { kind: 'next-manage' };
  let index = 1;
  if (tokens[index] === '--') index += 1;
  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message: t('commands.goal.nextObjectiveRequired'),
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: t('commands.goal.objectiveTooLong', { max: MAX_GOAL_OBJECTIVE_LENGTH }),
    };
  }
  return { kind: 'next-add', objective };
}

async function queueNextGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'next-add' }>,
): Promise<void> {
  const session = host.requireSession();
  let hasCurrentGoal: boolean;
  try {
    const { goal } = await session.getGoal();
    hasCurrentGoal = goal !== null;
  } catch (error) {
    host.showError(t('commands.goal.inspectFailed', { error: formatErrorMessage(error) }));
    return;
  }

  if (!hasCurrentGoal && !isBusy(host)) {
    host.showStatus(t('commands.goal.startNextNow'));
    await createGoal(
      host,
      { kind: 'create', objective: parsed.objective, replace: false },
      `next ${parsed.objective}`,
    );
    return;
  }

  try {
    await appendGoalQueueItem(session, { objective: parsed.objective });
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  if (!hasCurrentGoal) host.requestQueuedGoalPromotion?.();
  host.state.transcriptContainer.addChild(
    new UpcomingGoalAddedMessageComponent(),
  );
  host.state.ui.requestRender();
}

async function showGoalQueueManager(
  host: SlashCommandHost,
  selectedGoalId?: string,
): Promise<void> {
  let snapshot: GoalQueueSnapshot;
  try {
    snapshot = await readGoalQueue(host.requireSession());
  } catch (error) {
    host.showError(t('commands.goal.queueLoadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new GoalQueueManagerComponent({
      goals: snapshot.goals,
      selectedGoalId,
      onAction: async (action) => {
        try {
          return await handleGoalQueueManagerAction(host, action);
        } catch (error) {
          host.showError(
            t('commands.goal.queueUpdateFailed', { error: formatErrorMessage(error) }),
          );
          return undefined;
        }
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function handleGoalQueueManagerAction(
  host: SlashCommandHost,
  action: GoalQueueManagerAction,
): Promise<GoalQueueSnapshot | void> {
  const session = host.requireSession();
  switch (action.kind) {
    case 'move': {
      const snapshot = await moveGoalQueueItem(session, {
        goalId: action.goalId,
        direction: action.direction,
      });
      return snapshot;
    }
    case 'delete': {
      const snapshot = await removeGoalQueueItem(session, { goalId: action.goalId });
      return snapshot;
    }
    case 'edit':
      await showGoalQueueEditDialog(host, action.goalId);
      return;
  }
}

async function showGoalQueueEditDialog(
  host: SlashCommandHost,
  goalId: string,
): Promise<void> {
  let snapshot: GoalQueueSnapshot;
  try {
    snapshot = await readGoalQueue(host.requireSession());
  } catch (error) {
    host.showError(t('commands.goal.queueLoadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const goal = snapshot.goals.find((item) => item.id === goalId);
  if (goal === undefined) {
    host.showStatus(t('commands.goal.queueItemGone'));
    await showGoalQueueManager(host);
    return;
  }

  const editorSlotHandle = host.mountEditorReplacement(
    new GoalQueueEditDialogComponent({
      goal,
      onDone: (result) => {
        void handleGoalQueueEditResult(host, result).catch((error: unknown) => {
          host.showError(
            t('commands.goal.queueItemUpdateFailed', { error: formatErrorMessage(error) }),
          );
        });
      },
    }),
    // No cancel bookkeeping beyond the close itself: the edit dialog resolves
    // through onDone, and the follow-up manager remount supersedes this panel.
    { onPreempt: () => host.restoreEditor(editorSlotHandle) },
  );
}

async function handleGoalQueueEditResult(
  host: SlashCommandHost,
  result: GoalQueueEditResult,
): Promise<void> {
  if (result.kind === 'cancel') {
    await showGoalQueueManager(host, result.goalId);
    return;
  }

  await updateGoalQueueItem(host.requireSession(), {
    goalId: result.goalId,
    objective: result.objective,
  });
  await showGoalQueueManager(host, result.goalId);
}

export async function createGoal(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs?: string,
  options: GoalStartOptions = {},
): Promise<boolean> {
  // A goal must be able to start a model turn; refuse to create one otherwise.
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
    return false;
  }

  if (
    host.state.appState.permissionMode === 'manual' ||
    host.state.appState.permissionMode === 'yolo'
  ) {
    showGoalStartPermissionPrompt(host, parsed, rawArgs ?? parsed.objective, options);
    return false;
  }

  return startGoal(host, parsed, options);
}

function showGoalStartPermissionPrompt(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs: string,
  options: GoalStartOptions,
): void {
  const commandText = `/goal ${rawArgs.trim()}`;
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(t('commands.goal.notStarted'));
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new GoalStartPermissionPromptComponent({
      mode: host.state.appState.permissionMode === 'yolo' ? 'yolo' : 'manual',
      onSelect: (choice) => {
        if (choice === 'cancel') {
          cancelStart();
          return;
        }
        host.restoreEditor(editorSlotHandle);
        void startGoalWithPermission(host, parsed, choice, options);
      },
      onCancel: cancelStart,
    }),
    {
      // Not cancelStart: its restoreInputText force-restores the editor slot,
      // which would wipe the panel that is preempting this one. Keep only the
      // non-destructive bookkeeping (the handle restore no-ops on preempt).
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        host.showStatus(t('commands.goal.notStarted'));
      },
    },
  );
}

async function startGoalWithPermission(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  choice: GoalStartPermissionChoice,
  options: GoalStartOptions,
): Promise<void> {
  const previousMode = host.state.appState.permissionMode;
  const switched =
    choice !== previousMode && (choice === 'auto' || choice === 'yolo');
  if (switched) {
    if (!(await setPermissionForGoal(host, choice))) return;
  }
  const started = await startGoal(host, parsed, options);
  // The permission switch only exists to run this goal. If creation fails
  // (e.g. a goal already exists and `replace` was not given), restore the
  // previous mode so the session is not left more permissive than before.
  if (!started && switched) {
    await setPermissionForGoal(host, previousMode);
  }
}

async function setPermissionForGoal(host: GoalCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(t('commands.permission.failed', { error: formatErrorMessage(error) }));
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startGoal(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  options: GoalStartOptions,
): Promise<boolean> {
  try {
    await host.requireSession().createGoal({
      objective: parsed.objective,
      replace: parsed.replace,
    });
  } catch (error) {
    if (isCloudCodeError(error) && error.code === ErrorCodes.GOAL_ALREADY_EXISTS) {
      host.showError(t('commands.goal.alreadyActive'));
      return false;
    }
    host.showError(formatErrorMessage(error));
    return false;
  }
  if (options.beforeSend !== undefined && !(await options.beforeSend())) {
    return false;
  }
  host.state.transcriptContainer.addChild(new GoalSetMessageComponent());
  host.state.ui.requestRender();
  if (options.sendInput !== undefined) {
    options.sendInput(parsed.objective);
  } else {
    host.sendNormalUserInput(parsed.objective);
  }
  return true;
}

async function pauseGoal(host: SlashCommandHost): Promise<void> {
  const session = host.requireSession();
  try {
    await session.pauseGoal();
    if (isStreaming(host)) await session.cancel();
  } catch (error) {
    if (isCloudCodeError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus(t('commands.goal.noneToPause'));
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.showStatus(t('commands.goal.paused'));
}

async function resumeGoal(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
    return;
  }

  try {
    await host.requireSession().resumeGoal();
  } catch (error) {
    if (isCloudCodeError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus(t('commands.goal.noneToResume'));
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.sendNormalUserInput(RESUME_GOAL_INPUT);
}

async function cancelGoal(host: SlashCommandHost): Promise<void> {
  const session = host.requireSession();
  try {
    await session.cancelGoal();
    if (isStreaming(host)) await session.cancel();
  } catch (error) {
    if (isCloudCodeError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus(t('commands.goal.noneToCancel'));
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.showNotice(t('commands.goal.cancelled'));
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const { goal } = await host.requireSession().getGoal();
  if (goal === null) {
    host.showStatus(t('commands.goal.noneSet'));
    return;
  }
  host.state.transcriptContainer.addChild(
    new GoalStatusMessageComponent(goal),
  );
  host.state.ui.requestRender();
}

function isStreaming(host: SlashCommandHost): boolean {
  return host.state.appState.streamingPhase !== 'idle';
}

function isBusy(host: SlashCommandHost): boolean {
  return isStreaming(host) || host.state.appState.isCompacting;
}
