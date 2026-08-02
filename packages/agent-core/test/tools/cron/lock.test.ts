/**
 * Tests for `tools/cron/lock.ts` — the cross-session scheduler lock
 * guarding `.cloud-code/scheduled_tasks.json` against double-firing.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  releaseProjectCronLock,
  tryAcquireProjectCronLock,
} from '../../../src/tools/cron/lock';
import { projectCronLockPath } from '../../../src/tools/cron/project-store';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'cloud-code-cron-lock-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

/**
 * A PID that cannot be alive: above every mainstream OS's pid_max
 * (Linux defaults to 2^22). Used to fabricate stale locks.
 */
const DEAD_PID = 999_999_999;

async function writeLock(record: unknown): Promise<void> {
  const path = projectCronLockPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record), 'utf-8');
}

async function readLockFile(): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(projectCronLockPath(projectDir), 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

describe('tryAcquireProjectCronLock', () => {
  it('creates the lock file (and parent dir) on first acquire', async () => {
    expect(await tryAcquireProjectCronLock(projectDir, 'session-a', NOW)).toBe(true);
    const record = await readLockFile();
    expect(record).toMatchObject({
      sessionId: 'session-a',
      pid: process.pid,
      acquiredAt: NOW,
    });
  });

  it('blocks a second session while the owner PID is alive', async () => {
    expect(await tryAcquireProjectCronLock(projectDir, 'session-a', NOW)).toBe(true);
    expect(await tryAcquireProjectCronLock(projectDir, 'session-b', NOW)).toBe(false);
    // The losing attempt must not disturb the owner's record.
    expect((await readLockFile())?.['sessionId']).toBe('session-a');
  });

  it('is idempotent for the same identity and refreshes the stored pid', async () => {
    await writeLock({ sessionId: 'session-a', pid: DEAD_PID, acquiredAt: NOW });
    // Same identity, current (live) pid: re-acquire succeeds and the
    // dead pid is replaced rather than treated as stale-and-stolen.
    expect(await tryAcquireProjectCronLock(projectDir, 'session-a', NOW + 1)).toBe(true);
    expect((await readLockFile())?.['pid']).toBe(process.pid);
  });

  it('recovers a stale lock (dead owner PID) for a different session', async () => {
    await writeLock({ sessionId: 'session-a', pid: DEAD_PID, acquiredAt: NOW });
    expect(await tryAcquireProjectCronLock(projectDir, 'session-b', NOW)).toBe(true);
    expect((await readLockFile())?.['sessionId']).toBe('session-b');
  });

  it('recovers a corrupt lock file', async () => {
    const lockPath = projectCronLockPath(projectDir);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '{ not json', 'utf-8');
    expect(await tryAcquireProjectCronLock(projectDir, 'session-b', NOW)).toBe(true);

    await writeLock({ sessionId: 123, pid: 'oops' });
    expect(await tryAcquireProjectCronLock(projectDir, 'session-c', NOW)).toBe(true);
  });

  it('exactly one racer wins concurrent acquisition', async () => {
    const results = await Promise.all([
      tryAcquireProjectCronLock(projectDir, 'session-a', NOW),
      tryAcquireProjectCronLock(projectDir, 'session-b', NOW),
      tryAcquireProjectCronLock(projectDir, 'session-c', NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('releaseProjectCronLock', () => {
  it('unlinks the lock when the caller owns it', async () => {
    expect(await tryAcquireProjectCronLock(projectDir, 'session-a', NOW)).toBe(true);
    await releaseProjectCronLock(projectDir, 'session-a');
    expect(await readLockFile()).toBeUndefined();
    // A new session can acquire immediately after a clean release.
    expect(await tryAcquireProjectCronLock(projectDir, 'session-b', NOW)).toBe(true);
  });

  it('never unlinks another session\'s lock', async () => {
    expect(await tryAcquireProjectCronLock(projectDir, 'session-a', NOW)).toBe(true);
    await releaseProjectCronLock(projectDir, 'session-b');
    expect((await readLockFile())?.['sessionId']).toBe('session-a');
  });

  it('is a no-op when no lock exists', async () => {
    await expect(
      releaseProjectCronLock(projectDir, 'session-a'),
    ).resolves.toBeUndefined();
  });
});
