import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalKaos } from '#/local';
import type { Kaos } from '#/kaos';
import { SandboxManager } from '#/sandbox/manager';
import { SandboxedKaos } from '#/sandbox/sandboxed-kaos';
import type {
  SandboxBackend,
  SandboxExecRequest,
  SandboxProbeResult,
} from '#/sandbox/types';

class FakeBackend implements SandboxBackend {
  readonly name: string;
  probeCalls = 0;
  readonly requests: SandboxExecRequest[] = [];

  constructor(
    private readonly probeResult: SandboxProbeResult,
    name = 'fake',
  ) {
    this.name = name;
  }

  probe(): Promise<SandboxProbeResult> {
    this.probeCalls += 1;
    return Promise.resolve(this.probeResult);
  }

  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
    this.requests.push(req);
    return { argv: [...req.argv], env: { ...req.env } };
  }
}

const available: SandboxProbeResult = { available: true, version: '0.0.test' };
const unavailable: SandboxProbeResult = { available: false, reason: 'user namespaces disabled' };

describe('SandboxManager.resolvePlan', () => {
  const input = {
    mode: 'auto' as const,
    network: 'allow' as const,
    workspaceCwd: '/work',
    kaosName: 'local',
  };

  it('short-circuits to unsandboxed for mode=off without probing', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const plan = await manager.resolvePlan({ ...input, mode: 'off' });
    expect(plan.kind).toBe('unsandboxed');
    expect(backend.probeCalls).toBe(0);
  });

  it('resolves sandboxed with workspace and /tmp writable plus default deny list', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const plan = await manager.resolvePlan({
      ...input,
      writableRoots: ['/data'],
      denyReadPaths: ['~/custom-secret'],
    });
    expect(plan.kind).toBe('sandboxed');
    if (plan.kind !== 'sandboxed') return;
    expect(plan.backend).toBe(backend);
    expect(plan.policy.writableRoots).toEqual(['/work', '/tmp', '/data']);
    expect(plan.policy.network).toBe('allow');
    // `~` expands against the current user's home for both default and
    // user-supplied deny-read entries.
    expect(plan.policy.denyReadPaths).toContain(join(homedir(), '.ssh'));
    expect(plan.policy.denyReadPaths).toContain(join(homedir(), 'custom-secret'));
  });

  it('caches the probe across resolvePlan calls', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    await manager.resolvePlan(input);
    await manager.resolvePlan({ ...input, network: 'deny' });
    expect(backend.probeCalls).toBe(1);
  });

  it('tries backends in order and reports why none are available', async () => {
    const first = new FakeBackend(unavailable, 'first');
    const second = new FakeBackend({ available: false, reason: 'not linux' }, 'second');
    const manager = new SandboxManager({ backends: [first, second] });
    const plan = await manager.resolvePlan(input);
    expect(plan.kind).toBe('unsandboxed');
    if (plan.kind !== 'unsandboxed') return;
    expect(plan.reason).toContain('first: user namespaces disabled');
    expect(plan.reason).toContain('second: not linux');
  });

  it('falls back to the second backend when the first is unavailable', async () => {
    const first = new FakeBackend(unavailable, 'first');
    const second = new FakeBackend(available, 'second');
    const manager = new SandboxManager({ backends: [first, second] });
    const plan = await manager.resolvePlan(input);
    expect(plan.kind).toBe('sandboxed');
    if (plan.kind === 'sandboxed') expect(plan.backend).toBe(second);
  });

  it('resolves unsandboxed for a non-local kaos without probing', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const plan = await manager.resolvePlan({ ...input, kaosName: 'ssh:example' });
    expect(plan.kind).toBe('unsandboxed');
    if (plan.kind === 'unsandboxed') expect(plan.reason).toContain('ssh:example');
    expect(backend.probeCalls).toBe(0);
  });

  it('turns a throwing probe into an unavailable result', async () => {
    const backend = new FakeBackend(available);
    backend.probe = () => Promise.reject(new Error('probe exploded'));
    const manager = new SandboxManager({ backends: [backend] });
    const plan = await manager.resolvePlan(input);
    expect(plan.kind).toBe('unsandboxed');
    if (plan.kind === 'unsandboxed') expect(plan.reason).toContain('probe exploded');
  });

  it('warns once per key', () => {
    const onWarning = vi.fn();
    const manager = new SandboxManager({ backends: [], onWarning });
    manager.warnOnce('k', 'first');
    manager.warnOnce('k', 'second');
    manager.warnOnce('other', 'third');
    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenNthCalledWith(1, 'first');
    expect(onWarning).toHaveBeenNthCalledWith(2, 'third');
  });
});

describe('SandboxManager.inspect', () => {
  const input = {
    mode: 'auto' as const,
    network: 'allow' as const,
    workspaceCwd: '/work',
    kaosName: 'local',
  };

  it('reports backend name, version, and effective policy for a sandboxed plan', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const inspection = await manager.inspect({ ...input, writableRoots: ['/data'] });
    expect(inspection.plan).toEqual({ kind: 'sandboxed', backend: 'fake' });
    expect(inspection.backends).toEqual([{ name: 'fake', available: true, version: '0.0.test' }]);
    expect(inspection.policy.writableRoots).toEqual(['/work', '/tmp', '/data']);
    expect(inspection.policy.network).toBe('allow');
  });

  it('surfaces the probe failure reason when no backend is available', async () => {
    const backend = new FakeBackend(unavailable);
    const manager = new SandboxManager({ backends: [backend] });
    const inspection = await manager.inspect(input);
    expect(inspection.backends).toEqual([
      { name: 'fake', available: false, reason: 'user namespaces disabled' },
    ]);
    expect(inspection.plan.kind).toBe('unsandboxed');
    if (inspection.plan.kind !== 'unsandboxed') return;
    expect(inspection.plan.reason).toContain('fake: user namespaces disabled');
  });

  it('probes even when mode is off, which resolvePlan short-circuits', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const inspection = await manager.inspect({ ...input, mode: 'off' });
    expect(backend.probeCalls).toBe(1);
    expect(inspection.backends[0]?.available).toBe(true);
    expect(inspection.plan).toEqual({ kind: 'unsandboxed', reason: 'sandbox mode is off' });
    // The would-be policy is still derived so the status view can show it.
    expect(inspection.policy.writableRoots).toContain('/work');
  });

  it('probes for a non-local environment even though the plan cannot sandbox', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const inspection = await manager.inspect({ ...input, kaosName: 'ssh:example' });
    expect(backend.probeCalls).toBe(1);
    expect(inspection.plan.kind).toBe('unsandboxed');
  });

  it('shares the probe cache with resolvePlan', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    await manager.inspect(input);
    await manager.resolvePlan(input);
    await manager.inspect(input);
    expect(backend.probeCalls).toBe(1);
  });
});

describe('SandboxedKaos', () => {
  let root: string;
  let inner: LocalKaos;
  const planBase = {
    network: 'allow' as const,
    workspaceCwd: '/work',
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-sandboxed-')));
    inner = (await LocalKaos.create()).withCwd(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects non-local kaos at construction time', () => {
    const manager = new SandboxManager({ backends: [] });
    const fakeSsh = { name: 'ssh:example' } as unknown as Kaos;
    expect(() => new SandboxedKaos(fakeSsh, manager, { ...planBase, mode: 'auto' })).toThrow(
      /only accepts a local Kaos/,
    );
  });

  it('routes exec through the backend when the plan is sandboxed', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    const proc = await kaos.exec('echo', 'hello');
    expect(await proc.wait()).toBe(0);
    expect(kaos.wasSandboxed(proc)).toBe(true);
    expect(backend.requests).toHaveLength(1);
    const req = backend.requests[0]!;
    expect(req.argv).toEqual(['echo', 'hello']);
    expect(req.cwd).toBe(inner.getcwd());
    expect(req.policy.writableRoots).toContain('/work');
    expect(req.policy.writableRoots).toContain('/tmp');
  });

  it('passes through with one warning when auto and no backend is available', async () => {
    const backend = new FakeBackend(unavailable);
    const onWarning = vi.fn();
    const manager = new SandboxManager({ backends: [backend], onWarning });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    const first = await kaos.exec('echo', 'a');
    const second = await kaos.exec('echo', 'b');
    expect(await first.wait()).toBe(0);
    expect(await second.wait()).toBe(0);
    // Passthrough runs are not marked sandboxed, and the fallback warning is
    // emitted once per session (manager-scoped), not per exec.
    expect(kaos.wasSandboxed(first)).toBe(false);
    expect(kaos.wasSandboxed(second)).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toContain('user namespaces disabled');
    expect(backend.requests).toHaveLength(0);
  });

  it('fails closed when enforce and no backend is available', async () => {
    const backend = new FakeBackend(unavailable);
    const manager = new SandboxManager({ backends: [backend] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'enforce' });
    await expect(kaos.exec('echo', 'hi')).rejects.toThrow(/Refusing to run unsandboxed/);
    await expect(kaos.execWithEnv(['echo', 'hi'])).rejects.toThrow(/sandbox\.mode/);
  });

  it('keeps the decoration across withCwd/withEnv and delegates file operations', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' })
      .withEnv({ EXTRA: '1' })
      .withCwd(root);

    await kaos.writeText(join(root, 'file.txt'), 'content');
    expect(await kaos.readText(join(root, 'file.txt'))).toBe('content');

    const proc = await kaos.execWithEnv(['printenv', 'EXTRA']);
    expect(await proc.wait()).toBe(0);
    expect(kaos.wasSandboxed(proc)).toBe(true);
    expect(backend.requests).toHaveLength(1);
  });

  it('tracks derived-instance processes on the root wasSandboxed (production wiring)', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const rootKaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    // Production wiring (agent-core tool/index.ts): tools spawn through a
    // derived instance while the escalation-detection closure queries the
    // ROOT instance. A per-instance tracking set makes every derived
    // process invisible to the root and the ExecSession sandbox-escalation
    // chain dead — the shared set must span all derivations.
    const proc = await rootKaos.withCwd(root).withEnv({ EXTRA: '1' }).exec('echo', 'hi');
    expect(await proc.wait()).toBe(0);
    expect(rootKaos.wasSandboxed(proc)).toBe(true);

    // Unsandboxed passthrough runs are still not marked, even on the root.
    const noBackend = new SandboxManager({ backends: [new FakeBackend(unavailable)] });
    const plainKaos = new SandboxedKaos(inner, noBackend, { ...planBase, mode: 'auto' });
    const plain = await plainKaos.withCwd(root).exec('echo', 'hi');
    expect(await plain.wait()).toBe(0);
    expect(plainKaos.wasSandboxed(plain)).toBe(false);
  });

  it('preserves inherited-environment semantics when execWithEnv omits env', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    // `env` omitted: the inner kaos must receive `undefined` (inherit +
    // layers), not an empty record that would strip the environment.
    const proc = await kaos.execWithEnv(['printenv', 'PATH']);
    expect(await proc.wait()).toBe(0);
  });
});
