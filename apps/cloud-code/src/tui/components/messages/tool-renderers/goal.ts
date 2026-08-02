import { Text } from '@cloud-code/pi-tui';

import { goalSnapshotStructuredSchema } from '@cloud-code/sdk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { formatTokenCount } from '#/utils/usage/usage-format';

import { formatGoalElapsed } from '../goal-format';
import { goalReasonText } from '../goal-reason';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

type GoalToolName = 'CreateGoal' | 'GetGoal' | 'SetGoalBudget' | 'UpdateGoal';

interface GoalSnapshotView {
  readonly objective: string;
  readonly status: string;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly terminalReason?: string | undefined;
}

const GOAL_TOOLS = new Set<string>([
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
]);

export function isGoalToolName(toolName: string): toolName is GoalToolName {
  return GOAL_TOOLS.has(toolName);
}

export const goalSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);

  switch (toolCall.name) {
    case 'CreateGoal':
    case 'GetGoal':
      return renderGoalSnapshot(toolCall, result, ctx);
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return [];
    default:
      return renderTruncated(toolCall, result, ctx);
  }
};

export function buildGoalToolHeader(options: {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly bullet: string;
  readonly chip: string;
}): string | undefined {
  const { toolCall, result, bullet, chip } = options;
  if (!isGoalToolName(toolCall.name)) return undefined;

  const tone = result?.is_error === true ? 'error' : 'primary';
  const label = currentTheme.boldFg(tone, goalToolLabel(toolCall.name, result, toolCall.args));
  const marker =
    result !== undefined && result.is_error !== true
      ? currentTheme.fg('primary', STATUS_BULLET)
      : bullet;
  const arg =
    toolCall.name === 'UpdateGoal'
      ? undefined
      : formatGoalToolArgument(toolCall.name, toolCall.args);
  const argText = arg === undefined ? '' : currentTheme.dimFg('textDim', ` (${arg})`);
  return `${marker}${label}${argText}${chip}`;
}

function formatGoalBudgetArg(args: Record<string, unknown>): string | undefined {
  const value = args['value'];
  const unit = args['unit'];
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof unit !== 'string') {
    return undefined;
  }
  if (unit.length === 0) return undefined;
  const normalized = unit === 'turns' || unit === 'tokens'
    ? Math.max(1, Math.round(value))
    : value;
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(normalized)} ${normalized === 1 ? singular : unit}`;
}

export function goalStatusChip(result: ToolResultBlockData): string {
  const structured = goalSnapshotStructuredSchema.safeParse(result.structured);
  if (structured.success) return goalStatusLabel(structured.data.status);
  const goal = parseGoalValue(result.output);
  if (goal === undefined) return '';
  if (goal === null) return t('messages.chip.noGoal');
  const status = stringField(goal, 'status');
  return status === undefined ? '' : goalStatusLabel(status);
}

/**
 * Localized label for a goal status enum value. Unknown values (version
 * skew) pass through raw — they are machine enums, not prose.
 */
function goalStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return t('messages.goal.status.active');
    case 'paused':
      return t('messages.goal.status.paused');
    case 'blocked':
      return t('messages.goal.status.blocked');
    case 'complete':
      return t('messages.goal.status.complete');
    default:
      return status;
  }
}

function renderGoalSnapshot(
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  _ctx: Parameters<ResultRenderer>[2],
) {
  const goal = parseGoalToolOutput(result.output);
  if (goal === undefined) return renderTruncated(toolCall, result, _ctx);

  // Flush-left rows in the shared `textDim` detail tone; the tree gutter
  // wrapper in tool-call.ts owns indentation.
  const body = (s: string) => currentTheme.fg('textDim', s);
  if (goal === null) return [new Text(body(t('messages.goal.noCurrentGoal')), 0, 0)];

  // Status and runtime-authored terminal reason localize via the result's
  // structured payload; older records render the JSON fields as before.
  const structured = goalSnapshotStructuredSchema.safeParse(result.structured);
  const status = structured.success
    ? goalStatusLabel(structured.data.status)
    : goalStatusLabel(goal.status);
  const terminalReason = structured.success
    ? (goalReasonText(
        structured.data.terminalReasonCode,
        structured.data.terminalReasonDetail,
      ) ?? structured.data.terminalReason)
    : goal.terminalReason;

  const lines = [
    body(
      t('messages.goal.statusLine', {
        status,
        objective: truncateOneLine(goal.objective, 96),
      }),
    ),
    body(formatGoalStats(goal)),
  ];
  if (terminalReason !== undefined && terminalReason.length > 0) {
    lines.push(body(terminalReason));
  }
  return lines.map((line) => new Text(line, 0, 0));
}

function goalToolLabel(
  toolName: GoalToolName,
  result: ToolResultBlockData | undefined,
  args: Record<string, unknown>,
): string {
  const failed = result?.is_error === true;
  const finished = result !== undefined;
  switch (toolName) {
    case 'CreateGoal':
      return failed
        ? t('messages.goal.create.failed')
        : finished
          ? t('messages.goal.create.done')
          : t('messages.goal.create.running');
    case 'GetGoal':
      return failed
        ? t('messages.goal.check.failed')
        : finished
          ? t('messages.goal.check.done')
          : t('messages.goal.check.running');
    case 'SetGoalBudget':
      return failed
        ? t('messages.goal.budget.failed')
        : finished
          ? t('messages.goal.budget.done')
          : t('messages.goal.budget.running');
    case 'UpdateGoal': {
      const vars = { status: stringArg(args, 'status') ?? t('messages.goal.statusFallback') };
      return failed
        ? t('messages.goal.report.failed', vars)
        : finished
          ? t('messages.goal.report.done', vars)
          : t('messages.goal.report.running', vars);
    }
  }
}

function formatGoalToolArgument(
  toolName: GoalToolName,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolName) {
    case 'CreateGoal': {
      const objective = stringArg(args, 'objective');
      return objective === undefined ? undefined : truncateOneLine(objective, 60);
    }
    case 'SetGoalBudget':
      return formatGoalBudgetArg(args);
    case 'UpdateGoal':
      return stringArg(args, 'status');
    case 'GetGoal':
      return undefined;
  }
}

function parseGoalToolOutput(output: string): GoalSnapshotView | null | undefined {
  const goal = parseGoalValue(output);
  if (goal === undefined || goal === null) return goal;
  const objective = stringField(goal, 'objective');
  const status = stringField(goal, 'status');
  if (objective === undefined || status === undefined) return undefined;
  return {
    objective,
    status,
    turnsUsed: numberField(goal, 'turnsUsed'),
    tokensUsed: numberField(goal, 'tokensUsed'),
    wallClockMs: numberField(goal, 'wallClockMs'),
    terminalReason: stringField(goal, 'terminalReason'),
  };
}

function parseGoalValue(output: string): Record<string, unknown> | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !('goal' in parsed)) return undefined;
  const goal = parsed['goal'];
  if (goal === null) return null;
  if (!isRecord(goal)) return undefined;
  return goal;
}

function formatGoalStats(goal: GoalSnapshotView): string {
  return [
    t(goal.turnsUsed === 1 ? 'messages.goal.turns.one' : 'messages.goal.turns.other', {
      count: goal.turnsUsed,
    }),
    t('messages.goal.tokens', { count: formatTokenCount(goal.tokensUsed) }),
    formatGoalElapsed(goal.wallClockMs),
  ].join(' · ');
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.replaceAll(/\s+/g, ' ').trim();
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
