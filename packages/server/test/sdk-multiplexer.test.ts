import type { Event } from '@cloud-code/agent-core';
import { describe, expect, it } from 'vitest';

import { SdkMultiplexer, type ReverseRpcConnection } from '../src/sdk-multiplexer';

function fakeConnection(id: string) {
  const events: Event[] = [];
  const approvals: unknown[] = [];
  const conn: ReverseRpcConnection & {
    events: Event[];
    approvals: unknown[];
    setClosed(): void;
    isClosed(): boolean;
  } = {
    events,
    approvals,
    closed: false,
    setClosed() {
      (conn as { closed: boolean }).closed = true;
    },
    isClosed() {
      return conn.closed;
    },
    sendEvent(event: Event) {
      events.push(event);
    },
    sendResyncRequired() {
      // Unit fakes never exercise the resync path.
    },
    requestApproval(request) {
      approvals.push(request);
      return Promise.resolve({ decision: 'approved' as const });
    },
    requestQuestion() {
      return Promise.resolve({ answers: {} });
    },
    toolCall() {
      return Promise.resolve({ output: 'ok' });
    },
  };
  void id;
  return conn;
}

function eventFor(sessionId: string): Event {
  return {
    type: 'turn.started',
    sessionId,
    agentId: 'main',
    turnId: 1,
  } as Event;
}

describe('SdkMultiplexer', () => {
  it('routes approvals to the owning connection by sessionId', async () => {
    const mux = new SdkMultiplexer();
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    mux.claimSession('s1', a);
    mux.claimSession('s2', b);

    const result = await mux.requestApproval({
      sessionId: 's2',
      agentId: 'subagent-1', // subagent id: routing must still find s2's owner
      toolCallId: 'tc1',
      toolName: 'Bash',
      action: 'Bash',
      display: { kind: 'generic', summary: 'echo' },
    });
    expect(result.decision).toBe('approved');
    expect(b.approvals).toHaveLength(1);
    expect(a.approvals).toHaveLength(0);
  });

  it('fails closed when no connection owns the session', async () => {
    const mux = new SdkMultiplexer();
    await expect(
      mux.requestApproval({
        sessionId: 'ghost',
        agentId: 'main',
        toolCallId: 'tc1',
        toolName: 'Bash',
        action: 'Bash',
        display: { kind: 'generic', summary: 'echo' },
      }),
    ).resolves.toMatchObject({ decision: 'cancelled' });
    await expect(
      mux.requestQuestion({ sessionId: 'ghost', agentId: 'main', questions: [] }),
    ).resolves.toBeNull();
    await expect(
      mux.toolCall({ sessionId: 'ghost', agentId: 'main', toolCallId: 'tc1', args: {} }),
    ).resolves.toMatchObject({ isError: true });
  });

  it('fails closed when the owning connection is closed', async () => {
    const mux = new SdkMultiplexer();
    const a = fakeConnection('a');
    mux.claimSession('s1', a);
    a.setClosed();
    await expect(
      mux.requestApproval({
        sessionId: 's1',
        agentId: 'main',
        toolCallId: 'tc1',
        toolName: 'Bash',
        action: 'Bash',
        display: { kind: 'generic', summary: 'echo' },
      }),
    ).resolves.toMatchObject({ decision: 'cancelled' });
  });

  it('fans events out to every subscriber of the session', () => {
    const mux = new SdkMultiplexer();
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    mux.subscribe('s1', a);
    mux.subscribe('s1', b);
    mux.subscribe('s2', b);

    mux.emitEvent(eventFor('s1'));
    mux.emitEvent(eventFor('s2'));
    mux.emitEvent(eventFor('unsubscribed'));

    expect(a.events.map((event) => event.sessionId)).toEqual(['s1']);
    expect(b.events.map((event) => event.sessionId)).toEqual(['s1', 's2']);
  });

  it('moves ownership to the latest claimant while keeping subscriptions additive', async () => {
    const mux = new SdkMultiplexer();
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    mux.claimSession('s1', a);
    mux.claimSession('s1', b);

    mux.emitEvent(eventFor('s1'));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);

    await mux.requestApproval({
      sessionId: 's1',
      agentId: 'main',
      toolCallId: 'tc1',
      toolName: 'Bash',
      action: 'Bash',
      display: { kind: 'generic', summary: 'echo' },
    });
    expect(a.approvals).toHaveLength(0);
    expect(b.approvals).toHaveLength(1);
  });

  it('releases all state for a closed connection', () => {
    const mux = new SdkMultiplexer();
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    mux.claimSession('s1', a);
    mux.subscribe('s1', b);
    mux.releaseConnection(a);

    expect(mux.ownerOf('s1')).toBeUndefined();
    mux.emitEvent(eventFor('s1'));
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(1);
  });
});
