import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function fullscreenOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'on',
      label: t('selectors.fullscreen.on.label'),
      description: t('selectors.fullscreen.on.description'),
    },
    {
      value: 'off',
      label: t('selectors.fullscreen.off.label'),
      description: t('selectors.fullscreen.off.description'),
    },
  ];
}

export interface FullscreenSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class FullscreenSelectorComponent extends ChoicePickerComponent {
  constructor(opts: FullscreenSelectorOptions) {
    super({
      title: t('dialogs.settings.fullscreen.label'),
      options: [...fullscreenOptions()],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
