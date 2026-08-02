import { ChoicePickerComponent } from './choice-picker';

import { t, type LocalePreference, type MessageKey } from '#/tui/i18n';

const LANGUAGE_OPTIONS: readonly { value: LocalePreference; labelKey: MessageKey }[] = [
  { value: 'auto', labelKey: 'dialogs.language.auto' },
  { value: 'en', labelKey: 'dialogs.language.en' },
  { value: 'zh-CN', labelKey: 'dialogs.language.zh-CN' },
];

export interface LanguageSelectorOptions {
  readonly currentValue: LocalePreference;
  readonly onSelect: (language: LocalePreference) => void;
  readonly onCancel: () => void;
}

export class LanguageSelectorComponent extends ChoicePickerComponent {
  constructor(opts: LanguageSelectorOptions) {
    super({
      title: t('dialogs.language.title'),
      // Language names stay in their own tongue (English / 简体中文); the
      // 'auto' option is the only translated label.
      options: LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const match = LANGUAGE_OPTIONS.find((option) => option.value === value);
        if (match !== undefined) opts.onSelect(match.value);
      },
      onCancel: opts.onCancel,
    });
  }
}
