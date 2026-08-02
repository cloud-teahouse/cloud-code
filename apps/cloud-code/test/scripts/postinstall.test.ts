import { describe, expect, it } from 'vitest';

import {
  assetName,
  findSha256Entry,
  isBetaVersion,
  releaseBaseUrl,
} from '../../npm/postinstall.mjs';

describe('postinstall assetName (platform map)', () => {
  it('maps supported platforms to release asset names', () => {
    expect(assetName('linux', 'x64')).toBe('cloud-code-linux-x64');
    expect(assetName('linux', 'arm64')).toBe('cloud-code-linux-arm64');
    expect(assetName('darwin', 'x64')).toBe('cloud-code-darwin-x64');
    expect(assetName('darwin', 'arm64')).toBe('cloud-code-darwin-arm64');
    expect(assetName('win32', 'x64')).toBe('cloud-code-windows-x64.exe');
  });

  it('returns null for unsupported platforms', () => {
    expect(assetName('linux', 'ia32')).toBeNull();
    expect(assetName('freebsd', 'x64')).toBeNull();
    expect(assetName('win32', 'arm64')).toBeNull();
  });
});

describe('postinstall channel resolution', () => {
  it('detects beta package versions', () => {
    expect(isBetaVersion('0.1.0-beta.6c7ebe6a')).toBe(true);
    expect(isBetaVersion('0.2.1')).toBe(false);
    expect(isBetaVersion('0.2.1-rc.1')).toBe(false);
  });

  it('resolves beta versions to the rolling beta tag assets', () => {
    expect(releaseBaseUrl('0.1.0-beta.6c7ebe6a')).toBe(
      'https://github.com/cloud-teahouse/cloud-code/releases/download/beta',
    );
  });

  it('resolves pinned versions to their own tag assets', () => {
    expect(releaseBaseUrl('0.2.1')).toBe(
      'https://github.com/cloud-teahouse/cloud-code/releases/download/v0.2.1',
    );
  });
});

describe('postinstall findSha256Entry', () => {
  const sums = [
    'aaaa  cloud-code-linux-x64',
    'bbbb  cloud-code-linux-x64.tar.gz',
    'cccc  cloud-code-darwin-arm64',
    'dddd  cloud-code-windows-x64.exe',
    'eeee  cloud-code-windows-x64.zip',
  ].join('\n');

  it('finds the raw binary entry and not its archive', () => {
    expect(findSha256Entry(sums, 'cloud-code-linux-x64')).toBe('aaaa');
    expect(findSha256Entry(sums, 'cloud-code-windows-x64.exe')).toBe('dddd');
  });

  it('returns undefined when the asset is missing', () => {
    expect(findSha256Entry(sums, 'cloud-code-linux-arm64')).toBeUndefined();
  });
});
