import type { CloudCodeConfig } from '@cloud-code/sdk';

import { currentTheme, lightColors } from '#/tui/theme';
import { loadTuiConfig, type TuiConfig } from '../config';
import { t } from '../i18n';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  await applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus(t('commands.reload.tuiDone'), 'success');
}

export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  const session = host.session;

  if (session !== undefined) {
    await session.reloadSession({ forcePluginSessionStartReminder: true });
    await host.reloadCurrentSessionView(session, t('commands.reload.sessionDone'));
  }

  const config = await host.harness.getConfig({ reload: true });
  setExperimentalFeatures(await host.harness.getExperimentalFeatures());
  host.refreshSlashCommandAutocomplete();
  applyRuntimeConfig(host, config);
  await applyReloadedTuiConfig(host, tuiConfig);

  if (session === undefined) {
    host.showStatus(t('commands.reload.noSession'), 'success');
  }
}

export async function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): Promise<void> {
  const resolved = config.theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    disablePasteBurst: config.disablePasteBurst,
    fullscreen: config.fullscreen,
    notifications: config.notifications,
    upgrade: config.upgrade,
    statusLine: config.statusLine,
  });
  // Live-switch the rendering mode (setFullscreen handles alt-screen enter/exit).
  host.state.ui.setFullscreen(config.fullscreen);
  host.state.editor.setDisablePasteBurst(config.disablePasteBurst);
  // Enable/disable first so the mirrored AppState.vimMode reads the mode the
  // editor actually settled into (setVimEnabled(true) starts in INSERT).
  host.state.editor.setVimEnabled(config.vimMode);
  host.setAppState({ vimMode: config.vimMode ? host.state.editor.getVimMode() : null });
}

function applyRuntimeConfig(host: SlashCommandHost, config: CloudCodeConfig): void {
  host.setAppState({
    availableModels: config.models ?? {},
    availableProviders: config.providers ?? {},
  });
}
