import type { Event } from '@cloud-code/agent-core';
import { describe, expect, it } from 'vitest';

import { EventJournal } from '../src/event-journal';

function durableEvent(sessionId: string, marker: string): Event {
  return { type: 'turn.started', sessionId, agentId: 'main', turnId: 1, marker } as unknown as Event;
}

function volatileDelta(sessionId: string, delta: string): Event {
  return { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta } as Event;
}

describe('EventJournal (design §4 v2 minimal slice)', () => {
  it('assigns monotonically increasing seq to durable events per session', () => {
    const journal = new EventJournal();
    const c1 = journal.append(durableEvent('s1', 'a'));
    const c2 = journal.append(durableEvent('s1', 'b'));
    const other = journal.append(durableEvent('s2', 'x'));
    expect(c1).toMatchObject({ seq: 1, epoch: journal.epoch });
    expect(c2).toMatchObject({ seq: 2 });
    // Seq counters are per session.
    expect(other).toMatchObject({ seq: 1 });
    expect(journal.cursorOf('s1')).toEqual({ seq: 2, epoch: journal.epoch });
  });

  it('does not journal volatile events nor advance seq for them', () => {
    const journal = new EventJournal();
    expect(journal.append(volatileDelta('s1', 'chunk'))).toBeUndefined();
    expect(journal.append(durableEvent('s1', 'a'))).toMatchObject({ seq: 1 });
    expect(journal.append(volatileDelta('s1', 'more'))).toBeUndefined();
    expect(journal.append(durableEvent('s1', 'b'))).toMatchObject({ seq: 2 });
    expect(journal.cursorOf('s1').seq).toBe(2);
  });

  it('replays entries newer than the cursor in order', () => {
    const journal = new EventJournal();
    journal.append(durableEvent('s1', 'a'));
    journal.append(durableEvent('s1', 'b'));
    journal.append(durableEvent('s1', 'c'));
    const replay = journal.replay('s1', { seq: 1, epoch: journal.epoch });
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(replay.cursor).toEqual({ seq: 3, epoch: journal.epoch });
    // Up-to-date cursor replays nothing.
    const idle = journal.replay('s1', { seq: 3, epoch: journal.epoch });
    expect(idle).toMatchObject({ status: 'ok', entries: [] });
  });

  it('drops the oldest entries beyond capacity and reports buffer_overflow', () => {
    const journal = new EventJournal(3);
    for (let i = 0; i < 5; i += 1) journal.append(durableEvent('s1', `e${i}`));
    expect(journal.cursorOf('s1').seq).toBe(5);
    // seq 1 and 2 fell out of the ring; a cursor at 1 sees a gap (needs 2..).
    const overflow = journal.replay('s1', { seq: 1, epoch: journal.epoch });
    expect(overflow).toMatchObject({ status: 'resync_required', reason: 'buffer_overflow' });
    // A cursor at 2 resumes cleanly from seq 3.
    const replay = journal.replay('s1', { seq: 2, epoch: journal.epoch });
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
  });

  it('rejects cursors from a foreign epoch', () => {
    const journal = new EventJournal();
    journal.append(durableEvent('s1', 'a'));
    const replay = journal.replay('s1', { seq: 0, epoch: 'some-other-epoch' });
    expect(replay).toMatchObject({ status: 'resync_required', reason: 'epoch_changed' });
  });

  it('treats an epoch-less cursor on an unknown session as up-to-date', () => {
    const journal = new EventJournal();
    const replay = journal.replay('never-seen', { seq: 0 });
    expect(replay).toMatchObject({ status: 'ok', entries: [] });
    expect(journal.cursorOf('never-seen')).toEqual({ seq: 0, epoch: journal.epoch });
  });

  it('resyncs a non-fresh cursor on a session it holds nothing for', () => {
    const journal = new EventJournal();
    // seq > 0 claims to have seen events the journal cannot account for.
    // Reporting `ok` here would read as "nothing missed".
    expect(journal.replay('never-seen', { seq: 7 })).toMatchObject({
      status: 'resync_required',
      reason: 'session_recreated',
    });
  });

  describe('retention', () => {
    it('forgets a session and resyncs cursors that outlived it', () => {
      const journal = new EventJournal();
      journal.append(durableEvent('s1', 'a'));
      journal.append(durableEvent('s2', 'b'));
      expect(journal.retainedSessionCount).toBe(2);

      journal.forgetSession('s1');

      expect(journal.retainedSessionCount).toBe(1);
      expect(journal.replay('s1', { seq: 1, epoch: journal.epoch })).toMatchObject({
        status: 'resync_required',
        reason: 'session_recreated',
      });
      // Untouched sessions keep replaying normally.
      expect(journal.replay('s2', { seq: 0, epoch: journal.epoch })).toMatchObject({
        status: 'ok',
      });
    });

    it('forgetting an unknown session is a no-op', () => {
      const journal = new EventJournal();
      journal.append(durableEvent('s1', 'a'));
      journal.forgetSession('never-seen');
      expect(journal.retainedSessionCount).toBe(1);
    });

    it('caps retained sessions, evicting the least recently appended', () => {
      const journal = new EventJournal(4, 2);
      journal.append(durableEvent('s1', 'a'));
      journal.append(durableEvent('s2', 'b'));
      // Touching s1 makes s2 the eviction candidate, not s1.
      journal.append(durableEvent('s1', 'c'));
      journal.append(durableEvent('s3', 'd'));

      expect(journal.retainedSessionCount).toBe(2);
      expect(journal.replay('s1', { seq: 2, epoch: journal.epoch })).toMatchObject({ status: 'ok' });
      expect(journal.replay('s3', { seq: 1, epoch: journal.epoch })).toMatchObject({ status: 'ok' });
      expect(journal.replay('s2', { seq: 1, epoch: journal.epoch })).toMatchObject({
        status: 'resync_required',
        reason: 'session_recreated',
      });
    });

    it('volatile events neither create nor refresh a session buffer', () => {
      const journal = new EventJournal();
      journal.append(volatileDelta('s1', 'x'));
      expect(journal.retainedSessionCount).toBe(0);
    });

    it('clamps a non-positive capacity instead of silently retaining nothing', () => {
      // Capacity 0 used to produce a RingBuffer that kept no entries while
      // oldestSeq stayed 0, so replay answered `ok` + no entries to any
      // cursor — total silent event loss on reconnect.
      const journal = new EventJournal(0);
      journal.append(durableEvent('s1', 'a'));
      journal.append(durableEvent('s1', 'b'));
      // Clamped to capacity 1: the newest event is retained and replayable
      // for an up-to-date cursor...
      const upToDate = journal.replay('s1', { seq: 1, epoch: journal.epoch });
      expect(upToDate.status).toBe('ok');
      if (upToDate.status === 'ok') {
        expect(upToDate.entries.map((entry) => entry.seq)).toEqual([2]);
      }
      // ...and a cursor from before the retained window resyncs instead of
      // silently being told "nothing missed".
      expect(journal.replay('s1', { seq: 0, epoch: journal.epoch })).toMatchObject({
        status: 'resync_required',
        reason: 'buffer_overflow',
      });
    });
  });
});
