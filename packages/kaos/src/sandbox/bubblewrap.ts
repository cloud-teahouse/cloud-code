/**
 * bubblewrap (bwrap) sandbox backend — Linux only.
 *
 * `buildCommand` mirrors the flag construction of codex
 * `linux-sandbox/src/bwrap.rs`, reduced to Cloud Code's baseline policy:
 * read-only root bind + writable roots + `/tmp` + configurable network +
 * deny-read masks. Mount order matters (see codex bwrap.rs:353-366):
 *
 *   1. `--ro-bind / /` then `--dev /dev` (minimal writable device tree).
 *   2. `--bind <root> <root>` per writable root, shallowest first, so a
 *      nested writable child is mounted after (and wins over) its parent.
 *   3. `--ro-bind <sub> <sub>` re-applies read-only subpaths under the
 *      writable roots — only wins because it comes after step 2.
 *   4. deny-read masks last (`--tmpfs` for directories,
 *      `--ro-bind /dev/null` for files) so they also win over writable binds.
 *
 * Namespace flags go after the mounts and before `--`; `--chdir` uses the
 * canonical cwd because symlink aliases can disappear inside the sandbox
 * when only canonical roots are mounted (bwrap.rs:333-340).
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';

import type {
  SandboxBackend,
  SandboxExecRequest,
  SandboxProbeResult,
} from './types';

const DEFAULT_BWRAP_PATH = 'bwrap';
const PROBE_TIMEOUT_MS = 5_000;
const SMOKE_TIMEOUT_MS = 10_000;

export interface BubblewrapBackendOptions {
  /** Path to (or name of) the bwrap binary. Defaults to `bwrap` on PATH. */
  readonly bwrapPath?: string;
}

export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';

  private readonly bwrapPath: string;

  constructor(options: BubblewrapBackendOptions = {}) {
    this.bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  }

  /**
   * Probe availability. Checking that the binary exists is not enough:
   * Debian's `kernel.unprivileged_userns_clone=0` and Ubuntu 23.10+'s
   * AppArmor bwrap restrictions leave a perfectly healthy binary that fails
   * at namespace setup, so the probe runs a real smoke sandbox
   * (`bwrap --ro-bind / / -- true`) and reports its failure reason.
   */
  async probe(): Promise<SandboxProbeResult> {
    if (process.platform !== 'linux') {
      return {
        available: false,
        reason: `bubblewrap requires Linux (current platform: ${process.platform})`,
      };
    }

    const versionResult = await runCapturing([this.bwrapPath, '--version'], PROBE_TIMEOUT_MS);
    if (versionResult.kind === 'error') {
      return {
        available: false,
        reason: `failed to execute ${this.bwrapPath}: ${versionResult.message}`,
      };
    }
    if (versionResult.exitCode !== 0) {
      return {
        available: false,
        reason: `\`${this.bwrapPath} --version\` exited with code ${String(versionResult.exitCode)}: ${versionResult.stderr.trim()}`,
      };
    }
    const version = /^bubblewrap\s+(\S+)/m.exec(versionResult.stdout)?.[1];

    const smoke = await runCapturing(
      [this.bwrapPath, '--ro-bind', '/', '/', '--', 'true'],
      SMOKE_TIMEOUT_MS,
    );
    if (smoke.kind === 'error') {
      return { available: false, reason: `bwrap smoke run failed: ${smoke.message}` };
    }
    if (smoke.exitCode !== 0) {
      const detail = smoke.stderr.trim();
      return {
        available: false,
        reason:
          `bwrap smoke run exited with code ${String(smoke.exitCode)}` +
          (detail.length > 0 ? `: ${detail}` : '') +
          ' (user namespaces may be disabled by sysctl or AppArmor)',
      };
    }

    return { available: true, ...(version !== undefined ? { version } : {}) };
  }

  /**
   * Wrap `req.argv` in a bwrap invocation implementing `req.policy`.
   * Pure with respect to the produced argv: it only reads the filesystem to
   * canonicalize paths and to drop mounts whose targets do not exist
   * (bubblewrap requires bind targets to exist — codex skips them the same
   * way, bwrap.rs:373-380).
   */
  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
    const { policy } = req;

    const writableRoots = canonicalizeExisting(policy.writableRoots);
    // Shallowest first: a nested writable root must be mounted after its
    // parent so the child mount wins (bwrap applies mounts in order).
    writableRoots.sort(compareByDepthThenPath);

    const readOnlySubpaths = canonicalizeExisting(policy.readOnlySubpaths ?? []);
    const denyReadMasks = buildDenyReadMasks(policy.denyReadPaths ?? []);

    const argv: string[] = [
      this.bwrapPath,
      '--new-session',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
    ];
    for (const root of writableRoots) {
      argv.push('--bind', root, root);
    }
    for (const sub of readOnlySubpaths) {
      argv.push('--ro-bind', sub, sub);
    }
    for (const mask of denyReadMasks) {
      argv.push(...mask);
    }
    argv.push('--unshare-user', '--unshare-pid');
    if (policy.network === 'deny') {
      argv.push('--unshare-net');
    }
    argv.push('--proc', '/proc');
    argv.push('--chdir', canonicalizePath(req.cwd));
    argv.push('--', ...req.argv);

    // bwrap does not touch the environment; pass it through unchanged.
    return { argv, env: { ...req.env } };
  }
}

type ProbeRunResult =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'exit'; readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function runCapturing(argv: readonly string[], timeoutMs: number): Promise<ProbeRunResult> {
  const command = argv[0];
  if (command === undefined) {
    return Promise.resolve({ kind: 'error', message: 'empty argv' });
  }
  let child;
  try {
    child = spawn(command, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Not detached: the probe is short-lived and must never outlive us.
      detached: false,
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({ kind: 'error', message: describeError(error) });
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const exitPromise = new Promise<ProbeRunResult>((resolve) => {
    child.once('error', (error) => {
      resolve({ kind: 'error', message: describeError(error) });
    });
    child.once('close', (code) => {
      resolve({
        kind: 'exit',
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ProbeRunResult>((resolve) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ kind: 'error', message: `timed out after ${String(timeoutMs)}ms` });
    }, timeoutMs);
  });

  return Promise.race([exitPromise, timeoutPromise]).then((result) => {
    if (timer !== undefined) clearTimeout(timer);
    return result;
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Best-effort canonical path; falls back to the input when it cannot be resolved. */
function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Canonicalize and keep only paths that currently exist. bwrap refuses to
 * start when a bind target is missing, so mixed-environment configs may
 * list roots that only exist on some machines.
 */
function canonicalizeExisting(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const canonical = canonicalizePath(path);
    if (seen.has(canonical)) continue;
    if (!existsSync(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function pathDepth(path: string): number {
  return path.split('/').filter((segment) => segment.length > 0).length;
}

function compareByDepthThenPath(a: string, b: string): number {
  const depthDelta = pathDepth(a) - pathDepth(b);
  return depthDelta !== 0 ? depthDelta : a.localeCompare(b);
}

/**
 * Map deny-read paths to mask mounts: directories get a tmpfs overlay,
 * files get `/dev/null` bound over them. Non-existent paths are skipped
 * (they are unreadable by definition; masking the nearest existing ancestor
 * is deliberately left out of the Phase-2 scope).
 */
function buildDenyReadMasks(paths: readonly string[]): string[][] {
  const masks: string[][] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const canonical = canonicalizePath(path);
    if (seen.has(canonical)) continue;
    let stats;
    try {
      stats = statSync(canonical);
    } catch {
      continue;
    }
    seen.add(canonical);
    masks.push(stats.isDirectory() ? ['--tmpfs', canonical] : ['--ro-bind', '/dev/null', canonical]);
  }
  return masks;
}
