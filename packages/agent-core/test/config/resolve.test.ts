import { describe, expect, it } from 'vitest';

import { parseFloatEnv } from '../../src/config/resolve';
import { CloudCodeError } from '../../src/errors';

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CloudCodeError);
    expect((error as CloudCodeError).code).toBe('config.invalid');
    return;
  }
  throw new Error('expected function to throw');
}

describe('parseFloatEnv', () => {
  it('returns undefined when unset, empty, or blank', () => {
    expect(parseFloatEnv(undefined, 'CLOUD_CODE_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('', 'CLOUD_CODE_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('   ', 'CLOUD_CODE_MODEL_TEMPERATURE')).toBeUndefined();
  });

  it('parses valid floats and integers', () => {
    expect(parseFloatEnv('0.3', 'CLOUD_CODE_MODEL_TEMPERATURE')).toBe(0.3);
    expect(parseFloatEnv('1', 'CLOUD_CODE_MODEL_TEMPERATURE')).toBe(1);
    expect(parseFloatEnv(' 0.95 ', 'CLOUD_CODE_MODEL_TOP_P')).toBe(0.95);
    expect(parseFloatEnv('0', 'CLOUD_CODE_MODEL_TEMPERATURE')).toBe(0);
  });

  it.each(['abc', '1.2.3', 'NaN', '1,5'])(
    'throws config.invalid for non-numeric value %s',
    (value) => {
      expectConfigInvalid(() => parseFloatEnv(value, 'CLOUD_CODE_MODEL_TEMPERATURE'));
    },
  );
});
