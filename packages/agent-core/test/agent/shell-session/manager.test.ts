/**
 * ShellSessionManager: registry, LRU eviction, idle reclamation, per-session
 * mutex, exit tracking (last-poll exit code), and dead-id (resume) errors.
 * Processes are scripted fake PTY handles; the background manager is the
 * standard fake-agent fixture.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import { ShellSessionManager } from '../../../src/agent/shell-session';
import { createBackgroundManager } from '../background/helpers';
import { fakePtyProcess, rejectingPtyProcess, waitUntil } from './helpers';

function createManager(config: { maxSessions?: number; idleTimeoutS?: number } = {}) {
  const bg = createBackgroundManager();
  const manager = new ShellSessionManager(bg.manager, () => config);
  return { bg, manager };
}

function createSession(manager: ShellSessionManager, command = 'bash') {
  const fake = fakePtyProcess();
  const { sessionId } = manager.createSession({
    proc: fake.proc,
    command,
    description: `Session: ${command}`,
  });
  return { fake, sessionId };
}

describe('ShellSessionManager', () => {
  describe('interact', () => {
    it('writes chars and drains output produced since the last poll', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);

      const first = await manager.interact(sessionId, { chars: 'echo hi\n', yieldMs: 10 });
      expect(first.status).toBe('running');
      expect(first.sessionId).toBe(sessionId);
      expect(first.chunkId).toBe(`${sessionId}:1`);
      expect(fake.writeSpy).toHaveBeenCalledWith('echo hi\n');

      fake.emit('hi\n');
      const second = await manager.interact(sessionId, { yieldMs: 10 });
      expect(second.output).toBe('hi\n');
      expect(second.chunkId).toBe(`${sessionId}:2`);

      // Drain semantics: nothing new since the last poll.
      const third = await manager.interact(sessionId, { yieldMs: 10 });
      expect(third.output).toBe('');

      fake.exit(0);
    });

    it('resolves early when the process exits mid-poll and reports the exit code', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);

      const pending = manager.interact(sessionId, { yieldMs: 30_000 });
      fake.emit('last words\n');
      fake.exit(3);
      const poll = await pending;
      expect(poll.status).toBe('exited');
      expect(poll.exitCode).toBe(3);
      expect(poll.wallTimeMs).toBeLessThan(30_000);
    });

    it('aborting the wait returns interrupted output but keeps the session alive', async () => {
      const { manager } = createManager();
      const { sessionId } = createSession(manager);

      const controller = new AbortController();
      const pending = manager.interact(sessionId, { yieldMs: 30_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      const poll = await pending;
      expect(poll.interrupted).toBe(true);
      expect(manager.has(sessionId)).toBe(true);

      // The session still accepts input afterwards (turn-cancel parity).
      const next = await manager.interact(sessionId, { chars: 'echo ok\n', yieldMs: 10 });
      expect(next.status).toBe('running');
    });

    it('serializes concurrent interactions per session (mutex)', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);

      const [first, second] = await Promise.all([
        manager.interact(sessionId, { chars: 'a\n', yieldMs: 50 }),
        manager.interact(sessionId, { chars: 'b\n', yieldMs: 10 }),
      ]);
      // The 50ms call must complete before the 10ms one starts: chunk ids
      // are assigned inside the critical section and prove the order.
      expect(first.chunkId).toBe(`${sessionId}:1`);
      expect(second.chunkId).toBe(`${sessionId}:2`);
      expect(fake.writeSpy).toHaveBeenNthCalledWith(1, 'a\n');
      expect(fake.writeSpy).toHaveBeenNthCalledWith(2, 'b\n');
      fake.exit(0);
    });

    it('counts consecutive empty polls and resets on output or write', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);

      for (let i = 1; i <= 3; i++) {
        const poll = await manager.interact(sessionId, { yieldMs: 5 });
        expect(poll.consecutiveEmptyPolls).toBe(i);
      }
      fake.emit('something\n');
      const withOutput = await manager.interact(sessionId, { yieldMs: 5 });
      expect(withOutput.consecutiveEmptyPolls).toBe(0);

      const withWrite = await manager.interact(sessionId, { chars: 'x', yieldMs: 5 });
      expect(withWrite.consecutiveEmptyPolls).toBe(0);
      fake.exit(0);
    });
  });

  describe('exit tracking and dead ids', () => {
    it('keeps the exit code and final output for one last poll, then reports drained', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);

      fake.emit('final chunk\n');
      fake.exit(0);
      await waitUntil(() => !manager.has(sessionId), 5_000, 'session removal after exit');

      const last = await manager.interact(sessionId, { yieldMs: 10 });
      expect(last.status).toBe('exited');
      expect(last.exitCode).toBe(0);
      expect(last.output).toBe('final chunk\n');

      const drained = await manager.interact(sessionId, { yieldMs: 10 });
      expect(drained.status).toBe('exited');
      expect(drained.exitCode).toBe(0);
      expect(drained.output).toBe('');
    });

    it('unknown ids fail with a structured rebuild error (resume semantics)', async () => {
      const { manager } = createManager();
      await expect(manager.interact('pty-deadbeef', { yieldMs: 10 })).rejects.toThrow(
        /does not exist.*ExecSession/s,
      );
    });

    it('a fresh manager (post-restart) has an empty registry and dead ids error out', async () => {
      const first = createManager();
      const { fake, sessionId } = createSession(first.manager);
      expect(first.manager.has(sessionId)).toBe(true);
      fake.exit(0);

      // Simulate resume: a brand-new manager instance shares nothing.
      const second = createManager();
      expect(second.manager.size).toBe(0);
      await expect(second.manager.interact(sessionId, { yieldMs: 10 })).rejects.toThrow(
        /does not exist/,
      );
    });

    it('a rejected wait() (transport lost) still retires the session; the next poll reports exited', async () => {
      const { manager } = createManager();
      const fake = rejectingPtyProcess();
      const { sessionId } = manager.createSession({
        proc: fake.proc,
        command: 'bash',
        description: 'Session: bash',
      });

      fake.emit('partial\n');
      fake.drop(
        'SSH channel closed before the remote command reported an exit status; ' +
          'the connection was lost mid-session.',
      );
      // The task's catch path must still fire onExit — otherwise the session
      // stays "running" forever (and every poll resets its idle timer).
      await waitUntil(() => !manager.has(sessionId), 5_000, 'session removal after wait() rejection');

      const poll = await manager.interact(sessionId, { yieldMs: 10 });
      expect(poll.status).toBe('exited');
      // No remote exit status exists; the manager records the best-known code.
      expect(poll.exitCode).toBe(1);
      expect(poll.output).toBe('partial\n');
    });
  });

  describe('destroySession', () => {
    it('wakes an in-flight poll instead of letting it hang until the yield deadline', async () => {
      const { manager } = createManager();
      const { fake, sessionId } = createSession(manager);
      // Let the stop path's SIGTERM settle the task immediately (otherwise
      // destroySession waits out the 5s SIGKILL grace on the scripted fake).
      fake.killSpy.mockImplementation(async () => {
        fake.exit(0);
      });

      const pending = manager.interact(sessionId, { yieldMs: 30_000 });
      // Let the poll reach waitForYield before the teardown lands.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await manager.destroySession(sessionId, 'test teardown');

      const poll = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('in-flight poll was not woken by destroySession')), 2_000);
        }),
      ]);
      expect(poll.sessionId).toBe(sessionId);
      expect(fake.killSpy).toHaveBeenCalled();

      // The session left no exited record (destroyed, not exited): later
      // polls get the structured dead-id error.
      await expect(manager.interact(sessionId, { yieldMs: 10 })).rejects.toThrow(/does not exist/);
    });
  });

  describe('capacity: LRU eviction', () => {
    it('evicts the least-recently-used session past maxSessions', async () => {
      const { manager } = createManager({ maxSessions: 2 });
      const s1 = createSession(manager, 's1');
      const s2 = createSession(manager, 's2');
      const s3 = createSession(manager, 's3');

      await waitUntil(() => !manager.has(s1.sessionId), 5_000, 'LRU eviction of s1');
      expect(manager.has(s2.sessionId)).toBe(true);
      expect(manager.has(s3.sessionId)).toBe(true);
      expect(s1.fake.killSpy).toHaveBeenCalled();

      s2.fake.exit(0);
      s3.fake.exit(0);
    });

    it('interacting refreshes recency so another session is evicted', async () => {
      const { manager } = createManager({ maxSessions: 2 });
      const s1 = createSession(manager, 's1');
      const s2 = createSession(manager, 's2');

      // Refresh s1; s2 is now the least recently used.
      await manager.interact(s1.sessionId, { yieldMs: 5 });
      const s3 = createSession(manager, 's3');

      await waitUntil(() => !manager.has(s2.sessionId), 5_000, 'LRU eviction of s2');
      expect(manager.has(s1.sessionId)).toBe(true);
      expect(manager.has(s3.sessionId)).toBe(true);

      s1.fake.exit(0);
      s3.fake.exit(0);
    });
  });

  describe('idle reclamation', () => {
    it('stops a session with no interaction past idleTimeoutS', async () => {
      const { manager } = createManager({ idleTimeoutS: 1 });
      const { fake, sessionId } = createSession(manager);

      expect(manager.has(sessionId)).toBe(true);
      await waitUntil(() => !manager.has(sessionId), 5_000, 'idle reclamation');
      expect(fake.killSpy).toHaveBeenCalled();
    });

    it('interaction resets the idle clock', async () => {
      const { manager } = createManager({ idleTimeoutS: 1 });
      const { fake, sessionId } = createSession(manager);

      // Keep touching for longer than the timeout; the session must survive.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await manager.interact(sessionId, { yieldMs: 5 });
      }
      expect(manager.has(sessionId)).toBe(true);
      fake.exit(0);
    });
  });

  describe('ghost/lost reconcile coexistence', () => {
    it('a persisted still-running session reconciles to a lost ghost while the new registry rejects the id', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'shell-session-reconcile-'));
      try {
        // "First CLI process": session registered with persistence, then the
        // process vanishes without settling (no stop, no exit).
        const bgA = createBackgroundManager({ sessionDir });
        const managerA = new ShellSessionManager(bgA.manager);
        const { sessionId } = createSession(managerA);
        // Give the initial persistWriteQueue a tick to land on disk.
        await new Promise((resolve) => setTimeout(resolve, 20));

        // "Second CLI process": fresh managers over the same session dir.
        const bgB = createBackgroundManager({ sessionDir });
        await bgB.manager.loadFromDisk();
        await bgB.manager.reconcile();
        const ghost = bgB.manager.getTask(sessionId);
        expect(ghost?.status).toBe('lost');
        expect(ghost?.kind).toBe('pty-session');

        const managerB = new ShellSessionManager(bgB.manager);
        await expect(managerB.interact(sessionId, { yieldMs: 10 })).rejects.toThrow(
          /does not exist/,
        );
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    });
  });
});
