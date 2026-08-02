/**
 * Localized rendering of machine goal-stop reasons (`GoalReasonCode`).
 * Shared by the goal lifecycle marker and the goal snapshot card so both
 * render the same localized reason for runtime-authored stops.
 */

import type { GoalReasonCode } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';

const GOAL_REASON_KEYS: Record<GoalReasonCode, Parameters<typeof t>[0] | undefined> = {
  interruption: undefined, // has its own headline key (pausedInterruption)
  agent_resume: 'panels.goal.marker.reason.agentResume',
  session_resume: 'panels.goal.marker.reason.sessionResume',
  rate_limit: 'panels.goal.marker.reason.rateLimit',
  provider_connection: 'panels.goal.marker.reason.providerConnection',
  provider_auth: 'panels.goal.marker.reason.providerAuth',
  provider_api: 'panels.goal.marker.reason.providerApi',
  model_config: 'panels.goal.marker.reason.modelConfig',
  runtime: 'panels.goal.marker.reason.runtime',
  provider_filtered: 'panels.goal.marker.reason.providerFiltered',
};

/**
 * The localized reason text for a coded stop, with the opaque detail (e.g.
 * the provider error message) appended after a colon. Returns undefined
 * when the code has no localized text of its own.
 */
export function goalReasonText(
  code: GoalReasonCode | undefined,
  detail: string | undefined,
): string | undefined {
  if (code === undefined) return undefined;
  const key = GOAL_REASON_KEYS[code];
  if (key === undefined) return undefined;
  const reason = t(key);
  return detail === undefined || detail.length === 0 ? reason : `${reason}: ${detail}`;
}
