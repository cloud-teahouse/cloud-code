import { resolveDescription } from '#/tui/i18n';

import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface GoalStartPermissionPromptOptions {
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

// Option label/description hold i18n keys; they are resolved at consumption
// (dialog render, or `goalStartOptions` for the approval adapter).
export const GOAL_START_MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'approval.startPrompt.switchAuto.label',
    description: 'approval.goalStartPrompt.switchAuto.description',
  },
  {
    value: 'yolo',
    label: 'approval.startPrompt.switchYolo.label',
    description: 'approval.startPrompt.switchYolo.description',
  },
  {
    value: 'manual',
    label: 'approval.startPrompt.startManual.label',
    description: 'approval.goalStartPrompt.startManual.description',
  },
  {
    value: 'cancel',
    label: 'approval.goalStartPrompt.doNotStart.label',
    description: 'approval.goalStartPrompt.doNotStart.description',
  },
];

export const GOAL_START_YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'approval.startPrompt.switchAuto.label',
    description: 'approval.goalStartPrompt.switchAuto.description',
  },
  {
    value: 'yolo',
    label: 'approval.goalStartPrompt.keepYolo.label',
    description: 'approval.goalStartPrompt.keepYolo.description',
  },
  {
    value: 'cancel',
    label: 'approval.goalStartPrompt.doNotStart.label',
    description: 'approval.goalStartPrompt.doNotStart.description',
  },
];

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  const options = mode === 'yolo' ? GOAL_START_YOLO_OPTIONS : GOAL_START_MANUAL_OPTIONS;
  // The approval adapter reuses these options verbatim as panel choices, so
  // resolve the stored i18n keys here (adaptation time, like the adapter's
  // own `t()` calls).
  return options.map((option) => ({
    value: option.value,
    label: resolveDescription(option.label),
    description: resolveDescription(option.description),
  }));
}

const MANUAL_OPTIONS = GOAL_START_MANUAL_OPTIONS;

const YOLO_OPTIONS = GOAL_START_YOLO_OPTIONS;

const MANUAL_NOTICE_LINES = [
  'approval.startPrompt.notice.manualAsk',
  'approval.goalStartPrompt.notice.unattended',
  'approval.startPrompt.notice.goBack',
] as const;

const YOLO_NOTICE_LINES = [
  'approval.goalStartPrompt.notice.yoloApproves',
  'approval.goalStartPrompt.notice.yoloQuestions',
  'approval.goalStartPrompt.notice.switchAuto',
] as const;

export class GoalStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: GoalStartPermissionPromptOptions) {
    super({
      title:
        opts.mode === 'yolo'
          ? 'approval.goalStartPrompt.title.yolo'
          : 'approval.goalStartPrompt.title.manual',
      noticeLines: opts.mode === 'yolo' ? YOLO_NOTICE_LINES : MANUAL_NOTICE_LINES,
      options: opts.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
