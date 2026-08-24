/**
 * Postinstall for the @cloud-teahouse/cloudcode-cli npm package: fetch the
 * matching platform binary from GitHub Releases and verify it against the
 * release's signed sha256sums.txt. The binary lands next to this script as
 * npm/bin/cloudcode[.exe]; the bin launcher (bin.mjs) execs it.
 *
 * The checksum file is only trusted once its detached minisign signature
 * verifies against the key pinned in minisign.mjs — checksums served beside
 * the artifacts they describe prove integrity, not origin.
 *
 * Release resolution follows the package version's channel:
 * - `X.Y.Z-beta.<short8>` (npm dist-tag `beta`) → the rolling `beta`
 *   pre-release's assets, which CI keeps pointed at the newest beta build;
 * - `X.Y.Z` (npm dist-tag `latest`) → the pinned `vX.Y.Z` release's assets.
 *
 * The pure helpers are exported for tests; the network flow only runs when
 * this file is executed directly (`node npm/postinstall.mjs`).
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyMinisignSignature } from './minisign.mjs';

const REPO = 'cloud-teahouse/cloud-code';
const SUMS_NAME = 'sha256sums.txt';
const SUMS_SIGNATURE_NAME = `${SUMS_NAME}.minisig`;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'bin');

export function assetName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'cloud-code-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'cloud-code-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'cloud-code-darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'cloud-code-darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'cloud-code-windows-x64.exe';
  return null;
}

/** Beta packages are published as `X.Y.Z-beta.<short8>` (see publish-npm.yml). */
export function isBetaVersion(version) {
  return /^\d+\.\d+\.\d+-beta\./.test(version);
}

/** Base URL of the GitHub release whose assets match `version`'s channel. */
export function releaseBaseUrl(version) {
  return isBetaVersion(version)
    ? `https://github.com/${REPO}/releases/download/beta`
    : `https://github.com/${REPO}/releases/download/v${version}`;
}

/** Find the sha256 recorded for `name` in a sha256sums.txt document. */
export function findSha256Entry(sums, name) {
  return sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
}

function download(url, dest = null, redirects = 5) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'user-agent': 'cloudcode-cli npm installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      if (dest === null) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      } else {
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }
    }).on('error', reject);
  });
}

async function main() {
  // Monorepo/source checkouts skip the download entirely (workspace install).
  // npm/ sits three levels below the repo root.
  if (existsSync(join(here, '..', '..', '..', 'pnpm-workspace.yaml'))) process.exit(0);
  if (process.env.CLOUD_CODE_SKIP_POSTINSTALL === '1') process.exit(0);
  const name = assetName(process.platform, process.arch);
  if (name === null) {
    console.error(`cloudcode-cli: unsupported platform ${process.platform}/${process.arch}; install from source or use WSL.`);
    process.exit(0); // don't break installs on odd platforms
  }
  const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const base = releaseBaseUrl(version);
  const target = join(outDir, process.platform === 'win32' ? 'cloudcode.exe' : 'cloudcode');
  if (existsSync(target)) process.exit(0);
  // Downloads land beside the target and are only promoted once verified: a
  // rejected payload must never survive at the path bin.mjs execs, and the
  // presence check above would otherwise treat it as a finished install.
  const staging = `${target}.download`;

  try {
    mkdirSync(outDir, { recursive: true });
    const sums = await download(`${base}/${SUMS_NAME}`);
    const signature = await download(`${base}/${SUMS_SIGNATURE_NAME}`);
    const verdict = verifyMinisignSignature(Buffer.from(sums, 'utf8'), signature);
    if (!verdict.ok) {
      throw new Error(`cloudcode-cli: ${SUMS_NAME} failed signature verification (${verdict.reason})`);
    }
    const expected = findSha256Entry(sums, name);
    if (expected === undefined) throw new Error(`cloudcode-cli: ${name} not found in ${SUMS_NAME} (${base})`);

    await download(`${base}/${name}`, staging);
    const actual = createHash('sha256').update(readFileSync(staging)).digest('hex');
    if (actual !== expected) throw new Error(`cloudcode-cli: sha256 mismatch for ${name} (got ${actual})`);
    chmodSync(staging, 0o755);
    renameSync(staging, target);
    console.log(`cloudcode-cli: installed ${name} (signature verified).`);
  } catch (error) {
    rmSync(staging, { force: true });
    // Best-effort: never fail the surrounding install. The bin launcher
    // re-runs this script on first use, so a transient failure (offline,
    // release still building) self-heals later with a clear message.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cloudcode-cli: postinstall could not fetch the runtime binary (${message}); it will be fetched on first run.`);
    process.exit(0);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`cloudcode-cli: postinstall failed: ${error.message}`);
    console.error('You can install manually from https://github.com/cloud-teahouse/cloud-code/releases');
    process.exit(1);
  });
}
