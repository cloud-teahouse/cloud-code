/**
 * Tests for `tools/cron/project-store.ts` — the whole-file
 * `.cloud-code/scheduled_tasks.json` store behind project-durable cron.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProjectCronStore,
  projectCronFilePath,
} from '../../../src/tools/cron/project-store';
import type { CronTask } from '../../../src/tools/cron/types';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'cloud-code-cron-project-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'deadbeef',
    cron: '*/5 * * * *',
    prompt: 'check the deploy',
    createdAt: 1_700_000_000_000,
    recurring: true,
    ...overrides,
  };
}

async function readRawFile(): Promise<unknown> {
  const raw = await readFile(projectCronFilePath(projectDir), 'utf-8');
  return JSON.parse(raw);
}

describe('ProjectCronStore', () => {
  it('list() returns [] when the file is missing', async () => {
    const store = createProjectCronStore(projectDir);
    expect(await store.list()).toEqual([]);
    expect(await store.statMtimeMs()).toBeNull();
  });

  it('add() creates the file in { tasks: [...] } shape and round-trips the task', async () => {
    const store = createProjectCronStore(projectDir);
    await store.add(task());

    const loaded = await store.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: 'deadbeef',
      cron: '*/5 * * * *',
      prompt: 'check the deploy',
      createdAt: 1_700_000_000_000,
      recurring: true,
    });
    expect(await store.statMtimeMs()).toBeTypeOf('number');
  });

  it('strips the runtime-only durable flag from the on-disk record', async () => {
    const store = createProjectCronStore(projectDir);
    await store.add(task({ durable: true }));

    const raw = (await readRawFile()) as { tasks: Array<Record<string, unknown>> };
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]).not.toHaveProperty('durable');
    expect(raw.tasks[0]?.['id']).toBe('deadbeef');
  });

  it('add() replaces an existing entry with the same id instead of duplicating it', async () => {
    const store = createProjectCronStore(projectDir);
    await store.add(task({ prompt: 'v1' }));
    await store.add(task({ prompt: 'v2' }));

    const loaded = await store.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.prompt).toBe('v2');
  });

  it('remove() deletes matching ids and reports what was actually present', async () => {
    const store = createProjectCronStore(projectDir);
    await store.add(task({ id: 'aaaaaaaa' }));
    await store.add(task({ id: 'bbbbbbbb' }));

    expect(await store.remove(['aaaaaaaa', 'cccccccc'])).toEqual(['aaaaaaaa']);
    const loaded = await store.list();
    expect(loaded.map((t) => t.id)).toEqual(['bbbbbbbb']);

    // Second removal of the same id is a no-op.
    expect(await store.remove(['aaaaaaaa'])).toEqual([]);
  });

  it('markFired() stamps lastFiredAt on the matching task only', async () => {
    const store = createProjectCronStore(projectDir);
    await store.add(task({ id: 'aaaaaaaa' }));
    await store.add(task({ id: 'bbbbbbbb' }));

    await store.markFired('aaaaaaaa', 1_700_000_300_000);
    const loaded = await store.list();
    expect(loaded.find((t) => t.id === 'aaaaaaaa')?.lastFiredAt).toBe(1_700_000_300_000);
    expect(loaded.find((t) => t.id === 'bbbbbbbb')?.lastFiredAt).toBeUndefined();

    // Unknown id is a no-op, not an error.
    await store.markFired('cccccccc', 123);
  });

  it('list() silently drops corrupt JSON, malformed entries, and invalid cron', async () => {
    const store = createProjectCronStore(projectDir);
    const filePath = projectCronFilePath(projectDir);
    await mkdir(dirname(filePath), { recursive: true });

    // Corrupt JSON → empty.
    await writeFile(filePath, '{ not json', 'utf-8');
    expect(await store.list()).toEqual([]);

    // Mixed bag: one valid, three broken entries.
    await writeFile(
      filePath,
      JSON.stringify({
        tasks: [
          task({ id: 'aaaaaaaa' }),
          { id: 'not-hex!!', cron: '*/5 * * * *', prompt: 'x', createdAt: 1 },
          { id: 'bbbbbbbb', cron: 'not a cron', prompt: 'x', createdAt: 1 },
          'garbage',
        ],
      }),
      'utf-8',
    );
    const loaded = await store.list();
    expect(loaded.map((t) => t.id)).toEqual(['aaaaaaaa']);
  });

  it('serializes concurrent writes: add → remove on the same id cannot race', async () => {
    const store = createProjectCronStore(projectDir);
    // Issue without awaiting: the internal queue must order them.
    const p1 = store.add(task({ id: 'aaaaaaaa' }));
    const p2 = store.remove(['aaaaaaaa']);
    const p3 = store.add(task({ id: 'bbbbbbbb' }));
    await Promise.all([p1, p2, p3]);

    const loaded = await store.list();
    expect(loaded.map((t) => t.id)).toEqual(['bbbbbbbb']);
  });
});
