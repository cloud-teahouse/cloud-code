import type { ApprovalRequest, ApprovalResponse, ToolInputDisplay } from '@cloud-code/sdk';

import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';
import { goalStartOptions } from '#/tui/components/dialogs/goal-start-permission-prompt';
import { resolveDescription, t, type MessageKey } from '#/tui/i18n';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '#/tui/reverse-rpc/types';

// Choice labels/descriptions hold i18n keys; `cloneChoice` resolves them at
// adaptation time. `selected_label` stays a stable English token — it is
// echoed back to the agent in the response (policy reads it), not displayed.
const DEFAULT_APPROVAL_CHOICES: ApprovalPanelChoice[] = [
  { label: 'approval.choice.approveOnce', response: 'approved' },
  { label: 'approval.choice.approveSession', response: 'approved_for_session' },
  {
    label: 'approval.choice.approveAlways',
    response: 'approved_always',
    description: 'approval.choice.approveAlwaysDescription',
  },
  { label: 'approval.choice.reject', response: 'rejected' },
  { label: 'approval.choice.rejectWithFeedback', response: 'rejected', requires_feedback: true },
];

const PLAN_APPROVE_CHOICES: ApprovalPanelChoice[] = [
  {
    label: 'approval.choice.approve',
    response: 'approved',
    selected_label: 'Approve',
    description: 'approval.choice.approveKeepModeDescription',
  },
  {
    label: 'approval.choice.approveWithAuto',
    response: 'approved',
    selected_label: 'Approve with Auto mode',
    mode: 'auto',
    description: 'approval.choice.approveWithAutoDescription',
  },
  {
    // Approve while annotating the plan ("also update the README") — saves a
    // reject + re-plan round-trip. The feedback rides the approval response
    // into the plan handoff.
    label: 'approval.choice.approveWithFeedback',
    response: 'approved',
    selected_label: 'Approve with feedback',
    requires_feedback: true,
  },
];

const PLAN_REJECT_CHOICES: ApprovalPanelChoice[] = [
  { label: 'approval.choice.reject', response: 'rejected', selected_label: 'Reject' },
  {
    label: 'approval.choice.revise',
    response: 'rejected',
    selected_label: 'Revise',
    requires_feedback: true,
  },
];

export function adaptApprovalRequest(event: ApprovalRequest): ApprovalPanelData {
  const resolved = resolveDisplay(event.toolName, event.display, event.action);
  return {
    id: event.toolCallId,
    tool_call_id: event.toolCallId,
    tool_name: event.toolName,
    action: event.action,
    description: resolved.description,
    display: resolved.blocks,
    choices: adaptChoices(event.toolName, event.display),
    requester: event.requester,
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

function resolveDisplay(
  toolName: string,
  display: ToolInputDisplay,
  action: string,
): ResolvedDisplay {
  if (display.kind === 'generic' && isRecord(display.detail)) {
    const extracted = extractFromArgs(toolName, display.detail);
    if (extracted !== null) return extracted;
  }
  return {
    blocks: adaptDisplay(display),
    description: describeApproval(display, action),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' ? value : undefined;
}

function extractFromArgs(
  toolName: string,
  detail: Record<string, unknown>,
): ResolvedDisplay | null {
  const command = stringField(detail, 'command');
  if (command !== undefined) {
    const cwd = stringField(detail, 'cwd');
    const toolDescription = stringField(detail, 'description');
    const danger = detectDanger(command);
    const language = stringField(detail, 'language') ?? 'bash';
    return {
      blocks: [
        {
          type: 'shell',
          language,
          command,
          cwd,
          description: toolDescription,
          danger,
        },
      ],
      description: toolDescription ?? '',
    };
  }

  const oldString = stringField(detail, 'old_string');
  const newString = stringField(detail, 'new_string');
  if (oldString !== undefined && newString !== undefined) {
    const path = stringField(detail, 'file_path') ?? stringField(detail, 'path') ?? '';
    // Diff block carries its own `+N -M path` header — no separate
    // file_op title row needed.
    return {
      blocks: [{ type: 'diff', path, old_text: oldString, new_text: newString }],
      description: '',
    };
  }

  const filePath = stringField(detail, 'file_path') ?? stringField(detail, 'path');
  const content = stringField(detail, 'content');
  if (filePath !== undefined && content !== undefined) {
    // Write is a brand-new file: render the content as a syntax-
    // highlighted code block, not a diff full of `+` markers.
    return {
      blocks: [{ type: 'file_content', path: filePath, content }],
      description: '',
    };
  }

  const url = stringField(detail, 'url');
  if (url !== undefined) {
    const method = stringField(detail, 'method');
    return {
      blocks: [{ type: 'url_fetch', url, method }],
      description: '',
    };
  }

  const query = stringField(detail, 'query');
  if (query !== undefined) {
    return {
      blocks: [{ type: 'search', query }],
      description: '',
    };
  }

  const pattern = stringField(detail, 'pattern');
  if (pattern !== undefined) {
    const scope = stringField(detail, 'path');
    return {
      blocks: [{ type: 'search', query: pattern, scope }],
      description: '',
    };
  }

  if (filePath !== undefined) {
    const operation = inferFileOp(toolName);
    return {
      blocks: [{ type: 'file_op', operation, path: filePath }],
      description: '',
    };
  }

  return null;
}

function inferFileOp(toolName: string): 'read' | 'write' | 'edit' | 'glob' | 'grep' {
  const lower = toolName.toLowerCase();
  if (lower.includes('glob')) return 'glob';
  if (lower.includes('grep')) return 'grep';
  if (lower.includes('edit')) return 'edit';
  if (lower.includes('write')) return 'write';
  return 'read';
}

export function adaptPanelResponse(response: ApprovalPanelResponse): ApprovalResponse {
  if (response.response === 'approved_for_session' || response.response === 'approved_always') {
    return {
      decision: 'approved',
      scope: response.response === 'approved_always' ? 'always' : 'session',
      feedback: response.feedback,
      selectedLabel: response.selected_label,
      mode: response.mode,
    };
  }
  return {
    decision:
      response.response === 'approved'
        ? 'approved'
        : response.response === 'rejected'
          ? 'rejected'
          : 'cancelled',
    feedback: response.feedback,
    selectedLabel: response.selected_label,
    mode: response.mode,
  };
}

function describeApproval(display: ToolInputDisplay, action: string): string {
  switch (display.kind) {
    case 'plan_review':
      return '';
    case 'goal_start':
      return t('approval.desc.goalStart');
    case 'generic':
      if (typeof display.detail === 'string' && display.detail.length > 0) {
        return display.detail;
      }
      return display.summary ?? action;
    case 'command':
      return display.description ?? display.command ?? action;
    case 'diff':
      return t('approval.desc.edit', { path: display.path ?? '' }).trim();
    case 'file_io':
      return t('approval.desc.fileOp', {
        operation: display.operation ?? 'file',
        path: display.path ?? '',
      }).trim();
    case 'task_stop':
      return t('approval.desc.taskStop', {
        task: display.task_description ?? display.task_id ?? '',
      }).trim();
    case 'agent_call':
      return t('approval.desc.spawnAgent', { name: display.agent_name ?? 'agent' });
    case 'skill_call':
      return t('approval.desc.invokeSkill', { name: display.skill_name ?? '' }).trim();
    case 'url_fetch':
      return t('approval.desc.fetch', { url: display.url ?? '' }).trim();
    case 'search':
      return t('approval.desc.search', { query: display.query ?? '' }).trim();
    case 'todo_list':
      return t('approval.desc.todoList', { count: display.items?.length ?? 0 });
    case 'task':
      return t('approval.desc.task', {
        status: display.status ?? 'background',
        id: display.task_id ?? '',
        description: display.description ?? '',
      }).trim();
    default:
      return action;
  }
}

const DANGER_PATTERNS: Array<{ pattern: RegExp; labelKey: MessageKey }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, labelKey: 'approval.danger.recursiveDelete' },
  { pattern: /\bsudo\b/i, labelKey: 'approval.danger.sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, labelKey: 'approval.danger.pipeToShell' },
  { pattern: /\bdd\b[^|]*\bof=/i, labelKey: 'approval.danger.ddWrite' },
  { pattern: /\bmkfs\b/i, labelKey: 'approval.danger.mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, labelKey: 'approval.danger.rawDevice' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, labelKey: 'approval.danger.chmod777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, labelKey: 'approval.danger.forkBomb' },
];

function detectDanger(command: string): string | undefined {
  for (const { pattern, labelKey } of DANGER_PATTERNS) {
    if (pattern.test(command)) return t(labelKey);
  }
  return undefined;
}

function adaptDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case 'command': {
      const command = display.command ?? '';
      const danger = detectDanger(command);
      return [
        {
          type: 'shell',
          language: display.language ?? 'bash',
          command,
          cwd: display.cwd,
          description: display.description,
          danger,
        },
      ];
    }
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path ?? '',
          old_text: display.before ?? '',
          new_text: display.after ?? '',
        },
      ];
    case 'file_io': {
      const path = display.path ?? '';
      // Write attaches the full file content — render it as a syntax-
      // highlighted code block so the approval panel can preview (and
      // ctrl+e expand) what is about to land on disk.
      if (display.operation === 'write' && typeof display.content === 'string') {
        return [{ type: 'file_content', path, content: display.content }];
      }
      // Edit attaches the old_string/new_string hunk as before/after — render
      // it as a diff block so ctrl+e expansion works on the change.
      if (
        display.operation === 'edit' &&
        typeof display.before === 'string' &&
        typeof display.after === 'string'
      ) {
        return [{ type: 'diff', path, old_text: display.before, new_text: display.after }];
      }
      return [
        {
          type: 'file_op',
          operation: display.operation,
          path,
          detail: display.detail,
        },
      ];
    }
    case 'url_fetch':
      return [
        {
          type: 'url_fetch',
          url: display.url ?? '',
          method: display.method,
        },
      ];
    case 'search':
      return [
        {
          type: 'search',
          query: display.query ?? '',
          scope: display.scope,
        },
      ];
    case 'agent_call':
      return [
        {
          type: 'invocation',
          kind: 'agent',
          name: display.agent_name ?? '',
          description: display.prompt,
        },
      ];
    case 'skill_call':
      return [
        {
          type: 'invocation',
          kind: 'skill',
          name: display.skill_name ?? '',
          description: display.args,
        },
      ];
    case 'task_stop':
      return [
        {
          type: 'brief',
          text: t('approval.taskStop.brief', {
            id: display.task_id ?? '',
            description: display.task_description ?? '',
          }),
        },
      ];
    case 'plan_review':
      return [];
    case 'goal_start': {
      const lines = [t('approval.goalStart.title', { objective: display.objective })];
      if (typeof display.completionCriterion === 'string' && display.completionCriterion.length > 0) {
        lines.push(t('approval.goalStart.doneWhen', { criterion: display.completionCriterion }));
      }
      return [{ type: 'brief', text: lines.join('\n') }];
    }
    case 'generic':
      return [];
    case 'todo_list':
      return [];
    case 'task':
      return [];
    default:
      return [];
  }
}

function adaptChoices(toolName: string, display: ToolInputDisplay): ApprovalPanelChoice[] {
  if (toolName === 'ExitPlanMode' || display.kind === 'plan_review') {
    return adaptPlanReviewChoices(display);
  }
  if (display.kind === 'goal_start') {
    return adaptGoalStartChoices(display);
  }

  return DEFAULT_APPROVAL_CHOICES.map((choice) => cloneChoice(choice));
}

function adaptGoalStartChoices(
  display: Extract<ToolInputDisplay, { kind: 'goal_start' }>,
): ApprovalPanelChoice[] {
  // Reuse the exact options the /goal start menu shows. Each mode option starts
  // the goal under that permission mode (the policy reads selected_label); "Do
  // not start" declines so no goal is created.
  return goalStartOptions(display.mode).map((option) =>
    option.value === 'cancel'
      ? {
          label: option.label,
          response: 'cancelled',
          selected_label: 'cancel',
          description: option.description,
        }
      : {
          label: option.label,
          response: 'approved',
          selected_label: option.value,
          description: option.description,
        },
  );
}

function adaptPlanReviewChoices(display: ToolInputDisplay): ApprovalPanelChoice[] {
  const optionChoices =
    display.kind === 'plan_review' && display.options !== undefined && display.options.length >= 2
      ? display.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
        }))
      : PLAN_APPROVE_CHOICES;
  return [...optionChoices, ...PLAN_REJECT_CHOICES].map((choice) => cloneChoice(choice));
}

function cloneChoice(choice: ApprovalPanelChoice): ApprovalPanelChoice {
  // Resolve i18n keys in display fields (label/description). Plain text —
  // e.g. plan-review options supplied by the agent — passes through.
  return {
    ...choice,
    label: resolveDescription(choice.label),
    ...(choice.description !== undefined
      ? { description: resolveDescription(choice.description) }
      : {}),
  };
}
