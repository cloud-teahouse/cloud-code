/**
 * buildSandboxStatus: the /sandbox snapshot assembled from the same inputs
 * AgentToolSet.resolveBashSandbox uses — mode/network/escalation defaults,
 * the effective policy, guard plan, backend probes, and the fail-closed
 * enforce-on-remote explanation. Backends are fakes; the kaos is a real
 * LocalKaos rooted in a temp workspace.
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalKaos,
  SandboxManager,
  type Kaos,
  type SandboxBackend,
  type SandboxExecRequest,
  type SandboxProbeResult,
} from '@cloud-code/kaos';

import { buildSandboxStatus, type SandboxStatusSource } from '../../src/agent/sandbox-status';

class FakeBackend implements SandboxBackend {
  readonly name = 'fake';

  constructor(private readonly probeResult: SandboxProbeResult) {}

  probe(): Promise<SandboxProbeResult> {
    return Promise.resolve(this.probeResult);
  }

  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
    return { argv: [...req.argv], env: { ...req.env } };
  }
}

const available: SandboxProbeResult = { available: true, version: '0.0.test' };
const unavailable: SandboxProbeResult = { available: false, reason: 'user namespaces disabled' };

describe('buildSandboxStatus', () => {
  let root: string;
  let brandHome: string;
  let kaos: LocalKaos;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-status-')));
    brandHome = join(root, 'brand-home');
    mkdirSync(brandHome);
    kaos = (await LocalKaos.create()).withCwd(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function source(overrides?: Partial<SandboxStatusSource>): SandboxStatusSource {
    return {
      sandboxConfig: undefined,
      kaos,
      homedir: brandHome,
      brandHomeDir: brandHome,
      skillRoots: [],
      manager: new SandboxManager({ backends: [new FakeBackend(available)] }),
      ...overrides,
    };
  }

  it('reports defaults with an available backend as sandboxed', async () => {
    const status = await buildSandboxStatus(source());

    expect(status.mode).toBe('auto');
    expect(status.configured).toBe(false);
    expect(status.environment).toBe('local');
    expect(status.local).toBe(true);
    expect(status.network).toBe('allow');
    expect(status.escalation).toBe('ask');
    expect(status.plan).toEqual({ kind: 'sandboxed', backend: 'fake' });
    expect(status.backends).toEqual([{ name: 'fake', available: true, version: '0.0.test' }]);
    expect(status.policy.writableRoots).toEqual([root, '/tmp']);
    // Built-in credential masks plus the brand home resolveBashSandbox adds.
    expect(status.policy.denyReadPaths).toContain(join(homedir(), '.ssh'));
    expect(status.policy.denyReadPaths).toContain(brandHome);
    // Guard: missing control-plane paths are scrub-watched; the existing
    // brand home is re-bound read-only.
    expect(status.guard.scrubPaths).toContain(join(root, '.cloud-code'));
    expect(status.guard.readOnlySubpaths).toContain(brandHome);
    expect(status.unavailableReason).toBeUndefined();
  });

  it('echoes the configured [sandbox] values into the effective policy', async () => {
    const status = await buildSandboxStatus(
      source({
        sandboxConfig: {
          mode: 'enforce',
          network: 'deny',
          writableRoots: ['/data'],
          denyRead: ['~/custom-secret'],
          escalation: 'never',
        },
      }),
    );

    expect(status.mode).toBe('enforce');
    expect(status.configured).toBe(true);
    expect(status.network).toBe('deny');
    expect(status.escalation).toBe('never');
    expect(status.configuredWritableRoots).toEqual(['/data']);
    expect(status.configuredDenyRead).toEqual(['~/custom-secret']);
    expect(status.policy.writableRoots).toEqual([root, '/tmp', '/data']);
    expect(status.policy.network).toBe('deny');
    expect(status.policy.denyReadPaths).toContain(join(homedir(), 'custom-secret'));
  });

  it('surfaces the probe failure and still derives the policy when the backend is missing', async () => {
    const status = await buildSandboxStatus(
      source({ manager: new SandboxManager({ backends: [new FakeBackend(unavailable)] }) }),
    );

    expect(status.backends).toEqual([
      { name: 'fake', available: false, reason: 'user namespaces disabled' },
    ]);
    expect(status.plan.kind).toBe('unsandboxed');
    if (status.plan.kind !== 'unsandboxed') return;
    expect(status.plan.reason).toContain('fake: user namespaces disabled');
    expect(status.policy.writableRoots).toContain(root);
  });

  it('fails closed with an explanation for enforce on a non-local environment', async () => {
    const sshKaos = {
      name: 'ssh:example',
      getcwd: () => '/work',
      gethome: () => '/home/u',
    } as unknown as Kaos;
    const status = await buildSandboxStatus(
      source({ kaos: sshKaos, sandboxConfig: { mode: 'enforce' } }),
    );

    expect(status.local).toBe(false);
    expect(status.plan.kind).toBe('unsandboxed');
    expect(status.unavailableReason).toContain('not local');
    expect(status.unavailableReason).toContain('ssh:example');
  });

  it('probes the backend even when the mode is off', async () => {
    const status = await buildSandboxStatus(source({ sandboxConfig: { mode: 'off' } }));

    expect(status.plan).toEqual({ kind: 'unsandboxed', reason: 'sandbox mode is off' });
    expect(status.backends).toEqual([{ name: 'fake', available: true, version: '0.0.test' }]);
  });
});
