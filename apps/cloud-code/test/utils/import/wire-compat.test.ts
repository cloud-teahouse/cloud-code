import { describe, expect, it } from 'vitest';

import {
  checkWireCompatibility,
  SUPPORTED_WIRE_PROTOCOL_VERSION,
} from '#/utils/import/wire-compat';

const METADATA = JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 });
const PROMPT = JSON.stringify({ type: 'turn.prompt', content: 'hi' });

describe('checkWireCompatibility', () => {
  it('accepts a well-formed wire file at the supported version', () => {
    expect(checkWireCompatibility(`${METADATA}\n${PROMPT}\n`).ok).toBe(true);
  });

  it('accepts older protocol versions', () => {
    const old = JSON.stringify({ type: 'metadata', protocol_version: '1.0', created_at: 1 });
    expect(checkWireCompatibility(`${old}\n${PROMPT}\n`).ok).toBe(true);
  });

  it('accepts v1.3 wires with legacy goal records absorbed by the 1.3→1.4 migration', () => {
    const v13 = JSON.stringify({ type: 'metadata', protocol_version: '1.3', created_at: 1 });
    const wire = [
      v13,
      JSON.stringify({ type: 'goal.create', goalId: 'g1', objective: 'ship it' }),
      JSON.stringify({ type: 'goal.account_usage', goalId: 'g1', tokensUsed: 10 }),
      JSON.stringify({ type: 'goal.continuation', goalId: 'g1', turnsUsed: 2 }),
      JSON.stringify({ type: 'goal.clear', goalId: 'g1' }),
    ].join('\n');
    expect(checkWireCompatibility(`${wire}\n`).ok).toBe(true);
  });

  it('rejects a newer protocol version as incompatible', () => {
    const newer = JSON.stringify({ type: 'metadata', protocol_version: '9.0', created_at: 1 });
    const verdict = checkWireCompatibility(`${newer}\n${PROMPT}\n`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('incompatible');
      expect(verdict.detail).toContain('9.0');
      expect(verdict.detail).toContain(SUPPORTED_WIRE_PROTOCOL_VERSION);
    }
  });

  it('rejects unknown record types as incompatible', () => {
    const verdict = checkWireCompatibility(
      `${METADATA}\n${JSON.stringify({ type: 'brand.new.record' })}\n`,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('incompatible');
      expect(verdict.detail).toContain('brand.new.record');
    }
  });

  it('rejects a file whose first record is not metadata', () => {
    const verdict = checkWireCompatibility(`${PROMPT}\n`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('invalid');
  });

  it('rejects corrupt mid-file lines but tolerates a truncated final line', () => {
    const corrupt = checkWireCompatibility(`${METADATA}\n{"type":"turn.prompt"\n${PROMPT}\n`);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toBe('invalid');

    const truncated = checkWireCompatibility(`${METADATA}\n${PROMPT}\n{"type":"turn.pr`);
    expect(truncated.ok).toBe(true);
  });

  it('rejects an empty file', () => {
    const verdict = checkWireCompatibility('');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('invalid');
  });
});
