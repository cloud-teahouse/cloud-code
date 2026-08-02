import { isCloudCodeError } from '@cloud-code/sdk';

import {
  RewindModeSelectorComponent,
  type RewindMode,
  type RewindModeChoice,
} from '../components/dialogs/rewind-mode-selector';
import { UndoSelectorComponent } from '../components/dialogs/undo-selector';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';
import {
  createUndoChoices,
  resolveUndoAvailability,
  undoByCount,
} from './undo';

// ---------------------------------------------------------------------------
// Rewind command
//
// /rewind rolls the session back to a previous user-prompt anchor in up to
// two independent parts: the conversation (the existing /undo path) and the
// workspace files (shadow-git baseline checkout via the rewindFiles RPC).
// The anchor model, availability probe, and selector component are shared
// with /undo; this command adds the mode pick on top.
// ---------------------------------------------------------------------------

const REWIND_STATUS_TURN_ID = 'rewind-status';

export async function handleRewindCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError(t('commands.rewind.busyStreaming'));
    return;
  }

  const trimmed = args.trim();
  if (trimmed.length === 0) {
    await showRewindSelector(host);
    return;
  }

  const parsed = parseRewindArgs(trimmed);
  if (parsed === undefined) {
    host.showError(t('commands.rewind.usage'));
    return;
  }

  await rewindByCount(host, parsed.count, parsed.mode);
}

function parseRewindArgs(args: string): { count: number; mode: RewindMode } | undefined {
  const match = /^([1-9]\d*)(?:\s+(code|conversation|both))?$/.exec(args);
  if (match === null) return undefined;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count)) return undefined;
  const mode = (match[2] ?? 'both') as RewindMode;
  return { count, mode };
}

async function showRewindSelector(host: SlashCommandHost): Promise<void> {
  if (host.session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const availability = await resolveUndoAvailability(host);
  const choices = createUndoChoices(
    host.state.transcriptEntries,
    host.state.transcriptContainer.children,
    availability.maxCount,
  );
  if (choices.length === 0) {
    showRewindStatus(
      host,
      availability.stoppedAtCompaction
        ? t('commands.rewind.nothingAfterCompaction')
        : t('commands.rewind.nothing'),
    );
    return;
  }

  const editorSlotHandle = host.mountEditorReplacement(
    new UndoSelectorComponent({
      choices,
      title: t('commands.rewind.selectorTitle'),
      onSelect: (choice) => {
        // Latch against a double Enter on the mode selector: it stays
        // mounted while rewindByCount awaits the rewind/undo RPCs, and a
        // re-entrant select would roll files back and truncate history
        // twice (same hazard as the /undo selector latch).
        let rewindInFlight = false;
        const modeSelectorHandle = host.mountEditorReplacement(
          new RewindModeSelectorComponent({
            onSelect: (modeChoice: RewindModeChoice) => {
              if (rewindInFlight) return;
              rewindInFlight = true;
              void rewindByCount(host, choice.count, modeChoice.mode, choice.input);
            },
            onCancel: () => {
              host.restoreEditor(modeSelectorHandle);
            },
          }),
          {
            onPreempt: () => {
              host.restoreEditor(modeSelectorHandle);
            },
          },
        );
      },
      onCancel: () => {
        host.restoreEditor(editorSlotHandle);
      },
    }),
    {
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
      },
    },
  );
}

/**
 * Execute a rewind. The two halves fail independently (Claude Code does the
 * same): a file-rollback failure never blocks the conversation truncation,
 * and vice versa.
 */
async function rewindByCount(
  host: SlashCommandHost,
  count: number,
  mode: RewindMode,
  input?: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  if (mode !== 'conversation') {
    await rewindFilesByCount(host, count);
  }

  if (mode !== 'code') {
    const undone = await undoByCount(host, count);
    if (undone && input !== undefined) {
      host.restoreInputText(input);
    }
  }
}

async function rewindFilesByCount(host: SlashCommandHost, count: number): Promise<boolean> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return false;
  }

  try {
    const result = await session.rewindFiles(count);
    showRewindStatus(
      host,
      t('commands.rewind.success', {
        files: formatFileCount(result.files.length),
        prompts: formatPromptCount(count),
      }),
    );
    return true;
  } catch (error) {
    const limit = rewindLimitFromError(error);
    if (limit !== undefined) {
      showRewindStatus(
        host,
        t('commands.rewind.limit', {
          requested: formatPromptCount(limit.requestedCount),
          rewindable: formatPromptCount(limit.rewindableCount),
        }),
      );
      return false;
    }
    host.showError(t('commands.rewind.filesFailed', { error: formatErrorMessage(error) }));
    return false;
  }
}

function rewindLimitFromError(
  error: unknown,
): { readonly requestedCount: number; readonly rewindableCount: number } | undefined {
  if (!isCloudCodeError(error)) return undefined;
  const details = error.details;
  if (details?.['reason'] !== 'rewind_limit') return undefined;
  const requestedCount = details['requestedCount'];
  const rewindableCount = details['rewindableCount'];
  if (typeof requestedCount !== 'number' || typeof rewindableCount !== 'number') {
    return undefined;
  }
  return { requestedCount, rewindableCount };
}

// Shares the /undo prompt-count plurals ('commands.undo.promptCount.*').
function formatPromptCount(count: number): string {
  return t(count === 1 ? 'commands.undo.promptCount.one' : 'commands.undo.promptCount.other', {
    count,
  });
}

function formatFileCount(count: number): string {
  return t(
    count === 1 ? 'commands.rewind.fileCount.one' : 'commands.rewind.fileCount.other',
    { count },
  );
}

function showRewindStatus(host: SlashCommandHost, message: string): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    turnId: REWIND_STATUS_TURN_ID,
    renderMode: 'plain',
    content: message,
  });
}
