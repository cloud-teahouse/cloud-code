/**
 * Cross-session scheduler lock for project-durable cron tasks.
 *
 * When multiple CLI sessions run in the same project directory, only one
 * may FIRE the tasks in `.cloud-code/scheduled_tasks.json` — otherwise
 * every session delivers the same cron prompt. The first session to
 * acquire `.cloud-code/scheduled_tasks.lock` owns the project schedule;
 * the others stay passive and re-probe periodically (see
 * `CronManager.probeProjectSchedule`). If the owner dies without
 * releasing, the lock goes stale (PID no longer running) and the next
 * probing session takes over, coalescing whatever fired-times passed
 * in between through the scheduler's normal `coalescedCount` path.
 *
 * Mechanics (mirrors Claude Code's `cronTasksLock.ts`):
 *
 *   - Acquire is an atomic O_EXCL (`wx`) create — the filesystem is the
 *     test-and-set, so two racing sessions can never both win.
 *   - Liveness is a PID probe (`process.kill(pid, 0)`). A lock whose
 *     owner PID is dead — or whose content is corrupt — is unlinked and
 *     acquisition retried once; only one racer wins the retry.
 *   - Re-acquire by the same identity is idempotent and refreshes the
 *     stored PID, so a resumed session (same identity, new process)
 *     keeps its schedule.
 *
 * The lock file carries `acquiredAt` for human debugging only; stale
 * detection deliberately keys off PID liveness, not wall-clock age.
 * This file is covered by the `no-date-now` test guard: callers pass
 * `nowMs` from `ClockSources.wallNow()` so bench / test clock injection
 * stays authoritative.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'pathe';

import { projectCronLockPath } from './project-store';

export interface ProjectCronLockRecord {
  /** Stable owner key — the owning session's homedir, or a random id. */
  readonly sessionId: string;
  /** PID of the owning process. The liveness signal. */
  readonly pid: number;
  /** Wall-clock ms at acquisition. Informational only. */
  readonly acquiredAt: number;
}

/**
 * PID liveness probe. `process.kill(pid, 0)` delivers no signal; it only
 * runs the error checking. EPERM means the process exists but is owned
 * by another user — still alive for our purposes. Non-integer or
 * non-positive PIDs are treated as dead so a corrupt lock goes stale
 * instead of blocking takeover forever.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isValidLockRecord(obj: unknown): obj is ProjectCronLockRecord {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['sessionId'] === 'string' &&
    typeof o['pid'] === 'number' &&
    typeof o['acquiredAt'] === 'number'
  );
}

async function readLock(projectDir: string): Promise<ProjectCronLockRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(projectCronLockPath(projectDir), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidLockRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attempt the atomic exclusive create. Returns `true` when the lock file
 * now holds `record`, `false` when another session's file already
 * exists. A missing `.cloud-code/` directory is created and the create
 * retried once — in steady state the directory already exists (the
 * tasks file lives there), so this path is hit at most once.
 */
async function tryCreateExclusive(
  projectDir: string,
  record: ProjectCronLockRecord,
): Promise<boolean> {
  const path = projectCronLockPath(projectDir);
  const body = JSON.stringify(record);
  try {
    await writeFile(path, body, { flag: 'wx' });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, body, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Try to acquire the project schedule lock for `identity`. Returns true
 * on success (this session owns the schedule), false when another LIVE
 * session holds it. Stale locks (dead PID, corrupt content) are
 * recovered in place: unlinked and recreated, with the O_EXCL create
 * arbitrating any takeover race.
 *
 * `nowMs` is stamped into `acquiredAt` — pass `ClockSources.wallNow()`
 * rather than reading the wall clock directly (see this file's header
 * and the no-date-now guard).
 */
export async function tryAcquireProjectCronLock(
  projectDir: string,
  identity: string,
  nowMs: number,
): Promise<boolean> {
  const record: ProjectCronLockRecord = {
    sessionId: identity,
    pid: process.pid,
    acquiredAt: nowMs,
  };

  if (await tryCreateExclusive(projectDir, record)) return true;

  const existing = await readLock(projectDir);

  // Already ours — idempotent re-acquire. The stored PID may belong to
  // an earlier process of the same session (resume spawns a new one);
  // refresh it so other sessions see a live PID and don't steal.
  if (existing !== undefined && existing.sessionId === identity) {
    if (existing.pid !== process.pid) {
      await writeFile(projectCronLockPath(projectDir), JSON.stringify(record), 'utf-8');
    }
    return true;
  }

  // Held by another session. Only a LIVE owner blocks us.
  if (existing !== undefined && isProcessAlive(existing.pid)) {
    return false;
  }

  // Stale or corrupt — unlink and retry the exclusive create once. If
  // two sessions race the recovery, only one's create succeeds.
  await unlink(projectCronLockPath(projectDir)).catch(() => {});
  return tryCreateExclusive(projectDir, record);
}

/**
 * Release the lock if — and only if — `identity` owns it. Never throws:
 * shutdown paths call this on a best-effort basis, and unlinking
 * another session's fresh lock would be worse than leaving our own
 * behind (a leftover lock goes stale and is recovered; a stolen one
 * double-fires).
 */
export async function releaseProjectCronLock(
  projectDir: string,
  identity: string,
): Promise<void> {
  const existing = await readLock(projectDir);
  if (existing === undefined || existing.sessionId !== identity) return;
  try {
    await unlink(projectCronLockPath(projectDir));
  } catch {
    // Already gone — nothing to release.
  }
}
