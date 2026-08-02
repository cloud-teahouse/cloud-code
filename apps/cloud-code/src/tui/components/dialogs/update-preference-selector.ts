import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function updatePreferenceOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'on',
      label: t('selectors.update.on.label'),
      description: t('selectors.update.on.description'),
    },
    {
      value: 'off',
      label: t('selectors.update.off.label'),
      description: t('selectors.update.off.description'),
    },
  ];
}

export interface UpdatePreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class UpdatePreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: UpdatePreferenceSelectorOptions) {
    super({
      title: t('dialogs.settings.upgrade.label'),
      options: [...updatePreferenceOptions()],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
