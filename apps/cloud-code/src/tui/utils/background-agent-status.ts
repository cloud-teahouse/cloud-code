import { t } from '#/tui/i18n';
import type {
  BackgroundAgentMetadata,
  BackgroundAgentStatusData,
  BackgroundAgentStatusPhase,
} from '#/tui/types';

const MAX_BACKGROUND_FIELD_LENGTH = 240;

function normalizeBackgroundField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_BACKGROUND_FIELD_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BACKGROUND_FIELD_LENGTH - 3)}...`;
}

export function formatBackgroundAgentTranscript(
  phase: BackgroundAgentStatusPhase,
  meta: BackgroundAgentMetadata,
  extras:
    | {
        resultSummary?: string;
        error?: string;
        /**
         * Failure variant for the headline (replay maps lost/killed/timed_out
         * task origins onto distinct copy). Locale-safe replacement for the
         * old English-fragment `headline.replace(...)` at the call site.
         */
        failureKind?: 'lost' | 'stopped' | 'timedOut';
      }
    | undefined = undefined,
): BackgroundAgentStatusData {
  const normalizedAgentName = normalizeBackgroundField(meta.agentName);
  const subject =
    normalizedAgentName !== undefined
      ? t('swarm.background.subject.named', { name: normalizedAgentName })
      : t('swarm.background.subject.plain');
  const failureKey =
    extras?.failureKind === 'lost'
      ? 'swarm.background.lost'
      : extras?.failureKind === 'stopped'
        ? 'swarm.background.stopped'
        : extras?.failureKind === 'timedOut'
          ? 'swarm.background.timedOut'
          : 'swarm.background.failed';
  const headline =
    phase === 'started'
      ? t('swarm.background.started', { subject })
      : phase === 'completed'
        ? t('swarm.background.completed', { subject })
        : t(failureKey, { subject });
  const tail = phase === 'failed' ? normalizeBackgroundField(extras?.error) : undefined;
  const detailParts = [normalizeBackgroundField(meta.description), tail].filter(
    (part): part is string => part !== undefined,
  );

  return {
    phase,
    headline,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
  };
}
