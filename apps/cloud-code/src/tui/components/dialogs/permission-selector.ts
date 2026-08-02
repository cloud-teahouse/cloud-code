import type { PermissionMode } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function permissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'manual',
      label: t('selectors.permission.manual.label'),
      description: t('selectors.permission.manual.description'),
    },
    {
      value: 'yolo',
      label: t('selectors.permission.yolo.label'),
      description: t('selectors.permission.yolo.description'),
    },
    {
      value: 'auto',
      label: t('selectors.permission.auto.label'),
      description: t('selectors.permission.auto.description'),
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: t('commands.permission.description'),
      options: [...permissionOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
