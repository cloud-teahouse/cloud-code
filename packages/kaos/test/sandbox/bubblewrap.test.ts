import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BubblewrapBackend } from '#/sandbox/bubblewrap';
import type { SandboxPolicy } from '#/sandbox/types';

// argv construction is POSIX-shaped (`/`-separated mounts); skip on Windows
// like the rest of the local-execution suites.

describe.skipIf(process.platform === 'win32')('BubblewrapBackend.buildCommand', () => {
  let root: string;
  let workspace: string;
  const backend = new BubblewrapBackend({ bwrapPath: '/usr/bin/bwrap' });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-bwrap-argv-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function build(policy: Partial<SandboxPolicy> & Pick<SandboxPolicy, 'network'>) {
    return backend.buildCommand({
      argv: ['/bin/bash', '-c', 'echo hi'],
      cwd: workspace,
      env: { FOO: 'bar' },
      policy: { writableRoots: [workspace, '/tmp'], ...policy },
    });
  }

  it('wraps argv with the baseline read-only-root policy', () => {
    const { argv } = build({ network: 'allow' });
    expect(argv.slice(0, 7)).toEqual([
      '/usr/bin/bwrap',
      '--new-session',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--dev',
    ]);
    expect(argv.slice(-4)).toEqual(['--', '/bin/bash', '-c', 'echo hi']);
    expect(argv).toContain('--unshare-user');
    expect(argv).toContain('--unshare-pid');
    expect(argv).not.toContain('--unshare-net');
    // --proc /proc then --chdir <canonical cwd>, in that order.
    const procIdx = argv.indexOf('--proc');
    expect(argv[procIdx + 1]).toBe('/proc');
    const chdirIdx = argv.indexOf('--chdir');
    expect(chdirIdx).toBeGreaterThan(procIdx);
    expect(argv[chdirIdx + 1]).toBe(realpathSync(workspace));
  });

  it('adds --unshare-net when the policy denies network', () => {
    const { argv } = build({ network: 'deny' });
    const netIdx = argv.indexOf('--unshare-net');
    expect(netIdx).toBeGreaterThan(argv.indexOf('--unshare-pid'));
    expect(netIdx).toBeLessThan(argv.indexOf('--proc'));
  });

  it('binds writable roots shallowest-first so nested mounts win', () => {
    const nested = join(workspace, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const { argv } = build({ network: 'allow', writableRoots: [nested, workspace, '/tmp'] });
    const bindAt = (target: string) =>
      argv.findIndex((arg, i) => arg === '--bind' && argv[i + 1] === target && argv[i + 2] === target);
    const tmpIdx = bindAt(realpathSync('/tmp'));
    const wsIdx = bindAt(realpathSync(workspace));
    const nestedIdx = bindAt(realpathSync(nested));
    expect(tmpIdx).toBeGreaterThan(-1);
    expect(wsIdx).toBeGreaterThan(-1);
    expect(nestedIdx).toBeGreaterThan(-1);
    expect(tmpIdx).toBeLessThan(wsIdx);
    expect(wsIdx).toBeLessThan(nestedIdx);
  });

  it('re-applies read-only subpaths after the writable binds', () => {
    const gitdir = join(workspace, '.git');
    mkdirSync(gitdir);
    const { argv } = build({ network: 'allow', readOnlySubpaths: [gitdir] });
    const roIdx = argv.findIndex(
      (arg, i) => arg === '--ro-bind' && argv[i + 1] === gitdir && argv[i + 2] === gitdir,
    );
    const wsBindIdx = argv.findIndex((arg, i) => arg === '--bind' && argv[i + 1] === realpathSync(workspace));
    expect(roIdx).toBeGreaterThan(-1);
    expect(roIdx).toBeGreaterThan(wsBindIdx);
  });

  it('masks deny-read dirs with tmpfs and files with /dev/null, skipping missing paths', () => {
    const secretDir = join(root, 'secret-dir');
    mkdirSync(secretDir);
    const secretFile = join(root, 'secret-file');
    writeFileSync(secretFile, 'top secret');
    const missing = join(root, 'does-not-exist');
    const { argv } = build({
      network: 'allow',
      denyReadPaths: [secretDir, secretFile, missing],
    });
    const tmpfsIdx = argv.findIndex((arg, i) => arg === '--tmpfs' && argv[i + 1] === secretDir);
    expect(tmpfsIdx).toBeGreaterThan(-1);
    const nullIdx = argv.findIndex(
      (arg, i) => arg === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === secretFile,
    );
    expect(nullIdx).toBeGreaterThan(-1);
    expect(argv).not.toContain(missing);
    // Masks come after writable binds so they win over a writable parent.
    const wsBindIdx = argv.findIndex((arg) => arg === '--bind');
    expect(tmpfsIdx).toBeGreaterThan(wsBindIdx);
  });

  it('canonicalizes symlinked writable roots and cwd', () => {
    const alias = join(root, 'ws-alias');
    symlinkSync(workspace, alias);
    const { argv } = backend.buildCommand({
      argv: ['/bin/true'],
      cwd: alias,
      env: {},
      policy: { writableRoots: [alias, '/tmp'], network: 'allow' },
    });
    expect(argv).not.toContain(alias);
    expect(argv).toContain(realpathSync(workspace));
    const chdirIdx = argv.indexOf('--chdir');
    expect(argv[chdirIdx + 1]).toBe(realpathSync(workspace));
  });

  it('skips writable roots that do not exist', () => {
    const { argv } = build({ network: 'allow', writableRoots: [join(root, 'nope'), '/tmp'] });
    expect(argv).not.toContain(join(root, 'nope'));
  });

  it('deduplicates roots that canonicalize to the same target', () => {
    const alias = join(root, 'ws-alias-2');
    symlinkSync(workspace, alias);
    const { argv } = build({ network: 'allow', writableRoots: [workspace, alias] });
    const canonical = realpathSync(workspace);
    const binds = argv.filter(
      (arg, i) => arg === canonical && argv[i - 1] === '--bind',
    );
    expect(binds).toHaveLength(1);
  });

  it('passes the environment through as a copy', () => {
    const env = { FOO: 'bar' };
    const { env: wrapped } = backend.buildCommand({
      argv: ['/bin/true'],
      cwd: workspace,
      env,
      policy: { writableRoots: [workspace], network: 'allow' },
    });
    expect(wrapped).toEqual(env);
    expect(wrapped).not.toBe(env);
  });
});
