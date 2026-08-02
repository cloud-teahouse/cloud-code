import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type SwarmStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface SwarmStartPermissionPromptOptions {
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

// Option label/description hold i18n keys; the base component resolves them
// at render time via `resolveDescription`.
const OPTIONS: readonly StartPermissionOption<SwarmStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: 'approval.startPrompt.switchAuto.label',
    description: 'approval.swarmStartPrompt.switchAuto.description',
  },
  {
    value: 'yolo',
    label: 'approval.startPrompt.switchYolo.label',
    description: 'approval.startPrompt.switchYolo.description',
  },
  {
    value: 'manual',
    label: 'approval.startPrompt.startManual.label',
    description: 'approval.swarmStartPrompt.startManual.description',
  },
];

const NOTICE_LINES = [
  'approval.startPrompt.notice.manualAsk',
  'approval.swarmStartPrompt.notice.blockSwarm',
  'approval.startPrompt.notice.goBack',
] as const;

export class SwarmStartPermissionPromptComponent extends StartPermissionPromptComponent<SwarmStartPermissionChoice> {
  constructor(opts: SwarmStartPermissionPromptOptions) {
    super({
      title: 'approval.swarmStartPrompt.title',
      noticeLines: NOTICE_LINES,
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
