import { describe, expect, it } from 'vitest';

import {
  GuardianAssessmentParseError,
  parseGuardianAssessment,
} from '../../../src/agent/guardian/assessment';

describe('parseGuardianAssessment', () => {
  it('parses a minimal allow with codex defaults', () => {
    expect(parseGuardianAssessment('{"outcome":"allow"}')).toEqual({
      riskLevel: 'low',
      userAuthorization: 'unknown',
      outcome: 'allow',
      rationale: 'Auto-review returned a low-risk allow decision.',
    });
  });

  it('parses a full four-field deny', () => {
    expect(
      parseGuardianAssessment(
        JSON.stringify({
          risk_level: 'critical',
          user_authorization: 'low',
          outcome: 'deny',
          rationale: 'Exfiltrates credentials to an untrusted host.',
        }),
      ),
    ).toEqual({
      riskLevel: 'critical',
      userAuthorization: 'low',
      outcome: 'deny',
      rationale: 'Exfiltrates credentials to an untrusted host.',
    });
  });

  it('recovers JSON wrapped in prose', () => {
    const text =
      'Let me think about this action.\n' +
      'It looks risky.\n' +
      '{"risk_level":"high","outcome":"deny","rationale":"Deletes production data."}\n' +
      'That is my final answer.';
    expect(parseGuardianAssessment(text)).toEqual({
      riskLevel: 'high',
      userAuthorization: 'unknown',
      outcome: 'deny',
      rationale: 'Deletes production data.',
    });
  });

  it('rejects pure garbage', () => {
    expect(() => parseGuardianAssessment('I cannot decide right now.')).toThrow(
      GuardianAssessmentParseError,
    );
  });

  it('rejects JSON without the required outcome field', () => {
    expect(() => parseGuardianAssessment('{"risk_level":"low"}')).toThrow(
      GuardianAssessmentParseError,
    );
  });

  it('rejects empty and undefined payloads', () => {
    expect(() => parseGuardianAssessment(undefined)).toThrow(GuardianAssessmentParseError);
    expect(() => parseGuardianAssessment('   ')).toThrow(GuardianAssessmentParseError);
  });

  it('derives a high default risk level for deny and fills a template rationale', () => {
    expect(parseGuardianAssessment('{"outcome":"deny"}')).toEqual({
      riskLevel: 'high',
      userAuthorization: 'unknown',
      outcome: 'deny',
      rationale: 'Auto-review returned a deny decision without a rationale.',
    });
  });

  it('treats a whitespace-only rationale as missing', () => {
    const assessment = parseGuardianAssessment('{"outcome":"allow","rationale":"  "}');
    expect(assessment.rationale).toBe('Auto-review returned a low-risk allow decision.');
  });

  it('rejects invalid enum values', () => {
    expect(() => parseGuardianAssessment('{"outcome":"allow","risk_level":"extreme"}')).toThrow(
      GuardianAssessmentParseError,
    );
  });
});
