/**
 * `/import` source picker — choose which product to import local data from.
 * Thin ChoicePicker subclass, mirroring permission-selector.ts.
 */

import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type ImportSourceChoice = 'claude' | 'codex' | 'kimi';

function sourceOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'claude',
      label: t('selectors.import.source.claude.label'),
      description: t('selectors.import.source.claude.description'),
    },
    {
      value: 'codex',
      label: t('selectors.import.source.codex.label'),
      description: t('selectors.import.source.codex.description'),
    },
    {
      value: 'kimi',
      label: t('selectors.import.source.kimi.label'),
      description: t('selectors.import.source.kimi.description'),
    },
  ];
}

function isImportSourceChoice(value: string): value is ImportSourceChoice {
  return value === 'claude' || value === 'codex' || value === 'kimi';
}

export interface ImportSourceSelectorOptions {
  readonly onSelect: (source: ImportSourceChoice) => void;
  readonly onCancel: () => void;
}

export class ImportSourceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ImportSourceSelectorOptions) {
    super({
      title: t('selectors.import.source.title'),
      options: [...sourceOptions()],
      onSelect: (value) => {
        if (isImportSourceChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
