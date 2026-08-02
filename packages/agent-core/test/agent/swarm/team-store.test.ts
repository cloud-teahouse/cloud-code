import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { TeamStore } from '../../../src/agent/swarm/team-store';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createStore(): Promise<{ store: TeamStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-team-store-'));
  tempDirs.push(dir);
  return { store: new TeamStore(dir), dir };
}

describe('TeamStore', () => {
  it('creates a team file once and keeps it idempotent', async () => {
    const { store } = await createStore();

    const created = await store.ensureTeam('core', 'main');
    expect(created).toMatchObject({ name: 'core', createdBy: 'main', nextTaskId: 1, tasks: [] });

    const again = await store.ensureTeam('core', 'agent-9');
    expect(again.createdBy).toBe('main');
    expect(again.createdAt).toBe(created.createdAt);
  });

  it('rejects team names that cannot be a file name', async () => {
    const { store } = await createStore();
    await expect(store.ensureTeam('../escape', 'main')).rejects.toThrow('Invalid team name');
    await expect(store.ensureTeam('bad name', 'main')).rejects.toThrow('Invalid team name');
  });

  it('assigns monotonically increasing task ids that survive a restart', async () => {
    const { store, dir } = await createStore();

    const first = await store.createTask('core', { subject: 'first', createdBy: 'leader' });
    const second = await store.createTask('core', {
      subject: 'second',
      description: 'spec',
      owner: 'researcher',
      createdBy: 'leader',
    });
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(second).toMatchObject({ status: 'pending', owner: 'researcher', description: 'spec' });

    // A fresh store over the same directory (a CLI restart) sees the same
    // team state, and id allocation continues without reuse.
    const reopened = new TeamStore(dir);
    expect(await reopened.listTasks('core')).toHaveLength(2);
    const third = await reopened.createTask('core', { subject: 'third', createdBy: 'leader' });
    expect(third.id).toBe(3);
  });

  it('returns undefined for unknown teams and tasks', async () => {
    const { store } = await createStore();
    expect(await store.getTeam('missing')).toBeUndefined();
    expect(await store.listTasks('missing')).toBeUndefined();
    expect(await store.updateTask('missing', 1, { status: 'completed' })).toBeUndefined();
    expect(await store.claimNextTask('missing', 'researcher')).toBeUndefined();
  });

  it('lists every team in the session', async () => {
    const { store } = await createStore();
    await store.ensureTeam('alpha', 'main');
    await store.ensureTeam('beta', 'main');
    const teams = await store.listTeams();
    expect(teams.map((team) => team.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('updates tasks and persists the transition', async () => {
    const { store, dir } = await createStore();
    const task = await store.createTask('core', { subject: 'work', createdBy: 'leader' });

    const updated = await store.updateTask('core', task.id, {
      status: 'completed',
      owner: 'researcher',
    });
    expect(updated).toMatchObject({ id: task.id, status: 'completed', owner: 'researcher' });

    const reopened = new TeamStore(dir);
    expect(await reopened.getTask('core', task.id)).toMatchObject({
      status: 'completed',
      owner: 'researcher',
    });
  });

  it('claims the oldest pending unowned task and marks it in_progress', async () => {
    const { store } = await createStore();
    await store.createTask('core', { subject: 'assigned', owner: 'writer', createdBy: 'leader' });
    const first = await store.createTask('core', { subject: 'oldest', createdBy: 'leader' });
    await store.createTask('core', { subject: 'newer', createdBy: 'leader' });

    const claimed = await store.claimNextTask('core', 'researcher');
    expect(claimed).toMatchObject({ id: first.id, status: 'in_progress', owner: 'researcher' });

    // The assigned task stays pending for its owner; the claimed one is gone
    // from the claimable pool.
    const remaining = await store.claimNextTask('core', 'writer');
    expect(remaining).toMatchObject({ subject: 'newer', owner: 'writer' });
    expect(await store.claimNextTask('core', 'third')).toBeUndefined();
  });

  it('clears an owner through the null sentinel and keeps it otherwise', async () => {
    const { store } = await createStore();
    const task = await store.createTask('core', {
      subject: 'work',
      owner: 'researcher',
      createdBy: 'leader',
    });

    // A status-only update leaves the assignment untouched.
    await store.updateTask('core', task.id, { status: 'in_progress' });
    expect(await store.getTask('core', task.id)).toMatchObject({ owner: 'researcher' });

    // null clears the owner, making the task claimable again.
    const cleared = await store.updateTask('core', task.id, { status: 'pending', owner: null });
    expect(cleared?.owner).toBeUndefined();
    const reclaimed = await store.claimNextTask('core', 'writer');
    expect(reclaimed).toMatchObject({ id: task.id, owner: 'writer' });
  });

  it('lets exactly one claimer win each task under concurrency', async () => {
    const { store } = await createStore();
    for (let i = 0; i < 3; i++) {
      await store.createTask('core', { subject: `task-${String(i)}`, createdBy: 'leader' });
    }

    // Five concurrent claimers for three tasks: every claim that succeeds
    // must hold a distinct task, and the two losers must see `undefined`.
    const claims = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((owner) => store.claimNextTask('core', owner)),
    );
    const won = claims.filter((task) => task !== undefined);
    const lost = claims.filter((task) => task === undefined);
    expect(won).toHaveLength(3);
    expect(lost).toHaveLength(2);
    expect(new Set(won.map((task) => task!.id)).size).toBe(3);
    for (const task of won) {
      expect(task!.status).toBe('in_progress');
    }

    // The on-disk state agrees: three owned tasks, zero claimable left.
    const tasks = await store.listTasks('core');
    expect(tasks?.filter((task) => task.status === 'in_progress')).toHaveLength(3);
    expect(await store.claimNextTask('core', 'late')).toBeUndefined();
  });

  it('serializes concurrent claims for the SAME single task', async () => {
    const { store } = await createStore();
    await store.createTask('core', { subject: 'only-task', createdBy: 'leader' });

    const [first, second] = await Promise.all([
      store.claimNextTask('core', 'alice'),
      store.claimNextTask('core', 'bob'),
    ]);
    const winners = [first, second].filter((task) => task !== undefined);
    expect(winners).toHaveLength(1);

    const task = await store.getTask('core', 1);
    expect(task?.status).toBe('in_progress');
    expect([first?.owner, second?.owner]).toContain(task?.owner);
  });

  it('keeps serving a team after one of its writes fails', async () => {
    const { store } = await createStore();
    await store.createTask('core', { subject: 'seed', createdBy: 'leader' });

    // One-shot disk failure on the next mutation: the failed claim must not
    // poison the team queue — later mutations proceed normally.
    const inner = (store as unknown as { store: { write: (id: string, value: unknown) => Promise<void> } }).store;
    const original = inner.write.bind(inner);
    inner.write = () => Promise.reject(new Error('disk full'));
    await expect(store.claimNextTask('core', 'alice')).rejects.toThrow('disk full');
    inner.write = original;

    const claimed = await store.claimNextTask('core', 'alice');
    expect(claimed).toMatchObject({ subject: 'seed', status: 'in_progress', owner: 'alice' });
  });
});
