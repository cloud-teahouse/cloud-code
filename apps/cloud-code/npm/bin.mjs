#!/usr/bin/env node
/** cloudcode bin launcher: exec the platform binary from postinstall; if it
 *  is missing (e.g. the install script was blocked), fetch and verify it on
 *  first run. In monorepo checkouts, fall back to the built JS entry. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, 'bin', process.platform === 'win32' ? 'cloudcode.exe' : 'cloudcode');
const distEntry = join(here, '..', 'dist', 'main.mjs');

if (!existsSync(binary)) {
  if (existsSync(join(here, '..', '..', 'pnpm-workspace.yaml')) && existsSync(distEntry)) {
    // Monorepo/source checkout: run the built JS entry directly.
    const result = spawnSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? (result.signal === null ? 1 : 0));
  }
  console.error('cloudcode-cli: runtime binary not found (postinstall may have been blocked) — fetching it now…');
  const result = spawnSync(process.execPath, [join(here, 'postinstall.mjs')], { stdio: 'inherit' });
  if (result.status !== 0 || !existsSync(binary)) {
    console.error('cloudcode-cli: could not fetch the runtime binary. Download it manually from https://github.com/cloud-teahouse/cloud-code/releases');
    process.exit(1);
  }
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? (result.signal === null ? 1 : 0));
