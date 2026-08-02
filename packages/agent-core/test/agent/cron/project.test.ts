/**
 * Project-durable cron end to end: `.cloud-code/scheduled_tasks.json`
 * persistence, startup reload, missed-fire coalesced catch-up, the
 * cross-session ownership guard, and the session/project listing split.
 *
 * All managers run with manual ticking (`pollIntervalMs: null`) and the
 * probe disabled (`projectProbeMs: null`) — tests drive `tick()` and
 * `probeProjectSchedule()` explicitly, mirroring the resume suite.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager, type CronManagerOptions } from '../../../src/agent/cron/manager';
import type {
  ExecutableToolErrorResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../src/loop/types';
import { CronCreateTool, type CronCreateInput } from '../../../src/tools/cron/cron-create';
import { CronDeleteTool } from '../../../src/tools/cron/cron-delete';
import { CronListTool } from '../../../src/tools/cron/cron-list';
import { createProjectCronStore } from '../../../src/tools/cron/project-store';
import {
  createAgentStub,
  createClocks,
  WALL_ANCHOR,
  type AgentStub,
  type ClockHarness,
} from './harness/stub';

let projectDir: string;
let sessionDir: string;

beforeEach(async () => {
  vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  projectDir = await mkdtemp(join(tmpdir(), 'cloud-code-cron-proj-'));
  sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-cron-sess-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(projectDir, { recursive: true, force: true });
  await rm(sessionDir, { recursive: true, force: true });
});

interface ManagerHarness {
  readonly stub: AgentStub;
  readonly clocks: ClockHarness;
  readonly manager: CronManager;
}

function makeManager(
  identity: string,
  opts: { wall?: number; homedir?: string } = {},
): ManagerHarness {
  const stub = createAgentStub({ homedir: opts.homedir });
  const clocks = createClocks(opts.wall);
  const managerOpts: CronManagerOptions = {
    clocks: clocks.clocks,
    pollIntervalMs: null,
    projectDir,
    projectLockIdentity: identity,
    projectProbeMs: null,
  };
  return { stub, clocks, manager: new CronManager(stub.agent, managerOpts) };
}

async function sessionMirrorIds(): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(sessionDir, 'cron'));
    return entries.filter((e) => e.endsWith('.json')).toSorted();
  } catch {
    return [];
  }
}

async function runTool(execution: ToolExecution): Promise<ExecutableToolResult> {
  if ((execution as RunnableToolExecution).execute === undefined) {
    return execution as ExecutableToolErrorResult;
  }
  return (execution as RunnableToolExecution).execute({
    turnId: 'test-turn',
    toolCallId: 'test-call',
    signal: new AbortController().signal,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('project-durable cron', () => {
  it('durable add writes the project file, adopts as owner, and skips the session mirror', async () => {
    const { manager } = makeManager('session-a', { homedir: sessionDir });

    const task = manager.addTask({
      cron: '*/5 * * * *',
      prompt: 'check',
      durable: true,
    });
    await manager.flushPersist();

    expect(manager.ownsProjectSchedule).toBe(true);
    // Adopted into the firing store with the durable marker.
    const inMemory = manager.store.get(task.id);
    expect(inMemory).toMatchObject({ id: task.id, durable: true });
    // On disk in the project file — NOT in the session mirror.
    const onDisk = await createProjectCronStore(projectDir).list();
    expect(onDisk.map((t) => t.id)).toEqual([task.id]);
    expect(await sessionMirrorIds()).toEqual([]);

    await manager.stop();
  });

  it('a new session reloads durable tasks on startup and coalesces missed fires into one delivery', async () => {
    // Session A: create a durable */5 task and exit.
    const a = makeManager('session-a');
    a.manager.addTask({ cron: '*/5 * * * *', prompt: 'check', durable: true });
    await a.manager.flushPersist();
    await a.manager.stop();

    // Session B (brand new, no resume): 23 minutes later — several
    // ideal fires passed while nobody was running.
    const b = makeManager('session-b', { wall: WALL_ANCHOR + 23 * 60_000 });
    await b.manager.projectReady;

    // Startup scan adopted the task with its original id.
    const tasks = b.manager.store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ durable: true, prompt: 'check' });
    expect(b.manager.ownsProjectSchedule).toBe(true);

    // First tick delivers exactly one fire with coalescedCount > 1.
    b.manager.tick();
    expect(b.stub.steerCalls).toHaveLength(1);
    const origin = b.stub.steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.coalescedCount).toBeGreaterThan(1);
    expect(origin.stale).toBe(false);

    await b.manager.stop();
  });

  it('a one-shot durable task whose fire time passed offline fires once on startup and is removed from the file', async () => {
    const a = makeManager('session-a');
    const task = a.manager.addTask({
      cron: '*/5 * * * *',
      prompt: 'remind once',
      recurring: false,
      durable: true,
    });
    await a.manager.flushPersist();
    await a.manager.stop();

    const b = makeManager('session-b', { wall: WALL_ANCHOR + 10 * 60_000 });
    await b.manager.projectReady;
    b.manager.tick();

    expect(b.stub.steerCalls).toHaveLength(1);
    const origin = b.stub.steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.recurring).toBe(false);
    expect(origin.coalescedCount).toBe(1);

    // One-shot cleanup propagated to the project file.
    await b.manager.flushPersist();
    expect(b.manager.store.list()).toEqual([]);
    expect(await createProjectCronStore(projectDir).list()).toEqual([]);
    expect(task.id).toMatch(/^[0-9a-f]{8}$/);

    await b.manager.stop();
  });

  it('a durable task fired before shutdown does not replay that fire in the next session', async () => {
    const a = makeManager('session-a');
    const task = a.manager.addTask({ cron: '*/5 * * * *', prompt: 'check', durable: true });
    await a.manager.flushPersist();

    // Fire the first ideal occurrence, persist the cursor, exit.
    a.clocks.advance(6 * 60_000);
    a.manager.tick();
    expect(a.stub.steerCalls).toHaveLength(1);
    await a.manager.flushPersist();
    await a.manager.stop();

    const onDisk = await createProjectCronStore(projectDir).list();
    expect(onDisk.find((t) => t.id === task.id)?.lastFiredAt).toBeTypeOf('number');

    // 23 minutes after creation: 5 ideal */5 fires total, session A
    // consumed 1, so B coalesces at most 4 — never a replay.
    const b = makeManager('session-b', { wall: WALL_ANCHOR + 23 * 60_000 });
    await b.manager.projectReady;
    b.manager.tick();

    expect(b.stub.steerCalls).toHaveLength(1);
    const origin = b.stub.steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.coalescedCount).toBeLessThanOrEqual(4);

    await b.manager.stop();
  });

  it('only the lock owner fires project tasks; takeover happens after the owner releases', async () => {
    // A owns the schedule (first to create a durable task).
    const a = makeManager('session-a');
    a.manager.addTask({ cron: '*/5 * * * *', prompt: 'check', durable: true });
    await a.manager.flushPersist();
    expect(a.manager.ownsProjectSchedule).toBe(true);

    // B starts while A is alive: sees the file, fails the claim, stays passive.
    const b = makeManager('session-b');
    await b.manager.projectReady;
    expect(b.manager.ownsProjectSchedule).toBe(false);
    expect(b.manager.store.list()).toEqual([]);

    // A due fire: only A delivers it.
    a.clocks.advance(6 * 60_000);
    b.clocks.advance(6 * 60_000);
    b.manager.tick();
    a.manager.tick();
    expect(b.stub.steerCalls).toHaveLength(0);
    expect(a.stub.steerCalls).toHaveLength(1);
    await a.manager.flushPersist();

    // A exits cleanly (releases the lock); B's probe takes over.
    await a.manager.stop();
    await b.manager.probeProjectSchedule();
    expect(b.manager.ownsProjectSchedule).toBe(true);
    expect(b.manager.store.list()).toHaveLength(1);

    // The next due fire is delivered by B, exactly once.
    b.clocks.advance(6 * 60_000);
    b.manager.tick();
    expect(b.stub.steerCalls).toHaveLength(1);
    expect(a.stub.steerCalls).toHaveLength(1);

    await b.manager.stop();
  });

  it('CronList marks session vs project tasks; a non-owner still lists project tasks from the file', async () => {
    const a = makeManager('session-a');
    a.manager.addTask({ cron: '*/5 * * * *', prompt: 'session task' });
    a.manager.addTask({ cron: '0 9 * * *', prompt: 'project task', durable: true });
    await a.manager.flushPersist();

    const listA = new CronListTool(a.manager);
    const outA = (await runTool(listA.resolveExecution({}))).output as string;
    expect(outA).toContain('cron_jobs: 2');
    // Records are separated by ---; match each task to its source.
    const projectRecord = outA.split('\n---\n').find((r) => r.includes('project task'));
    const sessionRecord = outA.split('\n---\n').find((r) => r.includes('session task'));
    expect(projectRecord).toContain('source: project');
    expect(sessionRecord).toContain('source: session');

    // B is a non-owner: the project task is merged in from the file,
    // the session task (A-private) stays invisible.
    const b = makeManager('session-b');
    await b.manager.projectReady;
    expect(b.manager.ownsProjectSchedule).toBe(false);

    const listB = new CronListTool(b.manager);
    const outB = (await runTool(listB.resolveExecution({}))).output as string;
    expect(outB).toContain('cron_jobs: 1');
    expect(outB).toContain('project task');
    expect(outB).toContain('source: project');
    expect(outB).not.toContain('session task');

    await a.manager.stop();
    await b.manager.stop();
  });

  it('CronDelete falls back to the project file for tasks the session never adopted', async () => {
    const a = makeManager('session-a');
    const task = a.manager.addTask({ cron: '0 9 * * *', prompt: 'project task', durable: true });
    await a.manager.flushPersist();

    const b = makeManager('session-b');
    await b.manager.projectReady;
    expect(b.manager.ownsProjectSchedule).toBe(false);

    // B deletes the project task straight from the shared file.
    const del = new CronDeleteTool(b.manager);
    const result = await runTool(del.resolveExecution({ id: task.id }));
    expect(result.isError ?? false).toBe(false);
    expect(result.output).toBe(`Deleted cron job ${task.id} (project schedule).`);
    expect(await createProjectCronStore(projectDir).list()).toEqual([]);

    // A's next probe observes the deletion and drops its in-memory copy.
    // (Sleep a few ms so the file mtime visibly moves past A's snapshot.)
    await sleep(5);
    expect(a.manager.store.list()).toHaveLength(1);
    await a.manager.probeProjectSchedule();
    expect(a.manager.store.list()).toEqual([]);

    // Deleting again is an honest not-found error.
    const again = await runTool(del.resolveExecution({ id: task.id }));
    expect(again.isError).toBe(true);

    await a.manager.stop();
    await b.manager.stop();
  });

  it('CronCreate durable: true writes the project file and reports durable + projectFile', async () => {
    const { manager } = makeManager('session-a');
    const tool = new CronCreateTool(manager);

    const input: CronCreateInput = {
      cron: '*/5 * * * *',
      prompt: 'check',
      recurring: true,
      durable: true,
    };
    const result = await runTool(tool.resolveExecution(input));
    expect(result.isError ?? false).toBe(false);
    const output = result.output as string;
    expect(output).toContain('durable: true');
    expect(output).toContain('projectFile: ');
    expect(output).toContain('.cloud-code/scheduled_tasks.json');

    await manager.flushPersist();
    expect(await createProjectCronStore(projectDir).list()).toHaveLength(1);

    await manager.stop();
  });

  it('CronCreate durable: true is rejected when the project layer is unavailable', async () => {
    // No projectDir and no local kaos on the stub → project cron disabled.
    const stub = createAgentStub();
    const manager = new CronManager(stub.agent, {
      clocks: createClocks().clocks,
      pollIntervalMs: null,
    });
    const tool = new CronCreateTool(manager);

    const input: CronCreateInput = {
      cron: '*/5 * * * *',
      prompt: 'check',
      recurring: true,
      durable: true,
    };
    const result = await runTool(tool.resolveExecution(input));
    expect(result.isError).toBe(true);
    expect(result.output as string).toContain('durable: true is unavailable');

    // Session-scoped creates still work in the same session.
    const ok = await runTool(
      tool.resolveExecution({ cron: '*/5 * * * *', prompt: 'check', recurring: true, durable: false }),
    );
    expect(ok.isError ?? false).toBe(false);
    expect(ok.output as string).toContain('durable: false');

    await manager.stop();
  });
});
