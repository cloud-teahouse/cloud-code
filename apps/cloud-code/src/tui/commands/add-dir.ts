import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

type AddDirChoice = 'session' | 'remember' | 'cancel';

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const session = host.session;

  if (input.length === 0 || input.toLowerCase() === 'list') {
    const additionalDirs = session?.summary?.additionalDirs ?? [];
    if (additionalDirs.length === 0) {
      host.showStatus(t('commands.add-dir.none'));
      return;
    }
    host.showStatus(formatAdditionalDirsStatus(additionalDirs));
    return;
  }

  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
    host.showStatus(t('commands.add-dir.notAdded', { path: input }));
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('commands.add-dir.title', { input }),
      hint: t('commands.add-dir.hint'),
      options: [
        {
          value: 'session',
          label: t('commands.add-dir.session'),
        },
        {
          value: 'remember',
          label: t('commands.add-dir.remember'),
        },
        {
          value: 'cancel',
          label: t('commands.add-dir.no'),
        },
      ],
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void handleAddDirChoice(host, session.id, input, value as AddDirChoice);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

function formatAdditionalDirsStatus(additionalDirs: readonly string[]): string {
  return [t('commands.add-dir.listHeader'), ...additionalDirs.map((dir) => `  ${dir}`)].join('\n');
}

async function handleAddDirChoice(
  host: SlashCommandHost,
  sessionId: string,
  path: string,
  choice: AddDirChoice,
): Promise<void> {
  if (choice === 'cancel') {
    host.showStatus(t('commands.add-dir.notAdded', { path }));
    return;
  }

  const session = host.session;
  if (session === undefined || session.id !== sessionId) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  try {
    const result = await session.addAdditionalDir(path, { persist: choice === 'remember' });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      choice === 'remember'
        ? t('commands.add-dir.addedPersist', { path, configPath: result.configPath })
        : t('commands.add-dir.addedSession', { path }),
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
