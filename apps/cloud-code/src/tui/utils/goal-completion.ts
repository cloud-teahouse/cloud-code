import type { GoalSnapshot } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';
import { formatTokenCount } from '#/utils/usage/usage-format';

interface GoalCompletionStats {
  readonly terminalReason?: string | undefined;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * Deterministic goal-completion text rendered by the TUI when the model marks a
 * goal `complete`. It is built from the final snapshot, so the figures
 * (turns / tokens / time) are exact and do not depend on model prose.
 */
export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  return buildGoalCompletionMessageFromStats(goal);
}

export function buildGoalCompletionMessageFromStats(goal: GoalCompletionStats): string {
  const head =
    goal.terminalReason !== undefined && goal.terminalReason.length > 0
      ? t('panels.goal.complete.headWithReason', { reason: goal.terminalReason })
      : t('panels.goal.complete.head');
  const turns = t(
    goal.turnsUsed === 1 ? 'panels.goal.complete.turns.one' : 'panels.goal.complete.turns.other',
    { count: goal.turnsUsed },
  );
  const stats = t('panels.goal.complete.stats', {
    turns,
    elapsed: formatElapsed(goal.wallClockMs),
    tokens: formatTokenCount(goal.tokensUsed),
  });
  return `${head}\n${stats}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t('panels.goal.duration.seconds', { seconds: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return t('panels.goal.duration.compactMinutes', {
      minutes,
      seconds: seconds.toString().padStart(2, '0'),
    });
  }
  const hours = Math.floor(minutes / 60);
  return t('panels.goal.duration.compactHours', {
    hours,
    minutes: (minutes % 60).toString().padStart(2, '0'),
  });
}
