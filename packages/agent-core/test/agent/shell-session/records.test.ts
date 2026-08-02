/**
 * ShellSessionManager lifecycle wire records (RFC `docs/rfc/unified-exec-pty.md`
 * §3.5 v2): `shell_session.start` on registration, `shell_session.exit` on
 * natural exit and on manager reclamation (idle reaper / LRU eviction) —
 * exactly one exit record per session.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ShellSessionManager,
  type ShellSessionRecord,
} from '../../../src/agent/shell-session';
import { createBackgroundManager } from '../background/helpers';
import { fakePtyProcess, waitUntil } from './helpers';

function createManager() {
  const bg = createBackgroundManager();
  const records: ShellSessionRecord[] = [];
  const manager = new ShellSessionManager(
    bg.manager,
    () => ({}),
    (record) => {
      records.push(record);
    },
  );
  return { bg, manager, records };
}

function exitRecords(records: readonly ShellSessionRecord[]) {
  return records.filter((record) => record.type === 'shell_session.exit');
}

describe('shell_session lifecycle records', () => {
  it('logs shell_session.start on registration', () => {
    const { manager, records } = createManager();
    const fake = fakePtyProcess();
    const { sessionId } = manager.createSession({
      proc: fake.proc,
      command: 'bash',
      description: 'Session: bash',
    });

    expect(records).toEqual([
      { type: 'shell_session.start', sessionId, command: 'bash', pid: fake.proc.pid },
    ]);
    fake.exit(0);
  });

  it('logs shell_session.exit with the exit code on natural exit', async () => {
    const { manager, records } = createManager();
    const fake = fakePtyProcess();
    const { sessionId } = manager.createSession({
      proc: fake.proc,
      command: 'python3',
      description: 'Session: python3',
    });

    fake.exit(3);
    await waitUntil(
      () => exitRecords(records).length === 1,
      5_000,
      'shell_session.exit after natural exit',
    );
    expect(exitRecords(records)).toEqual([
      { type: 'shell_session.exit', sessionId, command: 'python3', exitCode: 3 },
    ]);
    expect(records.map((record) => record.type)).toEqual([
      'shell_session.start',
      'shell_session.exit',
    ]);
  });

  it('logs exactly one exit record (null exitCode + reason) when reclaimed', async () => {
    const { manager, records } = createManager();
    const fake = fakePtyProcess();
    const { sessionId } = manager.createSession({
      proc: fake.proc,
      command: 'bash',
      description: 'Session: bash',
    });

    const reason = 'idle timeout: no interaction for 1s';
    const destroyed = manager.destroySession(sessionId, reason);
    // The record is written before the stop path settles.
    expect(exitRecords(records)).toEqual([
      { type: 'shell_session.exit', sessionId, command: 'bash', exitCode: null, reason },
    ]);

    // The kill landing afterwards must not produce a second record: the id is
    // already out of the registry, so handleExit no-ops.
    fake.exit(143);
    await destroyed;
    expect(exitRecords(records)).toHaveLength(1);
  });

  it('runs without a record sink (detached/test managers)', async () => {
    const bg = createBackgroundManager();
    const manager = new ShellSessionManager(bg.manager);
    const fake = fakePtyProcess();
    const { sessionId } = manager.createSession({
      proc: fake.proc,
      command: 'bash',
      description: 'Session: bash',
    });
    fake.exit(0);
    await waitUntil(() => !manager.has(sessionId), 5_000, 'session removal after exit');
    expect(manager.size).toBe(0);
  });
});
