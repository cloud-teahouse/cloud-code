import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { t, type MessageKey } from '#/tui/i18n';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'language'
  | 'editor'
  | 'fullscreen'
  | 'permission'
  | 'experiments'
  | 'upgrade'
  | 'usage';

// Module-level constants hold i18n keys; they resolve at construction so a
// freshly opened menu always reflects the active locale.
const SETTINGS_OPTIONS: readonly { value: SettingsSelection; labelKey: MessageKey; descriptionKey: MessageKey }[] = [
  {
    value: 'model',
    labelKey: 'dialogs.settings.model.label',
    descriptionKey: 'dialogs.settings.model.description',
  },
  {
    value: 'permission',
    labelKey: 'dialogs.settings.permission.label',
    descriptionKey: 'dialogs.settings.permission.description',
  },
  {
    value: 'theme',
    labelKey: 'dialogs.settings.theme.label',
    descriptionKey: 'dialogs.settings.theme.description',
  },
  {
    value: 'language',
    labelKey: 'dialogs.settings.language.label',
    descriptionKey: 'dialogs.settings.language.description',
  },
  {
    value: 'editor',
    labelKey: 'dialogs.settings.editor.label',
    descriptionKey: 'dialogs.settings.editor.description',
  },
  {
    value: 'fullscreen',
    labelKey: 'dialogs.settings.fullscreen.label',
    descriptionKey: 'dialogs.settings.fullscreen.description',
  },
  {
    value: 'experiments',
    labelKey: 'dialogs.settings.experiments.label',
    descriptionKey: 'dialogs.settings.experiments.description',
  },
  {
    value: 'upgrade',
    labelKey: 'dialogs.settings.upgrade.label',
    descriptionKey: 'dialogs.settings.upgrade.description',
  },
  {
    value: 'usage',
    labelKey: 'dialogs.settings.usage.label',
    descriptionKey: 'dialogs.settings.usage.description',
  },
];

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'theme' ||
    value === 'language' ||
    value === 'editor' ||
    value === 'fullscreen' ||
    value === 'permission' ||
    value === 'experiments' ||
    value === 'upgrade' ||
    value === 'usage'
  );
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    const options: ChoiceOption[] = SETTINGS_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
      description: t(option.descriptionKey),
    }));
    super({
      title: t('dialogs.settings.title'),
      options,
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
