/**
 * ExecSession / WriteStdin integration tests (real LocalKaos + node-pty,
 * POSIX-only) — RFC `docs/rfc/unified-exec-pty.md` §4 v1 acceptance items
 * 1/2/3/5/6 plus the sandbox escalation retry chain and the
 * `allowBackground` gate. Sandbox write-policy coverage lives in kaos's
 * `test/pty.test.ts` (real bwrap).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { LocalKaos, SandboxManager, SandboxedKaos } from '@cloud-code/kaos';
import type { SandboxBackend, SandboxExecRequest, SandboxProbeResult } from '@cloud-code/kaos';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ShellSessionManager } from '../../src/agent/shell-session';
import type { ExecutableToolResult } from '../../src/loop/types';
import { ExecSessionTool } from '../../src/tools/builtin/shell/exec-session';
import { WriteStdinTool } from '../../src/tools/builtin/shell/write-stdin';
import { ensureBashParser } from '../../src/tools/support/shell-ast/parser';
import { createBackgroundManager } from '../agent/background/helpers';
import { fakePtyProcess, waitUntil } from '../agent/shell-session/helpers';
import { createFakeKaos, toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const POSIX = process.platform !== 'win32';

interface Fixture {
  readonly shellSessions: ShellSessionManager;
  readonly bg: ReturnType<typeof createBackgroundManager>;
  readonly tool: ExecSessionTool;
  readonly writeTool: WriteStdinTool;
  readonly sessionDir?: string;
}

const fixtures: Fixture[] = [];

async function createFixture(options: { allowBackground?: boolean; sessionDir?: string } = {}): Promise<Fixture> {
  const kaos = await LocalKaos.create();
  const bg = createBackgroundManager(
    options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir },
  );
  const shellSessions = new ShellSessionManager(bg.manager);
  const tool = new ExecSessionTool(kaos, '/tmp', shellSessions, {
    allowBackground: options.allowBackground ?? true,
  });
  const writeTool = new WriteStdinTool(shellSessions);
  const fixture: Fixture = { shellSessions, bg, tool, writeTool, sessionDir: options.sessionDir };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.bg.manager.stopAll('test cleanup');
    if (f.sessionDir !== undefined) {
      // Pending output.log appends can lag task settlement; retry the rmdir.
      await rm(f.sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

function ctx(args: Record<string, unknown>, signal?: AbortSignal) {
  return {
    turnId: '0',
    toolCallId: 'call_session',
    args,
    signal: signal ?? new AbortController().signal,
  };
}

function text(result: ExecutableToolResult): string {
  return toolContentString(result);
}

function sessionIdOf(result: ExecutableToolResult): string {
  const match = /session_id: (pty-[0-9a-z]+)/.exec(text(result));
  if (match === null) throw new Error(`no session_id in result: ${text(result)}`);
  return match[1]!;
}

async function makeSessionDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'exec-session-test-'));
}

describe.skipIf(!POSIX)('ExecSessionTool + WriteStdinTool (real PTY)', () => {
  beforeAll(async () => {
    await ensureBashParser();
  });

  it('acceptance #1: shell state (cwd, env) persists across WriteStdin calls', async () => {
    const f = await createFixture();
    const start = await executeTool(f.tool, ctx({ command: 'bash', yield_time_ms: 250 }));
    expect(start.isError).toBe(false);
    const sessionId = sessionIdOf(start);

    await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: 'cd /tmp && export X=1\n', yield_time_ms: 500 }),
    );
    const check = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: 'pwd && echo VAL_$X\n', yield_time_ms: 2_000 }),
    );
    expect(text(check)).toContain('/tmp');
    expect(text(check)).toContain('VAL_1');

    // Session env keeps the PTY knobs (TERM=dumb / PAGER=cat).
    const env = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: 'echo T_$TERM P_$PAGER\n', yield_time_ms: 2_000 }),
    );
    expect(text(env)).toContain('T_dumb');
    expect(text(env)).toContain('P_cat');

    await executeTool(f.writeTool, ctx({ session_id: sessionId, chars: 'exit\n', yield_time_ms: 1_000 }));
  });

  it('acceptance #2: a python REPL can be driven and polled', async () => {
    const f = await createFixture();
    const start = await executeTool(f.tool, ctx({ command: 'python3 -q', yield_time_ms: 3_000 }));
    expect(start.isError).toBe(false);
    const sessionId = sessionIdOf(start);

    const answer = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '40+2\n', yield_time_ms: 3_000 }),
    );
    expect(text(answer)).toContain('42');

    await executeTool(f.writeTool, ctx({ session_id: sessionId, chars: 'exit()\n', yield_time_ms: 2_000 }));
  });

  it('acceptance #3: long-running process polled incrementally, Ctrl-C exits with notification', async () => {
    const f = await createFixture();
    const start = await executeTool(
      f.tool,
      ctx({
        command: 'i=0; while true; do echo tick-$i; i=$((i+1)); sleep 1; done',
        yield_time_ms: 250,
      }),
    );
    const sessionId = sessionIdOf(start);

    const pollA = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '', yield_time_ms: 5_000 }),
    );
    expect(text(pollA)).toContain('tick-');
    const pollB = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '', yield_time_ms: 5_000 }),
    );
    // Drain semantics: the second poll returns NEW ticks only.
    expect(text(pollB)).toContain('tick-');
    expect(text(pollB)).not.toBe(text(pollA));

    // Ctrl-C (\u0003) interrupts the loop; the session exits and the exit code
    // becomes visible.
    await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '\u0003', yield_time_ms: 2_000 }),
    );
    await waitUntil(() => !f.shellSessions.has(sessionId), 5_000, 'session exit after Ctrl-C');
    const final = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '', yield_time_ms: 5_000 }),
    );
    expect(text(final)).toContain('status: exited');
    expect(text(final)).toContain('exit_code:');

    // The background-task machinery delivered a terminal notification.
    await waitUntil(
      () => f.bg.agent.turn.steer.mock.calls.length > 0,
      5_000,
      'session exit notification',
    );
    const notified = f.bg.agent.turn.steer.mock.calls
      .map((call) =>
        (call[0] as readonly { type: string; text: string }[]).map((p) => p.text).join('\n'),
      )
      .join('\n');
    expect(notified).toContain('Shell session');
  }, 45_000);

  it('acceptance #5: an output bomb is head/tail-truncated, not 16MiB-killed, and fully logged', async () => {
    const sessionDir = await makeSessionDir();
    const f = await createFixture({ sessionDir });
    // Deterministic bomb: 20 MiB (past the 16 MiB one-shot ceiling) dumped in
    // one burst, then the session stays alive so we can observe it NOT being
    // killed by that ceiling.
    const start = await executeTool(
      f.tool,
      ctx({
        command: "head -c 20000000 /dev/zero | tr '\\0' 'y'; sleep 300",
        yield_time_ms: 250,
      }),
    );
    expect(start.isError).toBe(false);
    const sessionId = sessionIdOf(start);

    // Wait until the session has produced well past the 16 MiB one-shot
    // ceiling (bounded: the disk cap stops appends at 64 MiB anyway).
    const deadline = Date.now() + 20_000;
    let size = 0;
    while (size <= 16 * 1024 * 1024) {
      if (Date.now() > deadline) break;
      size = (await f.bg.manager.getOutputSnapshot(sessionId, 0)).outputSizeBytes;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(size).toBeGreaterThan(16 * 1024 * 1024);

    // The session is NOT killed by the one-shot output ceiling.
    expect(f.bg.manager.getTask(sessionId)?.status).toBe('running');
    expect(f.shellSessions.has(sessionId)).toBe(true);

    const poll = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '', yield_time_ms: 5_000 }),
    );
    // Context stays bounded and carries the head/tail omission marker.
    expect(text(poll).length).toBeLessThan(70_000);
    expect(text(poll)).toContain('omitted_bytes:');
    expect(text(poll)).toContain('bytes omitted');

    // The persisted log holds the full stream (past the old 16 MiB ceiling).
    const snapshot = await f.bg.manager.getOutputSnapshot(sessionId, 0);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBeGreaterThan(16 * 1024 * 1024);

    await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '\u0003', yield_time_ms: 2_000 }),
    );
  }, 45_000);

  it('turn cancellation aborts the poll but the session survives', async () => {
    const f = await createFixture();
    const start = await executeTool(f.tool, ctx({ command: 'bash', yield_time_ms: 250 }));
    const sessionId = sessionIdOf(start);

    const controller = new AbortController();
    const pending = executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: '', yield_time_ms: 30_000 }, controller.signal),
    );
    setTimeout(() => controller.abort(), 100);
    const interrupted = await pending;
    expect(text(interrupted)).toContain('interrupted: true');
    expect(f.shellSessions.has(sessionId)).toBe(true);

    const after = await executeTool(
      f.writeTool,
      ctx({ session_id: sessionId, chars: 'echo STILL_$((6*7))\n', yield_time_ms: 2_000 }),
    );
    expect(text(after)).toContain('STILL_42');

    await executeTool(f.writeTool, ctx({ session_id: sessionId, chars: 'exit\n', yield_time_ms: 1_000 }));
  });

  it('acceptance #6: WriteStdin on a dead/unknown id returns a structured error', async () => {
    const f = await createFixture();
    const result = await executeTool(
      f.writeTool,
      ctx({ session_id: 'pty-00000000', chars: '', yield_time_ms: 5_000 }),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not exist');
    expect(text(result)).toContain('ExecSession');
    // No live sessions in the task list either.
    expect(f.bg.manager.list(true).filter((t) => t.kind === 'pty-session')).toHaveLength(0);
  });

  it('allowBackground=false refuses to create sessions', async () => {
    const f = await createFixture({ allowBackground: false });
    const result = await executeTool(f.tool, ctx({ command: 'bash', yield_time_ms: 250 }));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not available for this agent');
  });
});

describe('ExecSessionTool sandbox escalation (mocked kaos)', () => {
  beforeAll(async () => {
    await ensureBashParser();
  });

  const DENIAL = "touch: cannot touch '/etc/x': Read-only file system";

  function escalationFixture(decision: 'once' | 'reject') {
    const bg = createBackgroundManager();
    const shellSessions = new ShellSessionManager(bg.manager);
    const denial = fakePtyProcess();
    const retry = fakePtyProcess();
    const sandboxedProcs = new Set<unknown>([denial.proc]);
    const sandboxedPtyExec = vi.fn(async () => {
      // The denial surfaces immediately after spawn, like a real bwrap refusal.
      setTimeout(() => {
        denial.emit(`${DENIAL}\n`);
        denial.exit(1);
      }, 0);
      return denial.proc;
    });
    const unsandboxedPtyExec = vi.fn(async () => retry.proc);
    const sandboxedKaos = createFakeKaos({ ptyExec: sandboxedPtyExec });
    const unsandboxedKaos = createFakeKaos({ ptyExec: unsandboxedPtyExec });
    const requestEscalation = vi.fn(async () => decision);
    const tool = new ExecSessionTool(sandboxedKaos, '/workspace', shellSessions, {
      sandbox: {
        unsandboxedKaos,
        escalation: 'ask',
        requestEscalation,
        wasSandboxed: (proc) => sandboxedProcs.has(proc),
      },
    });
    return { bg, shellSessions, tool, requestEscalation, unsandboxedPtyExec, retry };
  }

  it('an approved escalation re-creates the session unsandboxed with a marker', async () => {
    const f = escalationFixture('once');
    fixtures.push({
      shellSessions: f.shellSessions,
      bg: f.bg,
      tool: f.tool,
      writeTool: new WriteStdinTool(f.shellSessions),
    });
    const result = await executeTool(f.tool, ctx({ command: 'touch /etc/x', yield_time_ms: 250 }));
    expect(f.requestEscalation).toHaveBeenCalledOnce();
    expect(f.unsandboxedPtyExec).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('[sandbox: session ran without sandbox after approval]');
    expect(text(result)).toContain('session_id: pty-');
    f.retry.exit(0);
  });

  it('a rejected escalation returns the denial output as an error', async () => {
    const f = escalationFixture('reject');
    fixtures.push({
      shellSessions: f.shellSessions,
      bg: f.bg,
      tool: f.tool,
      writeTool: new WriteStdinTool(f.shellSessions),
    });
    const result = await executeTool(f.tool, ctx({ command: 'touch /etc/x', yield_time_ms: 250 }));
    expect(f.requestEscalation).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not approved');
    expect(text(result)).toContain(DENIAL);
  });
});

describe('ExecSessionTool sandbox escalation (real SandboxedKaos wiring)', () => {
  beforeAll(async () => {
    await ensureBashParser();
  });

  const DENIAL = "touch: cannot touch '/etc/x': Read-only file system";

  /** Backend stub: probes available and runs the argv verbatim (no bwrap). */
  class PassThroughBackend implements SandboxBackend {
    readonly name = 'pass-through';
    probe(): Promise<SandboxProbeResult> {
      return Promise.resolve({ available: true, version: '0.0.test' });
    }
    buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
      return { argv: [...req.argv], env: { ...req.env } };
    }
  }

  it('recognizes a sandbox denial spawned through a withCwd-derived kaos and escalates', async () => {
    const bg = createBackgroundManager();
    const shellSessions = new ShellSessionManager(bg.manager);
    const denial = fakePtyProcess();
    const retry = fakePtyProcess();
    const innerLocal = createFakeKaos({
      name: 'local',
      ptyExec: vi.fn(async () => {
        // The denial surfaces immediately after spawn, like a real bwrap refusal.
        setTimeout(() => {
          denial.emit(`${DENIAL}\n`);
          denial.exit(1);
        }, 0);
        return denial.proc;
      }),
    });
    const unsandboxedKaos = createFakeKaos({ ptyExec: vi.fn(async () => retry.proc) });
    const sandboxManager = new SandboxManager({ backends: [new PassThroughBackend()] });
    const sandboxedKaos = new SandboxedKaos(innerLocal, sandboxManager, {
      mode: 'auto',
      network: 'allow',
      workspaceCwd: '/workspace',
    });
    const requestEscalation = vi.fn(async () => 'once' as const);
    const tool = new ExecSessionTool(sandboxedKaos, '/workspace', shellSessions, {
      sandbox: {
        unsandboxedKaos,
        escalation: 'ask',
        requestEscalation,
        // Bound to the ROOT instance, exactly like agent/tool/index.ts —
        // while the tool spawns through `sandboxedKaos.withCwd(effectiveCwd)`.
        // A per-instance tracking set makes this closure always return false
        // and the whole escalation chain dead code.
        wasSandboxed: (proc) => sandboxedKaos.wasSandboxed(proc),
      },
    });
    fixtures.push({
      shellSessions,
      bg,
      tool,
      writeTool: new WriteStdinTool(shellSessions),
    });

    const result = await executeTool(tool, ctx({ command: 'touch /etc/x', yield_time_ms: 250 }));

    expect(requestEscalation).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('[sandbox: session ran without sandbox after approval]');
    expect(text(result)).toContain('session_id: pty-');
    retry.exit(0);
  });
});
