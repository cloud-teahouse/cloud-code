/**
 * Format a `BackgroundTaskInfo` snapshot into the transcript card data
 * consumed by `BackgroundAgentStatusComponent`.
 *
 * Background tasks have several statuses (running / completed / failed /
 * timed_out / killed / lost) but the transcript card only renders three
 * visual phases (started / completed / failed). The
 * mapping packs the extra nuance — exit code, kill reason, lost-reason
 * — into the dim detail line so the user still sees it.
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';
import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '@/tui/types';

const MAX_DETAIL_LENGTH = 240;

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
}

export type BackgroundTaskTranscriptPhase = 'started' | 'updated' | 'terminal';

function phaseFromStatus(status: BackgroundTaskStatus): BackgroundAgentStatusPhase {
  switch (status) {
    case 'running':
      return 'started';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'failed';
  }
}

function subjectFor(info: BackgroundTaskInfo): string {
  if (info.kind === 'agent') return t('utils.backgroundTask.subject.agent');
  if (info.kind === 'question') return t('utils.backgroundTask.subject.question');
  return t('utils.backgroundTask.subject.bash');
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = subjectFor(info);
  switch (info.status) {
    case 'running':
      return t('utils.backgroundTask.headline.started', { subject });
    case 'completed':
      return t('utils.backgroundTask.headline.completed', { subject });
    case 'failed':
      return t('utils.backgroundTask.headline.failed', { subject });
    case 'timed_out':
      return t('utils.backgroundTask.headline.timedOut', { subject });
    case 'killed':
      return t('utils.backgroundTask.headline.stopped', { subject });
    case 'lost':
      return t('utils.backgroundTask.headline.lost', { subject });
  }
}

function detailFor(info: BackgroundTaskInfo): string | undefined {
  const parts: string[] = [];
  const description = truncate(info.description);
  if (description !== undefined) parts.push(description);

  if (info.status === 'completed' || info.status === 'failed') {
    if (info.kind === 'process' && info.exitCode !== null) {
      parts.push(t('utils.backgroundTask.detail.exit', { code: info.exitCode }));
    }
  }
  if (info.status === 'killed') {
    const reason = truncate(info.stopReason);
    parts.push(
      reason !== undefined
        ? t('utils.backgroundTask.detail.stoppedReason', { reason })
        : t('utils.backgroundTask.detail.stopped'),
    );
  }
  if (info.status === 'failed') {
    const reason = truncate(info.stopReason);
    if (reason !== undefined) parts.push(reason);
  }
  if (info.status === 'timed_out') parts.push(t('utils.backgroundTask.detail.timedOut'));
  if (info.status === 'lost') {
    parts.push(t('utils.backgroundTask.detail.lost'));
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Build a transcript card payload for a background task lifecycle
 * snapshot. The returned phase drives bullet color in the renderer
 * (`BackgroundAgentStatusComponent`); the detail line carries the extra
 * status nuance (exit code, kill reason, etc.).
 */
export function formatBackgroundTaskTranscript(
  info: BackgroundTaskInfo,
): BackgroundAgentStatusData {
  return {
    phase: phaseFromStatus(info.status),
    headline: headlineFor(info),
    detail: detailFor(info),
  };
}
