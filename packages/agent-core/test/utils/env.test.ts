import { describe, expect, it } from 'vitest';

import { cloudCodeEnv } from '../../src/utils/env';

describe('cloudCodeEnv', () => {
  it('reads the primary CLOUD_CODE_* name', () => {
    expect(cloudCodeEnv('CLOUD_CODE_X', 'KIMI_X', { CLOUD_CODE_X: 'a' })).toBe('a');
  });

  it('falls back to the legacy KIMI_* name', () => {
    expect(cloudCodeEnv('CLOUD_CODE_X', 'KIMI_X', { KIMI_X: 'b' })).toBe('b');
  });

  it('prefers the primary name when both are set', () => {
    expect(cloudCodeEnv('CLOUD_CODE_X', 'KIMI_X', { CLOUD_CODE_X: 'a', KIMI_X: 'b' })).toBe('a');
  });

  it('returns undefined when neither is set', () => {
    expect(cloudCodeEnv('CLOUD_CODE_X', 'KIMI_X', {})).toBeUndefined();
  });
});
