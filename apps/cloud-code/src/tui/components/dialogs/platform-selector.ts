import { OPEN_PLATFORMS } from '@cloud-code/oauth';

import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: 'kimi-code', label: 'Kimi Code (OAuth)' },
  { value: 'chatgpt-codex', label: 'ChatGPT Codex (OAuth)' },
  ...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })),
];

export interface PlatformSelectorOptions {
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: t('selectors.platform.title'),
      options: [...PLATFORM_OPTIONS],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
