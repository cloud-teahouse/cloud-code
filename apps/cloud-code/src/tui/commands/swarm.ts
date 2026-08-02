import type { PermissionMode } from '@cloud-code/sdk';

import {
  SwarmStartPermissionPromptComponent,
  type SwarmStartPermissionChoice,
} from '../components/dialogs/swarm-start-permission-prompt';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleSwarmCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const prompt = args.trim();
  const mode = swarmModeSubcommand(prompt);
  if (mode !== undefined) {
    await applySwarmMode(host, mode, `/swarm ${prompt}`);
    return;
  }

  if (prompt.length === 0) {
    await applySwarmMode(host, !host.state.appState.swarmMode, '/swarm');
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(
      host,
      `/swarm ${prompt}`,
      t('swarm.command.taskNotStarted'),
      (choice) => startSwarmWithPermission(host, prompt, choice),
    );
    return;
  }

  await startSwarmTask(host, prompt);
}

function showSwarmStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: SwarmStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new SwarmStartPermissionPromptComponent({
      onSelect: (choice) => {
        host.restoreEditor(editorSlotHandle);
        void onSelect(choice);
      },
      onCancel: cancelStart,
    }),
    {
      // Not cancelStart: its restoreInputText force-restores the editor slot,
      // which would wipe the panel that is preempting this one. Keep only the
      // non-destructive bookkeeping (the handle restore no-ops on preempt).
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        host.showStatus(cancelStatus);
      },
    },
  );
}

async function startSwarmWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: SwarmStartPermissionChoice,
): Promise<void> {
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForSwarm(host, choice))) return;
  }
  await startSwarmTask(host, prompt);
}

async function setPermissionForSwarm(host: SlashCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(t('commands.permission.failed', { error: formatErrorMessage(error) }));
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startSwarmTask(host: SlashCommandHost, prompt: string): Promise<void> {
  if (!host.state.appState.swarmMode && !(await setSwarmMode(host, true, 'task'))) {
    return;
  }
  renderSwarmModeMarker(host, 'active');
  host.sendNormalUserInput(prompt);
}

async function applySwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.swarmMode) {
    host.showStatus(t('swarm.command.alreadyOn'));
    return;
  }
  if (!enabled && !host.state.appState.swarmMode) {
    host.showStatus(t('swarm.command.alreadyOff'));
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(
      host,
      commandText,
      t('swarm.command.notEnabled'),
      async (choice) => {
        if ((choice === 'auto' || choice === 'yolo') && !(await setPermissionForSwarm(host, choice))) {
          return;
        }
        if (!(await setSwarmMode(host, true, 'manual'))) return;
        renderSwarmModeMarker(host, 'active');
      },
    );
    return;
  }
  if (!(await setSwarmMode(host, enabled, 'manual'))) return;
  renderSwarmModeMarker(host, enabled ? 'active' : 'inactive');
}

async function setSwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: 'manual' | 'task',
): Promise<boolean> {
  try {
    await host.requireSession().setSwarmMode(enabled, trigger);
  } catch (error) {
    host.showError(
      t(enabled ? 'swarm.command.enableFailed' : 'swarm.command.disableFailed', {
        error: formatErrorMessage(error),
      }),
    );
    return false;
  }
  host.setAppState({ swarmMode: enabled });
  host.state.swarmModeEntry = enabled ? trigger : undefined;
  return true;
}

function swarmModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderSwarmModeMarker(host: SlashCommandHost, state: SwarmModeMarkerState): void {
  host.state.transcriptContainer.addChild(
    new SwarmModeMarkerComponent(state),
  );
  host.state.ui.requestRender();
}
