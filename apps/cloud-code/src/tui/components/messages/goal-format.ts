import { t } from '#/tui/i18n';

export function formatGoalElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t('panels.goal.duration.seconds', { seconds: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return t('panels.goal.duration.minutes', {
      minutes,
      seconds: seconds.toString().padStart(2, '0'),
    });
  }
  const hours = Math.floor(minutes / 60);
  return t('panels.goal.duration.hours', {
    hours,
    minutes: (minutes % 60).toString().padStart(2, '0'),
  });
}

export function pluralizeGoalCount(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
