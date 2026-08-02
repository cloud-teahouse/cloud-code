import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type CoordinatorStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface CoordinatorStartPermissionPromptOptions {
  readonly onSelect: (choice: CoordinatorStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

// Option label/description hold i18n keys; the base component resolves them
// at render time via `resolveDescription`.
const OPTIONS: readonly StartPermissionOption<CoordinatorStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: 'approval.startPrompt.switchAuto.label',
    description: 'approval.coordinatorStartPrompt.switchAuto.description',
  },
  {
    value: 'yolo',
    label: 'approval.startPrompt.switchYolo.label',
    description: 'approval.startPrompt.switchYolo.description',
  },
  {
    value: 'manual',
    label: 'approval.startPrompt.startManual.label',
    description: 'approval.coordinatorStartPrompt.startManual.description',
  },
];

const NOTICE_LINES = [
  'approval.startPrompt.notice.manualAsk',
  'approval.coordinatorStartPrompt.notice.blockWorkers',
  'approval.startPrompt.notice.goBack',
] as const;

export class CoordinatorStartPermissionPromptComponent extends StartPermissionPromptComponent<CoordinatorStartPermissionChoice> {
  constructor(opts: CoordinatorStartPermissionPromptOptions) {
    super({
      title: 'approval.coordinatorStartPrompt.title',
      noticeLines: NOTICE_LINES,
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
