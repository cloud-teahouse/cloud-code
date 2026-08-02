/**
 * Cloud Code version helpers.
 *
 * `getVersion` reads the host CLI's `package.json#version`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createKimiDefaultHeaders, createCloudCodeUserAgent, CLOUD_CODE_PLATFORM, type CloudCodeHostIdentity } from '@cloud-code/oauth';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { getDataDir } from '../utils/paths';
import { CLOUD_CODE_BUILD_INFO } from './build-info';

const MODULE_DIR = import.meta.dirname;

export function getHostPackageJsonPath(): string {
  // Walk upwards from this file's directory until a `package.json` shows up,
  // so both dev (`tsx src/main.ts` — this file in `src/cli/`, pkg 2 levels
  // up) and prod (`node dist/main.mjs` — this code bundled into `dist/`,
  // pkg 1 level up) resolve correctly.
  let dir = MODULE_DIR;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package.json near ${MODULE_DIR}`);
}

export function getHostPackageRoot(): string {
  return dirname(getHostPackageJsonPath());
}

export function getVersion(): string {
  if (CLOUD_CODE_BUILD_INFO.version !== undefined) {
    return CLOUD_CODE_BUILD_INFO.version;
  }
  const pkg = JSON.parse(readFileSync(getHostPackageJsonPath(), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

export function createKimiCodeHostIdentity(version = getVersion()): CloudCodeHostIdentity {
  return {
    userAgentProduct: CLI_USER_AGENT_PRODUCT,
    version,
    platform: CLOUD_CODE_PLATFORM,
  };
}

/**
 * Product User-Agent (`cloud-code-cli/<version>`) for ad-hoc outbound fetches
 * that don't go through the provider pipeline (registry / catalog imports).
 */
export function createKimiCodeUserAgent(version = getVersion()): string {
  return createCloudCodeUserAgent(createKimiCodeHostIdentity(version));
}

export function buildKimiDefaultHeaders(version: string): Record<string, string> {
  return createKimiDefaultHeaders({
    homeDir: getDataDir(),
    ...createKimiCodeHostIdentity(version),
  });
}
