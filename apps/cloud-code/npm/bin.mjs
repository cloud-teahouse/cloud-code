#!/usr/bin/env node
/** cloudcode bin launcher: exec the platform binary fetched by postinstall. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, 'bin', process.platform === 'win32' ? 'cloudcode.exe' : 'cloudcode');

if (!existsSync(binary)) {
  console.error('cloudcode-cli: binary missing — reinstall (`npm install -g @cloud-teahouse/cloudcode-cli`) or run `node npm/postinstall.mjs` in the package directory.');
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? (result.signal === null ? 1 : 0));
