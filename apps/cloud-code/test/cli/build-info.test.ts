import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_CODE_BUILD_INFO, getChannel } from '#/cli/build-info';

describe('getChannel', () => {
  it('reads the injected channel values', () => {
    expect(getChannel({ channel: 'dev' })).toBe('dev');
    expect(getChannel({ channel: 'beta' })).toBe('beta');
    expect(getChannel({ channel: 'release' })).toBe('release');
  });

  it('falls back to release for missing or unrecognized channels', () => {
    expect(getChannel({})).toBe('release');
    expect(getChannel({ channel: '' })).toBe('release');
    expect(getChannel({ channel: 'nightly' })).toBe('release');
  });

  it('defaults to release when nothing was injected (source/dev runs)', () => {
    expect(CLOUD_CODE_BUILD_INFO.channel).toBeUndefined();
    expect(getChannel()).toBe('release');
  });
});

describe('injected build info', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('parses the --define values the CI compile step injects', async () => {
    vi.stubGlobal('__CLOUD_CODE_VERSION__', 'a94a8fe5-dev');
    vi.stubGlobal('__CLOUD_CODE_CHANNEL__', 'dev');
    vi.stubGlobal('__CLOUD_CODE_COMMIT__', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
    vi.resetModules();
    const mod = await import('#/cli/build-info');
    expect(mod.CLOUD_CODE_BUILD_INFO.version).toBe('a94a8fe5-dev');
    expect(mod.CLOUD_CODE_BUILD_INFO.channel).toBe('dev');
    expect(mod.CLOUD_CODE_BUILD_INFO.commit).toBe(
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    );
    expect(mod.getChannel()).toBe('dev');
  });

  it('ignores empty injected strings', async () => {
    vi.stubGlobal('__CLOUD_CODE_CHANNEL__', '');
    vi.resetModules();
    const mod = await import('#/cli/build-info');
    expect(mod.CLOUD_CODE_BUILD_INFO.channel).toBeUndefined();
    expect(mod.getChannel()).toBe('release');
  });
});
