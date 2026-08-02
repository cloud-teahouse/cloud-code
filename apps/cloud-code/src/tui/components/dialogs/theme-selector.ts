import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { t } from '#/tui/i18n';
import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import type { ThemeName } from '#/tui/theme/index';

export interface ThemeSelectorOptions {
  readonly currentValue: ThemeName;
  readonly onSelect: (theme: ThemeName) => void;
  readonly onCancel: () => void;
}

export class ThemeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThemeSelectorOptions) {
    const customThemes = listCustomThemesSync();
    const options: ChoiceOption[] = [
      { value: 'auto', label: t('dialogs.theme.auto') },
      { value: 'dark', label: t('dialogs.theme.dark') },
      { value: 'light', label: t('dialogs.theme.light') },
      ...customThemes.map((name) => ({ value: name, label: t('dialogs.theme.custom', { name }) })),
    ];
    super({
      title: t('dialogs.theme.title'),
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
