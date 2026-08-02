import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { MailboxStore } from '../../../src/agent/swarm/mailbox';
import {
  DEFAULT_TEAMMATE_KEEP_ALIVE_IDLE_TIMEOUT_MS,
  DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS,
  findTeammateWork,
  resolveKeepAliveOptions,
} from '../../../src/agent/swarm/teammate-keepalive';
import { renderTeammatePromptAddendum } from '../../../src/agent/swarm/teammate-prompt-addendum';
import { TeamStore } from '../../../src/agent/swarm/team-store';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createStores(): Promise<{ teamStore: TeamStore; mailboxStore: MailboxStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-keepalive-'));
  tempDirs.push(dir);
  return { teamStore: new TeamStore(dir), mailboxStore: new MailboxStore(dir) };
}

const RESEARCHER = { name: 'researcher', teamName: 'core' } as const;

describe('findTeammateWork', () => {
  it('returns undefined without a team, and when the team has nothing to pick up', async () => {
    const { teamStore, mailboxStore } = await createStores();
    expect(await findTeammateWork(teamStore, mailboxStore, { name: 'researcher' })).toBeUndefined();

    await teamStore.ensureTeam('core', 'main');
    expect(await findTeammateWork(teamStore, mailboxStore, RESEARCHER)).toBeUndefined();

    // Completed tasks and tasks owned in progress by OTHERS are not work.
    await teamStore.createTask('core', { subject: 'done', createdBy: 'leader' });
    await teamStore.updateTask('core', 1, { status: 'completed' });
    await teamStore.createTask('core', { subject: 'theirs', owner: 'writer', createdBy: 'leader' });
    await teamStore.updateTask('core', 2, { status: 'in_progress' });
    expect(await findTeammateWork(teamStore, mailboxStore, RESEARCHER)).toBeUndefined();
  });

  it('an in-progress task the teammate itself owns is NOT work (no self-churn)', async () => {
    const { teamStore, mailboxStore } = await createStores();
    await teamStore.createTask('core', { subject: 'mine', owner: 'researcher', createdBy: 'leader' });
    await teamStore.updateTask('core', 1, { status: 'in_progress' });
    expect(await findTeammateWork(teamStore, mailboxStore, RESEARCHER)).toBeUndefined();
  });

  it('finds claimable, assigned-but-unstarted, and unread mailbox work, with a stable signature', async () => {
    const { teamStore, mailboxStore } = await createStores();
    await teamStore.createTask('core', { subject: 'claim me', createdBy: 'leader' });
    await teamStore.createTask('core', { subject: 'assigned to you', owner: 'researcher', createdBy: 'leader' });
    const message = await mailboxStore.send('core', {
      from: 'leader',
      to: 'researcher',
      kind: 'message',
      body: { text: 'ping' },
    });

    const work = await findTeammateWork(teamStore, mailboxStore, RESEARCHER);
    expect(work).toBeDefined();
    expect(work!.nudge).toContain('TeamTaskClaim');
    expect(work!.nudge).toContain('#2 assigned to you');
    expect(work!.nudge).toContain('1 unread mailbox message');
    expect(work!.messages.map((entry) => entry.id)).toEqual([message.id]);
    expect(work!.signature).toContain(`m:${message.id}`);
    expect(work!.signature).toContain('a:2');
    expect(work!.signature).toContain('c:1');

    // Same state → same signature (the stagnation guard depends on it).
    const again = await findTeammateWork(teamStore, mailboxStore, RESEARCHER);
    expect(again!.signature).toBe(work!.signature);

    // Claiming the claimable task removes it from the signature.
    await teamStore.claimNextTask('core', 'researcher');
    const afterClaim = await findTeammateWork(teamStore, mailboxStore, RESEARCHER);
    expect(afterClaim!.signature).not.toContain('c:1');
    expect(afterClaim!.signature).toContain('a:2');
  });

  it('unread shutdown requests are NOT keep-alive work (the watcher owns the shutdown protocol)', async () => {
    const { teamStore, mailboxStore } = await createStores();
    await teamStore.ensureTeam('core', 'main');
    await mailboxStore.send('core', {
      from: 'leader',
      to: 'researcher',
      kind: 'shutdown_request',
      body: { requestId: 'shutdown_1' },
    });
    expect(await findTeammateWork(teamStore, mailboxStore, RESEARCHER)).toBeUndefined();

    // A plain message alongside it is work — and only the plain message is
    // inlined; the shutdown stays for the watcher.
    const plain = await mailboxStore.send('core', {
      from: 'leader',
      to: 'researcher',
      kind: 'message',
      body: { text: 'before you go' },
    });
    const work = await findTeammateWork(teamStore, mailboxStore, RESEARCHER);
    expect(work!.messages.map((entry) => entry.id)).toEqual([plain.id]);
  });
});

describe('resolveKeepAliveOptions', () => {
  it('falls back to production defaults and honors overrides', () => {
    expect(resolveKeepAliveOptions(undefined)).toEqual({
      idleTimeoutMs: DEFAULT_TEAMMATE_KEEP_ALIVE_IDLE_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS,
    });
    expect(resolveKeepAliveOptions({ idleTimeoutMs: 0 })).toEqual({
      idleTimeoutMs: 0,
      pollIntervalMs: DEFAULT_TEAMMATE_KEEP_ALIVE_POLL_INTERVAL_MS,
    });
    expect(resolveKeepAliveOptions({ idleTimeoutMs: 123, pollIntervalMs: 45 })).toEqual({
      idleTimeoutMs: 123,
      pollIntervalMs: 45,
    });
  });
});

describe('renderTeammatePromptAddendum', () => {
  it('teaches the collaboration surface with the teammate identity baked in', () => {
    const addendum = renderTeammatePromptAddendum(RESEARCHER);
    expect(addendum).toContain('"researcher"');
    expect(addendum).toContain('"core"');
    // The CC essence: plain-text output is invisible to the team.
    expect(addendum).toContain('NOT visible to anyone on the team');
    // The teammate collaboration tools.
    expect(addendum).toContain('SendMessage');
    expect(addendum).toContain('TeamTaskClaim');
    expect(addendum).toContain('TeamTaskUpdate');
    expect(addendum).toContain('TeamTaskList');
    expect(addendum).toContain('TeamTaskCreate');
    // Shutdown protocol and keep-alive behavior.
    expect(addendum).toContain('shutdown request');
    expect(addendum).toContain('kept alive');
  });
});
