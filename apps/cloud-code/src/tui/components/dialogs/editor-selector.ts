import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function editorOptions(): readonly ChoiceOption[] {
  return [
    { value: 'code --wait', label: 'VS Code (code --wait)' },
    { value: 'vim', label: 'Vim' },
    { value: 'nvim', label: 'Neovim' },
    { value: 'nano', label: 'Nano' },
    { value: '', label: t('selectors.editor.autoDetect') },
  ];
}

export interface EditorSelectorOptions {
  readonly currentValue: string;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class EditorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EditorSelectorOptions) {
    super({
      title: t('selectors.editor.title'),
      options: [...editorOptions()],
      currentValue: opts.currentValue,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
