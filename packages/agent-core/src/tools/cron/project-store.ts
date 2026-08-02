/**
 * Project-level durable cron task persistence.
 *
 * Complements the session-scoped per-id store (`persist.ts`): a task
 * created with `durable: true` lives in
 * `<projectDir>/.cloud-code/scheduled_tasks.json` so that ANY session
 * opened in the same project directory reloads it — including brand-new
 * sessions, which never see the session store. The file is the single
 * source of truth shared across concurrently-running sessions; the
 * cross-session firing guard lives in `lock.ts`.
 *
 * File format (mirrors Claude Code's `.claude/scheduled_tasks.json`):
 *
 *   { "tasks": [{ id, cron, prompt, createdAt, recurring?, lastFiredAt? }] }
 *
 * The runtime-only `durable` flag is stripped on write — every task in
 * this file is durable by definition, so a hand-edited entry needs no
 * flag. Readers re-attach `durable: true` when adopting tasks into the
 * in-memory store.
 *
 * Concurrency: all operations are serialized through an internal promise
 * chain, so callers observe their own earlier writes (a `list()` issued
 * after an `add()` always sees the added task). Across PROCESSES the
 * read-modify-write cycle is still racy (fresh read + atomic rename keeps
 * the window small); the scheduler lock — not this store — is what
 * prevents double-firing. Writes are crash-safe via `atomicWrite`.
 *
 * Local-workspace only: the manager gates construction on kaos being
 * local, because the sibling lock file's PID-liveness semantics are a
 * same-machine concept. Raw `node:fs` is used here (same precedent as
 * the session per-id store and `plugin/project-scope.ts`).
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite } from '../../utils/fs';
import { parseCronExpression } from './cron-expr';
import { isValidCronTask } from './persist';
import type { CronTask } from './types';

/** Project-local control-plane directory, shared with plugins.json / mcp.json. */
export const PROJECT_CRON_DIR = '.cloud-code';
export const PROJECT_CRON_FILE = 'scheduled_tasks.json';
export const PROJECT_CRON_LOCK_FILE = 'scheduled_tasks.lock';

export function projectCronFilePath(projectDir: string): string {
  return join(projectDir, PROJECT_CRON_DIR, PROJECT_CRON_FILE);
}

export function projectCronLockPath(projectDir: string): string {
  return join(projectDir, PROJECT_CRON_DIR, PROJECT_CRON_LOCK_FILE);
}

interface ProjectCronFile {
  readonly tasks?: unknown;
}

export interface ProjectCronStore {
  /** Project directory this store is bound to. */
  readonly projectDir: string;
  /**
   * Every task in the file, shape-guarded and cron-validated. Malformed
   * entries are silently dropped — a hand-edited file must not block the
   * whole schedule. Queued behind pending writes.
   */
  list(): Promise<readonly CronTask[]>;
  /**
   * Append `task` (read-modify-write). An existing entry with the same id
   * is replaced, so a colliding id can never duplicate a row. The
   * `durable` flag is stripped from the on-disk record.
   */
  add(task: CronTask): Promise<void>;
  /**
   * Delete the given ids (read-modify-write). Returns the subset that was
   * actually present — mirrors `SessionCronStore.remove`'s contract so
   * CronDelete can report no-ops honestly.
   */
  remove(ids: readonly string[]): Promise<readonly string[]>;
  /**
   * Stamp `lastFiredAt` on one task (read-modify-write). No-op when the
   * id is absent (e.g. another session deleted it between fire and
   * write-back).
   */
  markFired(id: string, lastFiredAt: number): Promise<void>;
  /**
   * File mtime in epoch ms, or `null` when the file does not exist. The
   * schedule owner's probe loop diffs this value to detect writes made
   * by other sessions.
   */
  statMtimeMs(): Promise<number | null>;
}

export function createProjectCronStore(projectDir: string): ProjectCronStore {
  const filePath = projectCronFilePath(projectDir);

  /**
   * Serialization chain. Every public op appends to it, so this process
   * never interleaves two read-modify-write cycles on the file.
   */
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  }

  async function readTasks(): Promise<CronTask[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      // Missing or unreadable file reads as an empty schedule.
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    const file = parsed as ProjectCronFile;
    if (!Array.isArray(file.tasks)) return [];

    const out: CronTask[] = [];
    for (const entry of file.tasks) {
      if (!isValidCronTask(entry)) continue;
      // Re-validate the cron expression on read (write validated it too):
      // a hand-edit must not smuggle a broken expression into the
      // scheduler's per-tick parse path.
      try {
        parseCronExpression(entry.cron);
      } catch {
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  async function writeTasks(tasks: readonly CronTask[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const body: { tasks: Array<Omit<CronTask, 'durable'>> } = {
      // Strip the runtime-only scope marker — everything on disk is
      // durable by definition.
      tasks: tasks.map(({ durable: _durable, ...rest }) => rest),
    };
    await atomicWrite(filePath, `${JSON.stringify(body, null, 2)}\n`);
  }

  return {
    projectDir,

    list(): Promise<readonly CronTask[]> {
      return enqueue(readTasks);
    },

    add(task: CronTask): Promise<void> {
      return enqueue(async () => {
        const tasks = await readTasks();
        const next = tasks.filter((t) => t.id !== task.id);
        next.push(task);
        await writeTasks(next);
      });
    },

    remove(ids: readonly string[]): Promise<readonly string[]> {
      return enqueue(async () => {
        if (ids.length === 0) return [];
        const idSet = new Set(ids);
        const tasks = await readTasks();
        const removed = tasks.filter((t) => idSet.has(t.id)).map((t) => t.id);
        if (removed.length === 0) return [];
        await writeTasks(tasks.filter((t) => !idSet.has(t.id)));
        return removed;
      });
    },

    markFired(id: string, lastFiredAt: number): Promise<void> {
      return enqueue(async () => {
        const tasks = await readTasks();
        let changed = false;
        const next = tasks.map((t) => {
          if (t.id !== id) return t;
          changed = true;
          return { ...t, lastFiredAt };
        });
        if (changed) {
          await writeTasks(next);
        }
      });
    },

    async statMtimeMs(): Promise<number | null> {
      try {
        const info = await stat(filePath);
        return info.mtimeMs;
      } catch {
        return null;
      }
    },
  };
}
