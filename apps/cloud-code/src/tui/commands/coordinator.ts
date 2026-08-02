import type { PermissionMode } from '@cloud-code/sdk';

import {
  CoordinatorStartPermissionPromptComponent,
  type CoordinatorStartPermissionChoice,
} from '../components/dialogs/coordinator-start-permission-prompt';
import {
  CoordinatorModeMarkerComponent,
  type CoordinatorModeMarkerState,
} from '../components/messages/coordinator-markers';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/coordinator [on|off]` — toggle Coordinator Mode. With no
 * argument it flips the mode. Coordinator Mode is a session-level role
 * switch (the main thread orchestrates background workers), so unlike
 * `/swarm` there is no one-shot task variant.
 */
export async function handleCoordinatorCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const input = args.trim().toLowerCase();
  const mode = coordinatorModeSubcommand(input);
  const enabled = mode ?? !host.state.appState.coordinatorMode;
  if (mode === undefined && input.length > 0) {
    host.showStatus(t('coordinator.command.usage'));
    return;
  }
  await applyCoordinatorMode(host, enabled, `/coordinator${args.trim().length > 0 ? ` ${args.trim()}` : ''}`);
}

async function applyCoordinatorMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.coordinatorMode) {
    host.showStatus(t('coordinator.command.alreadyOn'));
    return;
  }
  if (!enabled && !host.state.appState.coordinatorMode) {
    host.showStatus(t('coordinator.command.alreadyOff'));
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showCoordinatorStartPermissionPrompt(host, commandText, async (choice) => {
      if ((choice === 'auto' || choice === 'yolo') && !(await setPermissionForCoordinator(host, choice))) {
        return;
      }
      if (!(await setCoordinatorMode(host, true))) return;
      renderCoordinatorModeMarker(host, 'active');
    });
    return;
  }
  if (!(await setCoordinatorMode(host, enabled))) return;
  renderCoordinatorModeMarker(host, enabled ? 'active' : 'inactive');
}

function showCoordinatorStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  onSelect: (choice: CoordinatorStartPermissionChoice) => Promise<void>,
): void {
  const cancelStatus = t('coordinator.command.notEnabled');
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new CoordinatorStartPermissionPromptComponent({
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

async function setPermissionForCoordinator(host: SlashCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(t('commands.permission.failed', { error: formatErrorMessage(error) }));
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function setCoordinatorMode(host: SlashCommandHost, enabled: boolean): Promise<boolean> {
  try {
    await host.requireSession().setCoordinatorMode(enabled);
  } catch (error) {
    host.showError(
      t(enabled ? 'coordinator.command.enableFailed' : 'coordinator.command.disableFailed', {
        error: formatErrorMessage(error),
      }),
    );
    return false;
  }
  host.setAppState({ coordinatorMode: enabled });
  return true;
}

function coordinatorModeSubcommand(input: string): boolean | undefined {
  if (input === 'on') return true;
  if (input === 'off') return false;
  return undefined;
}

function renderCoordinatorModeMarker(host: SlashCommandHost, state: CoordinatorModeMarkerState): void {
  host.state.transcriptContainer.addChild(
    new CoordinatorModeMarkerComponent(state),
  );
  host.state.ui.requestRender();
}
