import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildKimiDefaultHeaders,
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/cloud-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'cloud-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('builds default headers with the cloud-code-cli user-agent', () => {
    const headers = buildKimiDefaultHeaders('1.2.3');

    expect(headers['User-Agent']).toBe('cloud-code-cli/1.2.3');
  });

  it('builds the product user-agent for ad-hoc fetches', () => {
    expect(createKimiCodeUserAgent('1.2.3')).toBe('cloud-code-cli/1.2.3');
  });
});
