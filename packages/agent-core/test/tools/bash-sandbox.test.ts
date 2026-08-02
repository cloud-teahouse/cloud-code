/**
 * F1 sandbox escalation chain (mocked): a sandboxed run that fails with a
 * denial signature asks `requestEscalation`; on approval the command
 * re-runs once through the original undecorated kaos with an output marker.
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@cloud-code/kaos';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BashTool, type BashSandboxOptions } from '../../src/tools/builtin/shell/bash';
import { ensureBashParser } from '../../src/tools/support/shell-ast/parser';
import { createBackgroundManager } from '../agent/background/helpers';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const DENIAL_STDERR = "touch: cannot touch '/etc/x': Read-only file system";
const RETRY_STDOUT = 'ran-fine-unsandboxed';

function scriptedProcess(options: {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly exitCode: number;
}): KaosProcess {
  // wait() resolves only after both streams have been fully consumed, so
  // task output is complete before the settlement/early-exit paths read it.
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  const stderr = Readable.from(options.stderr === undefined ? [] : [options.stderr]);
  const drained = Promise.all([
    new Promise((resolve) => stdout.once('end', resolve)),
    new Promise((resolve) => stderr.once('end', resolve)),
  ]);
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 321,
    exitCode: options.exitCode,
    wait: vi.fn(async () => {
      await drained;
      return options.exitCode;
    }),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

interface Fixture {
  readonly tool: BashTool;
  readonly sandboxedKaos: ReturnType<typeof createFakeKaos>;
  readonly unsandboxedKaos: ReturnType<typeof createFakeKaos>;
  readonly requestEscalation: ReturnType<typeof vi.fn>;
  readonly sandboxedExec: ReturnType<typeof vi.fn>;
  readonly unsandboxedExec: ReturnType<typeof vi.fn>;
}

function fixture(options: {
  readonly firstProcess?: () => KaosProcess;
  readonly retryProcess?: () => KaosProcess;
  readonly sandbox?: Partial<BashSandboxOptions>;
} = {}): Fixture {
  const sandboxedProcs = new Set<KaosProcess>();
  const firstFactory =
    options.firstProcess ?? (() => scriptedProcess({ stderr: DENIAL_STDERR, exitCode: 1 }));
  const retryFactory =
    options.retryProcess ?? (() => scriptedProcess({ stdout: RETRY_STDOUT, exitCode: 0 }));

  const sandboxedExec = vi.fn(async () => {
    const proc = firstFactory();
    sandboxedProcs.add(proc);
    return proc;
  });
  const unsandboxedExec = vi.fn(async () => retryFactory());

  const sandboxedKaos = createFakeKaos({ execWithEnv: sandboxedExec });
  const unsandboxedKaos = createFakeKaos({ execWithEnv: unsandboxedExec });
  const effectiveEscalation =
    options.sandbox?.requestEscalation ?? vi.fn(async () => 'once' as const);

  const tool = new BashTool(sandboxedKaos, '/workspace', createBackgroundManager().manager, {
    sandbox: {
      unsandboxedKaos,
      escalation: 'ask',
      requestEscalation: effectiveEscalation,
      wasSandboxed: (proc) => sandboxedProcs.has(proc),
      ...options.sandbox,
    },
  });
  return {
    tool,
    sandboxedKaos,
    unsandboxedKaos,
    requestEscalation: effectiveEscalation as ReturnType<typeof vi.fn>,
    sandboxedExec,
    unsandboxedExec,
  };
}

function context(command: string, extra: Record<string, unknown> = {}) {
  return {
    turnId: '0',
    toolCallId: 'call_bash',
    args: { command, ...extra },
    signal: new AbortController().signal,
  };
}

describe('BashTool sandbox escalation', () => {
  beforeAll(async () => {
    await ensureBashParser();
  });

  it('retries once through the undecorated kaos after an approved denial', async () => {
    const f = fixture();
    const result = await executeTool(f.tool, context('touch /etc/x'));

    expect(f.requestEscalation).toHaveBeenCalledTimes(1);
    expect(f.requestEscalation.mock.calls[0]?.[0]).toMatchObject({
      command: 'touch /etc/x',
      toolCallId: 'call_bash',
    });
    expect(f.sandboxedExec).toHaveBeenCalledTimes(1);
    expect(f.unsandboxedExec).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('ran without sandbox after approval');
    expect(result.output).toContain(RETRY_STDOUT);
  });

  it('returns the original failure when the human rejects escalation', async () => {
    const f = fixture({ sandbox: { requestEscalation: vi.fn(async () => 'reject' as const) } });
    const result = await executeTool(f.tool, context('touch /etc/x'));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Read-only file system');
    expect(result.output).not.toContain('ran without sandbox after approval');
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
  });

  it('remembers session approvals by full command string', async () => {
    const f = fixture({ sandbox: { requestEscalation: vi.fn(async () => 'session' as const) } });

    const first = await executeTool(f.tool, context('touch /etc/x'));
    const second = await executeTool(f.tool, context('touch /etc/x'));

    // The second identical call re-runs the sandbox attempt, then retries
    // unsandboxed WITHOUT asking again.
    expect(f.requestEscalation).toHaveBeenCalledTimes(1);
    expect(f.sandboxedExec).toHaveBeenCalledTimes(2);
    expect(f.unsandboxedExec).toHaveBeenCalledTimes(2);
    expect(first.output).toContain('ran without sandbox after approval');
    expect(second.output).toContain('ran without sandbox after approval');

    // A different command is not covered by the session exemption.
    await executeTool(f.tool, context('touch /etc/y'));
    expect(f.requestEscalation).toHaveBeenCalledTimes(2);
  });

  it('never escalates when escalation is "never"', async () => {
    const f = fixture({ sandbox: { escalation: 'never' } });
    const result = await executeTool(f.tool, context('touch /etc/x'));

    expect(result.isError).toBe(true);
    expect(f.requestEscalation).not.toHaveBeenCalled();
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
  });

  it('retries without asking when escalation is "always"', async () => {
    const f = fixture({ sandbox: { escalation: 'always' } });
    const result = await executeTool(f.tool, context('touch /etc/x'));

    expect(f.requestEscalation).not.toHaveBeenCalled();
    expect(f.unsandboxedExec).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('ran without sandbox after approval');
  });

  it('does not escalate runs that were not actually sandboxed', async () => {
    // wasSandboxed reports false: the command ran unsandboxed already
    // (auto-fallback), so a denial-looking failure must NOT re-run the
    // command — under escalation "always" that would silently double-run
    // side effects.
    const f = fixture({
      sandbox: { escalation: 'always', wasSandboxed: () => false },
    });
    const result = await executeTool(f.tool, context('touch /etc/x'));

    expect(result.isError).toBe(true);
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
    expect(result.output).not.toContain('ran without sandbox after approval');
  });

  it('ignores failures that do not match the denial heuristic', async () => {
    const f = fixture({
      firstProcess: () => scriptedProcess({ stderr: 'bash: syntax error', exitCode: 2 }),
    });
    const result = await executeTool(f.tool, context('if then'));

    expect(result.isError).toBe(true);
    expect(f.requestEscalation).not.toHaveBeenCalled();
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
  });

  it('fails closed when the environment cannot be sandboxed (enforce)', async () => {
    const f = fixture({ sandbox: { unavailableReason: 'sandbox.mode is "enforce" but kaos is not local' } });
    const result = await executeTool(f.tool, context('echo hi'));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('sandbox.mode is "enforce"');
    expect(f.sandboxedExec).not.toHaveBeenCalled();
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
  });

  it('escalates a background command that dies with a denial right after start', async () => {
    const f = fixture();
    const result = await executeTool(
      f.tool,
      context('touch /etc/x', { run_in_background: true, description: 'denied bg' }),
    );

    expect(f.requestEscalation).toHaveBeenCalledTimes(1);
    expect(f.unsandboxedExec).toHaveBeenCalledTimes(1);
    // The retry starts a fresh background task through the raw kaos and its
    // result carries the marker.
    expect(result.output).toContain('ran without sandbox after approval');
    expect(result.output).toContain('task_id:');
    expect(result.isError).toBe(false);
  });

  it('returns an error for a rejected background denial instead of retrying', async () => {
    const f = fixture({ sandbox: { requestEscalation: vi.fn(async () => 'reject' as const) } });
    const result = await executeTool(
      f.tool,
      context('touch /etc/x', { run_in_background: true, description: 'denied bg' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('was not approved');
    expect(f.unsandboxedExec).not.toHaveBeenCalled();
  });
});
