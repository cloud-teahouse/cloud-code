import { describe, expect, it } from 'vitest';

import { isRawStructuredPayload } from '#/tui/utils/structured-payload';

describe('isRawStructuredPayload', () => {
  it('accepts a single JSON object, compact or pretty-printed', () => {
    expect(isRawStructuredPayload('{"a":1,"b":[2,3]}')).toBe(true);
    expect(isRawStructuredPayload('{\n  "a": 1,\n  "b": [2, 3]\n}')).toBe(true);
  });

  it('accepts a single JSON array', () => {
    expect(isRawStructuredPayload('[{"id":1},{"id":2}]')).toBe(true);
    expect(isRawStructuredPayload('[\n  1,\n  2\n]')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isRawStructuredPayload('  \n {"a":1} \n')).toBe(true);
  });

  it('rejects prose, including prose that opens with a brace', () => {
    expect(isRawStructuredPayload('2 tools found')).toBe(false);
    expect(isRawStructuredPayload('{not json} something happened')).toBe(false);
    expect(isRawStructuredPayload('[listen] Configured 3 sources')).toBe(false);
  });

  it('rejects JSON scalars and fragments', () => {
    expect(isRawStructuredPayload('"just a string"')).toBe(false);
    expect(isRawStructuredPayload('123')).toBe(false);
    expect(isRawStructuredPayload('null')).toBe(false);
    expect(isRawStructuredPayload('{"a":1')).toBe(false);
    expect(isRawStructuredPayload('')).toBe(false);
  });

  it('rejects JSONL streams and JSON with a trailing note', () => {
    expect(isRawStructuredPayload('{"a":1}\n{"b":2}')).toBe(false);
    expect(isRawStructuredPayload('{"a":1}\ndone')).toBe(false);
  });
});
