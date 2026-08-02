/**
 * Guardian assessment contract (F3). Ported from codex
 * `codex-rs/core/src/guardian/prompt.rs` (`GuardianAssessment`,
 * `parse_guardian_assessment`): the reviewer model answers strict JSON with
 * `outcome` as the only required field; a prose wrapper around the JSON is
 * tolerated via brace-substring recovery, anything else is a review failure
 * (fail-closed — the caller falls back to a human or denies).
 */

import { z } from 'zod';

export const GUARDIAN_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type GuardianRiskLevel = (typeof GUARDIAN_RISK_LEVELS)[number];

export const GUARDIAN_USER_AUTHORIZATIONS = ['unknown', 'low', 'medium', 'high'] as const;
export type GuardianUserAuthorization = (typeof GUARDIAN_USER_AUTHORIZATIONS)[number];

export interface GuardianAssessment {
  readonly riskLevel: GuardianRiskLevel;
  readonly userAuthorization: GuardianUserAuthorization;
  readonly outcome: 'allow' | 'deny';
  readonly rationale: string;
}

const GuardianAssessmentPayloadSchema = z.object({
  risk_level: z.enum(GUARDIAN_RISK_LEVELS).optional(),
  user_authorization: z.enum(GUARDIAN_USER_AUTHORIZATIONS).optional(),
  outcome: z.enum(['allow', 'deny']),
  rationale: z.string().optional(),
});

export class GuardianAssessmentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianAssessmentParseError';
  }
}

/**
 * Parse the reviewer model's final text into a {@link GuardianAssessment}.
 * Throws {@link GuardianAssessmentParseError} on any failure; missing optional
 * fields are filled with the same defaults codex uses (risk level derived
 * from the outcome, template rationale, `unknown` authorization).
 */
export function parseGuardianAssessment(text: string | undefined): GuardianAssessment {
  if (text === undefined || text.trim().length === 0) {
    throw new GuardianAssessmentParseError('guardian review completed without an assessment payload');
  }
  let payload;
  try {
    payload = GuardianAssessmentPayloadSchema.parse(parseJsonWithRecovery(text));
  } catch (error) {
    if (error instanceof GuardianAssessmentParseError) throw error;
    throw new GuardianAssessmentParseError('guardian assessment did not match the output contract');
  }

  const outcome = payload.outcome;
  const riskLevel = payload.risk_level ?? (outcome === 'allow' ? 'low' : 'high');
  const rationale =
    payload.rationale !== undefined && payload.rationale.trim().length > 0
      ? payload.rationale
      : outcome === 'allow'
        ? 'Auto-review returned a low-risk allow decision.'
        : 'Auto-review returned a deny decision without a rationale.';

  return {
    riskLevel,
    userAuthorization: payload.user_authorization ?? 'unknown',
    outcome,
    rationale,
  };
}

/**
 * The model is asked for strict JSON, but a surrounding prose wrapper is
 * accepted (first `{` to last `}`) so transient formatting drift fails less
 * noisily. Non-JSON output is still a review failure; this is only a thin
 * recovery path.
 */
function parseJsonWithRecovery(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to substring recovery
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && start < end) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through to the failure below
    }
  }
  throw new GuardianAssessmentParseError('guardian assessment was not valid JSON');
}
