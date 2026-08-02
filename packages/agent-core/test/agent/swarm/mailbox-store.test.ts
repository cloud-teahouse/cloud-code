import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LEADER_INBOX,
  MailboxStore,
  type MailboxMessage,
} from '../../../src/agent/swarm/mailbox';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createStore(): Promise<{ store: MailboxStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-store-'));
  tempDirs.push(dir);
  return { store: new MailboxStore(dir), dir };
}

describe('MailboxStore', () => {
  it('round-trips a message envelope with id, timestamp and read index', async () => {
    const { store } = await createStore();

    const sent = await store.send('core', {
      from: LEADER_INBOX,
      to: 'researcher',
      kind: 'message',
      body: { text: 'how is it going?', summary: 'status check' },
    });
    expect(sent.id).toMatch(/^msg_[0-9a-z]{8}$/);
    expect(sent.createdAt).toBeTruthy();
    expect(sent.read).toBe(false);

    const inbox = await store.inbox('core', 'researcher');
    expect(inbox).toEqual([sent]);
  });

  it('round-trips every protocol kind with its typed body', async () => {
    const { store } = await createStore();
    const outbound = [
      { from: LEADER_INBOX, to: 'a', kind: 'task_assignment', body: { taskId: 3, subject: 'work', assignedBy: 'leader' } },
      { from: LEADER_INBOX, to: 'a', kind: 'shutdown_request', body: { requestId: 'r1', reason: 'wrap up' } },
      { from: 'a', to: LEADER_INBOX, kind: 'shutdown_approved', body: { requestId: 'r1' } },
      { from: 'a', to: LEADER_INBOX, kind: 'shutdown_rejected', body: { requestId: 'r1', reason: 'mid-flight' } },
      { from: 'a', to: LEADER_INBOX, kind: 'permission_request', body: { requestId: 'p1', toolName: 'Bash', toolUseId: 't1', description: 'run tests', input: { command: 'pnpm test' } } },
      { from: LEADER_INBOX, to: 'a', kind: 'permission_response', body: { requestId: 'p1', subtype: 'error', error: 'denied' } },
    ] as const;

    for (const message of outbound) {
      await store.send('core', message as Parameters<MailboxStore['send']>[1]);
    }

    const forA = await store.inbox('core', 'a');
    expect(forA.map((message: MailboxMessage) => message.kind)).toEqual([
      'task_assignment',
      'shutdown_request',
      'permission_response',
    ]);
    expect(forA[0]).toMatchObject({ body: { taskId: 3, subject: 'work' } });
    expect(forA[2]).toMatchObject({ body: { subtype: 'error', error: 'denied' } });

    const forLeader = await store.inbox('core', LEADER_INBOX);
    expect(forLeader.map((message: MailboxMessage) => message.kind)).toEqual([
      'shutdown_approved',
      'shutdown_rejected',
      'permission_request',
    ]);
    expect(forLeader[2]).toMatchObject({ body: { requestId: 'p1', toolName: 'Bash' } });
  });

  it('tracks the read index: unread filters, markRead advances', async () => {
    const { store } = await createStore();
    const first = await store.send('core', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'one' } });
    const second = await store.send('core', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'two' } });

    expect((await store.unread('core', 'a')).map((m) => m.id)).toEqual([first.id, second.id]);
    await store.markRead('core', 'a', [first.id]);
    expect((await store.unread('core', 'a')).map((m) => m.id)).toEqual([second.id]);
    // Unknown ids are ignored; marking again is a no-op.
    await store.markRead('core', 'a', ['msg_missing', first.id]);
    expect((await store.inbox('core', 'a'))[0]?.read).toBe(true);
  });

  it('returns empty inboxes for unknown members', async () => {
    const { store } = await createStore();
    expect(await store.inbox('core', 'nobody')).toEqual([]);
    expect(await store.unread('core', 'nobody')).toEqual([]);
  });

  it('rejects path-unsafe team and member names', async () => {
    const { store } = await createStore();
    await expect(
      store.send('../escape', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'x' } }),
    ).rejects.toThrow('Invalid team name');
    await expect(
      store.send('core', { from: LEADER_INBOX, to: '../escape', kind: 'message', body: { text: 'x' } }),
    ).rejects.toThrow('Invalid member name');
  });

  it('loses nothing under concurrent writers', async () => {
    const { store } = await createStore();

    // Ten parallel appends to the SAME inbox: the per-inbox queue serializes
    // read-append-write, so every message must land.
    const sends = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.send('core', {
          from: i % 2 === 0 ? LEADER_INBOX : 'peer',
          to: 'a',
          kind: 'message',
          body: { text: `message-${String(i)}` },
        }),
      ),
    );
    const inbox = await store.inbox('core', 'a');
    expect(inbox).toHaveLength(10);
    expect(new Set(inbox.map((m) => m.id)).size).toBe(10);
    // Queue order is preserved: texts arrive in send order.
    expect(inbox.map((m) => (m.kind === 'message' ? m.body.text : ''))).toEqual(
      Array.from({ length: 10 }, (_, i) => `message-${String(i)}`),
    );
    expect(sends.map((m) => m.id)).toEqual(inbox.map((m) => m.id));
  });

  it('keeps inboxes isolated per member and per team', async () => {
    const { store } = await createStore();
    await store.send('core', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'for a' } });
    await store.send('core', { from: LEADER_INBOX, to: 'b', kind: 'message', body: { text: 'for b' } });
    await store.send('infra', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'for infra a' } });

    expect((await store.inbox('core', 'a')).map((m) => (m.kind === 'message' ? m.body.text : ''))).toEqual(['for a']);
    expect((await store.inbox('core', 'b'))).toHaveLength(1);
    expect((await store.inbox('infra', 'a'))).toHaveLength(1);
  });

  it('persists inboxes across store instances (restart)', async () => {
    const { store, dir } = await createStore();
    await store.send('core', { from: LEADER_INBOX, to: 'a', kind: 'message', body: { text: 'durable' } });

    const reopened = new MailboxStore(dir);
    const inbox = await reopened.inbox('core', 'a');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'message', read: false });
  });

  describe('ring cap (readHistoryLimit)', () => {
    function plain(to: string, text: string) {
      return { from: LEADER_INBOX, to, kind: 'message', body: { text } } as const;
    }

    it('keeps the newest N read messages plus every unread one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-store-'));
      tempDirs.push(dir);
      const store = new MailboxStore(dir, { readHistoryLimit: 2 });

      // m1..m4 will be read; u1..u2 stay unread. With limit 2 the retained
      // read tail is [m3, m4]; every unread message survives.
      const sent: MailboxMessage[] = [];
      for (const text of ['m1', 'm2', 'm3', 'm4']) {
        sent.push(await store.send('core', plain('a', text)));
      }
      await store.markRead('core', 'a', sent.map((m) => m.id));
      const u1 = await store.send('core', plain('a', 'u1'));
      const u2 = await store.send('core', plain('a', 'u2'));

      const inbox = await store.inbox('core', 'a');
      expect(inbox.map((m) => (m.kind === 'message' ? m.body.text : ''))).toEqual([
        'm3', 'm4', 'u1', 'u2',
      ]);
      expect(inbox.map((m) => m.read)).toEqual([true, true, false, false]);
      // And a fresh reader sees the same capped file (the prune hit disk).
      const reopened = new MailboxStore(dir, { readHistoryLimit: 2 });
      expect((await reopened.inbox('core', 'a')).map((m) => m.id)).toEqual([
        sent[2]!.id, sent[3]!.id, u1.id, u2.id,
      ]);
    });

    it('never drops unread permission_request / shutdown_request regardless of the cap', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-store-'));
      tempDirs.push(dir);
      const store = new MailboxStore(dir, { readHistoryLimit: 1 });

      const permission = await store.send('core', {
        from: 'a',
        to: LEADER_INBOX,
        kind: 'permission_request',
        body: { requestId: 'preq_x', toolName: 'Bash', toolUseId: 't1', description: 'run it', input: {} },
      });
      const shutdown = await store.send('core', {
        from: LEADER_INBOX,
        to: 'a',
        kind: 'shutdown_request',
        body: { requestId: 'shutdown_x', reason: 'wrap up' },
      });
      // Flood both inboxes with read traffic far beyond the cap.
      for (let i = 0; i < 5; i += 1) {
        const extra = await store.send('core', plain(LEADER_INBOX, `flood-leader-${String(i)}`));
        await store.markRead('core', LEADER_INBOX, [extra.id]);
        const extraA = await store.send('core', plain('a', `flood-a-${String(i)}`));
        await store.markRead('core', 'a', [extraA.id]);
      }

      const leaderInbox = await store.inbox('core', LEADER_INBOX);
      expect(leaderInbox.some((m) => m.id === permission.id)).toBe(true);
      // Prune-on-append bounds the read tail to the cap plus the newest
      // not-yet-pruned append (markRead itself never prunes); the inbox can
      // never grow unboundedly while unread protocol messages always survive.
      expect(leaderInbox.filter((m) => m.read).length).toBeLessThanOrEqual(2);
      expect(leaderInbox.length).toBeLessThanOrEqual(4);
      const aInbox = await store.inbox('core', 'a');
      expect(aInbox.some((m) => m.id === shutdown.id)).toBe(true);
      expect(aInbox.filter((m) => m.read).length).toBeLessThanOrEqual(2);
      expect(aInbox.length).toBeLessThanOrEqual(4);
    });

    it('notifies the onSend hook for every persisted append (activity events)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-store-'));
      tempDirs.push(dir);
      const seen: Array<{ teamName: string; id: string }> = [];
      const store = new MailboxStore(dir, {
        onSend: (teamName, message) => {
          seen.push({ teamName, id: message.id });
        },
      });

      const first = await store.send('core', plain('a', 'one'));
      const second = await store.send('core', plain(LEADER_INBOX, 'two'));

      expect(seen).toEqual([
        { teamName: 'core', id: first.id },
        { teamName: 'core', id: second.id },
      ]);
    });

    it('applies no pruning when the limit is Infinity (opt-out)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cloud-code-mailbox-store-'));
      tempDirs.push(dir);
      const store = new MailboxStore(dir, { readHistoryLimit: Number.POSITIVE_INFINITY });
      for (let i = 0; i < 6; i += 1) {
        const sent = await store.send('core', plain('a', `m${String(i)}`));
        await store.markRead('core', 'a', [sent.id]);
      }
      expect(await store.inbox('core', 'a')).toHaveLength(6);
    });
  });

  describe('read-through cache', () => {
    async function writeInboxFile(
      dir: string,
      team: string,
      member: string,
      messages: readonly MailboxMessage[],
    ): Promise<void> {
      const inboxDir = join(dir, 'teams', team, 'inboxes');
      await mkdir(inboxDir, { recursive: true });
      await writeFile(join(inboxDir, `${member}.json`), JSON.stringify({ messages }), 'utf-8');
    }

    it('serves repeat reads from cache and stays fresh across send mutations', async () => {
      const { store, dir } = await createStore();
      const first = await store.send('core', {
        from: LEADER_INBOX,
        to: 'a',
        kind: 'message',
        body: { text: 'one' },
      });
      expect((await store.inbox('core', 'a')).map((m) => m.id)).toEqual([first.id]);

      const second = await store.send('core', {
        from: LEADER_INBOX,
        to: 'a',
        kind: 'message',
        body: { text: 'two' },
      });
      expect((await store.inbox('core', 'a')).map((m) => m.id)).toEqual([first.id, second.id]);

      // Proof the repeat reads above never re-hit disk: an out-of-band rewrite
      // is invisible to this store (the mutation queue is the only writer),
      // while a fresh store instance over the same directory reads it.
      await writeInboxFile(dir, 'core', 'a', [
        {
          id: 'msg_extern',
          from: LEADER_INBOX,
          to: 'a',
          createdAt: new Date().toISOString(),
          read: false,
          kind: 'message',
          body: { text: 'external' },
        },
      ]);
      expect((await store.inbox('core', 'a')).map((m) => m.id)).toEqual([first.id, second.id]);
      const reopened = new MailboxStore(dir);
      expect((await reopened.inbox('core', 'a')).map((m) => m.id)).toEqual(['msg_extern']);
    });

    it('stays fresh across markRead mutations', async () => {
      const { store, dir } = await createStore();
      const first = await store.send('core', {
        from: LEADER_INBOX,
        to: 'a',
        kind: 'message',
        body: { text: 'one' },
      });
      const second = await store.send('core', {
        from: LEADER_INBOX,
        to: 'a',
        kind: 'message',
        body: { text: 'two' },
      });

      expect((await store.unread('core', 'a')).map((m) => m.id)).toEqual([first.id, second.id]);
      await store.markRead('core', 'a', [first.id]);
      expect((await store.unread('core', 'a')).map((m) => m.id)).toEqual([second.id]);
      expect((await store.inbox('core', 'a')).map((m) => m.read)).toEqual([true, false]);

      // The cache-served read index matches the persisted file exactly.
      const reopened = new MailboxStore(dir);
      expect((await reopened.unread('core', 'a')).map((m) => m.id)).toEqual([second.id]);
    });

    it('caches a missing inbox and picks up its first send', async () => {
      const { store, dir } = await createStore();
      // Negative read: no file exists yet; the miss is cached.
      expect(await store.unread('core', 'ghost')).toEqual([]);

      // An out-of-band created inbox stays invisible to this store (single
      // writer contract), proving the negative result was served from cache.
      await writeInboxFile(dir, 'core', 'ghost', [
        {
          id: 'msg_extern',
          from: LEADER_INBOX,
          to: 'ghost',
          createdAt: new Date().toISOString(),
          read: false,
          kind: 'message',
          body: { text: 'external' },
        },
      ]);
      expect(await store.unread('core', 'ghost')).toEqual([]);

      // A send through the store itself creates the file via the mutation
      // queue, which refreshes the cache on the same write.
      const sent = await store.send('core', {
        from: LEADER_INBOX,
        to: 'ghost',
        kind: 'message',
        body: { text: 'hello' },
      });
      expect((await store.unread('core', 'ghost')).map((m) => m.id)).toEqual([sent.id]);
      const reopened = new MailboxStore(dir);
      expect((await reopened.unread('core', 'ghost')).map((m) => m.id)).toEqual([sent.id]);
    });
  });
});
