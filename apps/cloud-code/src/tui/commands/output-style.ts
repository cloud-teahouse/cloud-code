import { t } from '#/tui/i18n';
import type { Session } from '@cloud-code/sdk';

import {
  DEFAULT_OUTPUT_STYLE_VALUE,
  OutputStyleSelectorComponent,
} from '../components/dialogs/output-style-selector';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/output-style [name]` — select the session's output style (the pluggable
 * replacement for the system prompt's style surface). No args opens the
 * picker; a name applies directly. The choice is live-applied to the session
 * (one-time prompt re-render) and persisted to config (`output_style`).
 */
export async function handleOutputStyleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.requireSession();
  const name = args.trim();
  if (name.length === 0) {
    await showOutputStylePicker(host, session);
    return;
  }
  await applyOutputStyleChoice(host, session, name);
}

async function showOutputStylePicker(host: SlashCommandHost, session: Session): Promise<void> {
  const styles = await session.listOutputStyles();
  const current = await currentOutputStyle(host);
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new OutputStyleSelectorComponent({
      styles,
      currentValue: current,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyOutputStyleChoice(host, session, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function applyOutputStyleChoice(
  host: SlashCommandHost,
  session: Session,
  name: string,
): Promise<void> {
  if (name !== DEFAULT_OUTPUT_STYLE_VALUE) {
    const styles = await session.listOutputStyles();
    if (!styles.some((style) => style.name === name)) {
      host.showError(t('commands.outputStyle.unknown', { name }));
      return;
    }
  }
  if (name === (await currentOutputStyle(host))) {
    host.showStatus(t('commands.outputStyle.unchanged', { name }));
    return;
  }
  try {
    await session.setOutputStyle(name);
    await host.harness.setConfig({ outputStyle: name });
  } catch (error) {
    host.showError(t('commands.outputStyle.saveFailed', { error: formatErrorMessage(error) }));
    return;
  }
  host.showStatus(t('commands.outputStyle.set', { name }));
}

/** The persisted active style, `default` when unset. */
async function currentOutputStyle(host: SlashCommandHost): Promise<string> {
  const configured = (await host.harness.getConfig()).outputStyle?.trim();
  return configured === undefined || configured.length === 0
    ? DEFAULT_OUTPUT_STYLE_VALUE
    : configured;
}
