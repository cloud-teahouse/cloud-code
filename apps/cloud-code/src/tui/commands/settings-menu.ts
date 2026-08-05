/**
 * /settings menu — the selector and its sub-flow dispatch. Lives in its own
 * module because it imports from both config.ts (the sub-pickers) and
 * provider.ts (the provider manager), which already imports config.ts: keeping
 * the menu here avoids a static import cycle between the two command modules.
 */

import {
  SettingsSelectorComponent,
  type SettingsSelection,
} from '../components/dialogs/settings-selector';
import type { SlashCommandHost } from './dispatch';
import {
  showEditorPicker,
  showExperimentsPanel,
  showFullscreenPicker,
  showLanguagePicker,
  showModelPicker,
  showPermissionPicker,
  showThemePicker,
  showUpdatePreferencePicker,
} from './config';
import { showUsage } from './info';
import { handleProviderCommand } from './provider';

export function showSettingsSelector(host: SlashCommandHost): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        handleSettingsSelection(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  // Sub-pickers opened from /settings return to the settings menu on Esc
  // instead of dropping straight back to the editor.
  const backToSettings = (): void => {
    showSettingsSelector(host);
  };
  switch (value) {
    case 'model': showModelPicker(host, undefined, undefined, undefined, backToSettings); return;
    case 'provider': void handleProviderCommand(host, backToSettings); return;
    case 'permission': showPermissionPicker(host, backToSettings); return;
    case 'theme': showThemePicker(host, backToSettings); return;
    case 'language': showLanguagePicker(host, backToSettings); return;
    case 'editor': showEditorPicker(host, backToSettings); return;
    case 'fullscreen': showFullscreenPicker(host, backToSettings); return;
    case 'experiments': void showExperimentsPanel(host, backToSettings); return;
    case 'upgrade': showUpdatePreferencePicker(host, backToSettings); return;
    case 'usage': void showUsage(host, backToSettings); return;
  }
}
