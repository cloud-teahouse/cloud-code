import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTeammateContext,
  runWithTeammateContext,
  type TeammateContext,
} from '../../src/agent/swarm/teammate-context';
import { TeamStore } from '../../src/agent/swarm/team-store';
import { TeamTaskClaimTool } from '../../src/tools/builtin/collaboration/team-task-claim';
import { TeamTaskCreateTool } from '../../src/tools/builtin/collaboration/team-task-create';
import { TeamTaskListTool } from '../../src/tools/builtin/collaboration/team-task-list';
import { TeamTaskUpdateTool } from '../../src/tools/builtin/collaboration/team-task-update';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly dir: string;
  readonly store: TeamStore;
  readonly create: TeamTaskCreateTool;
  readonly list: TeamTaskListTool;
  readonly update: TeamTaskUpdateTool;
  readonly claim: TeamTaskClaimTool;
}

async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-team-task-tools-'));
  tempDirs.push(dir);
  const store = new TeamStore(dir);
  return {
    dir,
    store,
    create: new TeamTaskCreateTool(store),
    list: new TeamTaskListTool(store),
    update: new TeamTaskUpdateTool(store),
    claim: new TeamTaskClaimTool(store),
  };
}

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_team_task', args, signal };
}

function teammate(name: string, teamName?: string): TeammateContext {
  return createTeammateContext({
    agentId: `agent-${name}`,
    parentAgentId: 'main',
    name,
    teamName,
    abortController: new AbortController(),
  });
}

async function inTeammate<T>(ctx: TeammateContext, fn: () => Promise<T>): Promise<T> {
  return runWithTeammateContext(ctx, fn);
}

describe('TeamTaskCreate', () => {
  it('creates a claimable task for the leader with an explicit team', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.create,
      context({ team_name: 'core', subject: 'Map the ingestion surface' }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('task_id: 1');
    expect(result.output).toContain('status: pending');
    expect(result.output).toContain('created_by: leader');
    expect(result.output).not.toContain('owner: researcher');
    expect(result.display).toEqual({
      key: 'toolResult.teamTask.created',
      params: { id: 1, team: 'core', subject: 'Map the ingestion surface' },
    });
  });

  it('creates an assigned task and defaults the team from the teammate context', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.create,
      context({ team_name: 'core', subject: 'Owned track', owner: 'researcher', description: 'spec' }),
    );
    expect(result.output).toContain('owner: researcher');
    expect(result.output).toContain('description: spec');

    const listed = await inTeammate(teammate('researcher', 'core'), () =>
      executeTool(fixture.list, context({})),
    );
    expect(listed.output).toContain('Owned track');
  });

  it('requires a team when the caller has no team context', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.create, context({ subject: 'orphan' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('team_name is required');
    expect(result.display).toEqual({ key: 'toolResult.team.teamNameRequired' });
  });

  it('rejects invalid team names', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.create,
      context({ team_name: 'bad name', subject: 'x' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Invalid team name');
    expect(result.display).toEqual({
      key: 'toolResult.team.teamNameInvalid',
      params: { team: 'bad name' },
    });
  });
});

describe('TeamTaskList', () => {
  it('renders status counts and task records', async () => {
    const fixture = await createFixture();
    await fixture.store.createTask('core', { subject: 'one', createdBy: 'leader' });
    await fixture.store.createTask('core', { subject: 'two', owner: 'writer', createdBy: 'leader' });

    const result = await executeTool(fixture.list, context({ team_name: 'core' }));
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('pending: 2, in_progress: 0, completed: 0');
    expect(result.output).toContain('subject: one');
    expect(result.output).toContain('owner: writer');
  });

  it('reports a missing team', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.list, context({ team_name: 'missing' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    expect(result.display).toEqual({
      key: 'toolResult.teamTask.noTeam',
      params: { team: 'missing' },
    });
  });

  it('marks only the empty list with a display ref', async () => {
    const fixture = await createFixture();
    await fixture.store.createTask('core', { subject: 'one', createdBy: 'leader' });

    // Non-empty: the record dump is model-facing data and renders raw.
    const nonEmpty = await executeTool(fixture.list, context({ team_name: 'core' }));
    expect(nonEmpty.isError).toBeUndefined();
    expect(nonEmpty.display).toBeUndefined();

    // Existing team with zero tasks: the empty state gets a display ref.
    await mkdir(join(fixture.dir, 'teams'), { recursive: true });
    await writeFile(
      join(fixture.dir, 'teams', 'empty.json'),
      JSON.stringify({ name: 'empty', createdAt: 0, createdBy: 'leader', nextTaskId: 1, tasks: [] }),
    );
    const empty = await executeTool(fixture.list, context({ team_name: 'empty' }));
    expect(empty.isError).toBeUndefined();
    expect(empty.output).toContain('has no tasks');
    expect(empty.display).toEqual({
      key: 'toolResult.teamTask.listEmpty',
      params: { team: 'empty' },
    });
  });
});

describe('TeamTaskUpdate', () => {
  it('lets the leader reassign and complete any task', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.createTask('core', { subject: 'work', createdBy: 'leader' });

    const assigned = await executeTool(fixture.update,
      context({ team_name: 'core', task_id: task.id, owner: 'researcher' }),
    );
    expect(assigned.output).toContain('owner: researcher');
    expect(assigned.display).toEqual({
      key: 'toolResult.teamTask.updated',
      params: { id: task.id, team: 'core', subject: 'work' },
    });

    const done = await executeTool(fixture.update,
      context({ team_name: 'core', task_id: task.id, status: 'completed' }),
    );
    expect(done.output).toContain('status: completed');
  });

  it('lets a teammate complete its own task but not touch others', async () => {
    const fixture = await createFixture();
    const mine = await fixture.store.createTask('core', {
      subject: 'mine',
      owner: 'researcher',
      createdBy: 'leader',
    });
    const theirs = await fixture.store.createTask('core', {
      subject: 'theirs',
      owner: 'writer',
      createdBy: 'leader',
    });

    const ctx = teammate('researcher', 'core');
    const done = await inTeammate(ctx, () =>
      executeTool(fixture.update, context({ task_id: mine.id, status: 'completed' })),
    );
    expect(done.isError).toBeUndefined();
    expect(done.output).toContain('status: completed');

    const denied = await inTeammate(ctx, () =>
      executeTool(fixture.update, context({ task_id: theirs.id, status: 'completed' })),
    );
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain('owned by "writer"');
    expect(denied.display).toEqual({
      key: 'toolResult.teamTask.ownedByOther',
      params: { id: theirs.id, owner: 'writer', caller: 'researcher' },
    });

    const reassign = await inTeammate(ctx, () =>
      executeTool(fixture.update, context({ task_id: mine.id, owner: 'writer' })),
    );
    expect(reassign.isError).toBe(true);
    expect(reassign.output).toContain('cannot reassign');
    expect(reassign.display).toEqual({ key: 'toolResult.teamTask.cannotReassign' });
  });

  it('lets the leader clear an owner with an empty string', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.createTask('core', {
      subject: 'work',
      owner: 'researcher',
      createdBy: 'leader',
    });

    const cleared = await executeTool(fixture.update,
      context({ team_name: 'core', task_id: task.id, owner: '' }),
    );
    expect(cleared.isError).toBeUndefined();
    expect(cleared.output).toContain('owner: \n');
    expect(await fixture.store.getTask('core', task.id)).toMatchObject({ owner: undefined });
  });

  it('requires at least one field and rejects unknown tasks', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.createTask('core', { subject: 'work', createdBy: 'leader' });

    const empty = await executeTool(fixture.update, context({ team_name: 'core', task_id: task.id }));
    expect(empty.isError).toBe(true);
    expect(empty.output).toContain('Nothing to update');
    expect(empty.display).toEqual({ key: 'toolResult.teamTask.nothingToUpdate' });

    const missing = await executeTool(fixture.update,
      context({ team_name: 'core', task_id: 99, status: 'completed' }),
    );
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('was not found');
    expect(missing.display).toEqual({
      key: 'toolResult.teamTask.notFound',
      params: { id: 99, team: 'core' },
    });
  });
});

describe('TeamTaskClaim', () => {
  it('claims the next task with the identity from the teammate context', async () => {
    const fixture = await createFixture();
    await fixture.store.createTask('core', { subject: 'first', description: 'do it', createdBy: 'leader' });
    await fixture.store.createTask('core', { subject: 'second', createdBy: 'leader' });

    const result = await inTeammate(teammate('researcher', 'core'), () =>
      executeTool(fixture.claim, context({})),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Claimed task #1');
    expect(result.output).toContain('owner: researcher');
    expect(result.output).toContain('do it');
    expect(result.display).toEqual({
      key: 'toolResult.teamTask.claimed',
      params: { id: 1, team: 'core', owner: 'researcher', subject: 'first' },
    });

    const stored = await fixture.store.getTask('core', 1);
    expect(stored).toMatchObject({ status: 'in_progress', owner: 'researcher' });
  });

  it('rejects callers without a teammate context', async () => {
    const fixture = await createFixture();
    const result = await executeTool(fixture.claim, context({ team_name: 'core' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Only a teammate can claim tasks');
    expect(result.display).toEqual({ key: 'toolResult.teamTask.claimNotTeammate' });
  });

  it('rejects teammates that belong to no team', async () => {
    const fixture = await createFixture();
    const result = await inTeammate(teammate('lonely'), () =>
      executeTool(fixture.claim, context({})),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not belong to a team');
    expect(result.display).toEqual({
      key: 'toolResult.teamTask.claimNoTeam',
      params: { name: 'lonely' },
    });
  });

  it('reports when nothing is claimable', async () => {
    const fixture = await createFixture();
    await fixture.store.createTask('core', { subject: 'taken', owner: 'writer', createdBy: 'leader' });

    const result = await inTeammate(teammate('researcher', 'core'), () =>
      executeTool(fixture.claim, context({})),
    );
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('No claimable tasks');
    expect(result.display).toEqual({
      key: 'toolResult.teamTask.noneClaimable',
      params: { team: 'core' },
    });
  });
});
