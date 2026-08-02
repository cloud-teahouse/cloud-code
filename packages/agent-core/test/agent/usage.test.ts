import { describe, expect, it } from 'vitest';

import type { RateLimitSnapshot } from '@cloud-code/kosong';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../src/agent/records';
import { UsageRecorder } from '../../src/agent/usage';
import { testAgent } from './harness/agent';

describe('Agent usage', () => {
  it('accumulates usage by model', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    usage.record('model-b', {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    });

    expect(usage.data()).toEqual({
      byModel: {
        'model-a': {
          inputOther: 11,
          output: 22,
          inputCacheRead: 33,
          inputCacheCreation: 44,
        },
        'model-b': {
          inputOther: 100,
          output: 200,
          inputCacheRead: 300,
          inputCacheCreation: 400,
        },
      },
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage separately from session totals', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.beginTurn();
    usage.record(
      'model-a',
      {
        inputOther: 10,
        output: 20,
        inputCacheRead: 30,
        inputCacheCreation: 40,
      },
      'turn',
    );
    usage.record(
      'model-b',
      {
        inputOther: 100,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
      'turn',
    );

    expect(usage.data()).toMatchObject({
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: {
        inputOther: 110,
        output: 220,
        inputCacheRead: 330,
        inputCacheCreation: 440,
      },
    });

    usage.endTurn();

    expect(usage.data().currentTurn).toBeUndefined();
  });

  it('returns immutable status snapshots', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    const snapshot = usage.data();

    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });

    expect(snapshot).toEqual({
      byModel: {
        'model-a': {
          inputOther: 1,
          output: 2,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        },
      },
      total: {
        inputOther: 1,
        output: 2,
        inputCacheRead: 3,
        inputCacheCreation: 4,
      },
      currentTurn: undefined,
    });
  });

  it('keeps the latest rate-limit snapshot, latest wins', () => {
    const usage = new UsageRecorder();
    expect(usage.data().rateLimit).toBeUndefined();

    const first = {
      planType: 'plus',
      activeLimit: 'premium',
      primary: { usedPercent: 26, windowMinutes: 10080, resetsAt: 1900000000 },
      secondary: null,
      credits: null,
      capturedAt: 1900000000000,
    };
    const second = { ...first, capturedAt: 1900000060000 };
    usage.recordRateLimit(first);
    expect(usage.data().rateLimit).toEqual(first);

    usage.recordRateLimit(second);
    expect(usage.data().rateLimit).toEqual(second);
    expect(usage.status()?.rateLimit).toEqual(second);
  });
});

describe('Agent usage rate-limit persistence', () => {
  const snapshot: RateLimitSnapshot = {
    planType: 'plus',
    activeLimit: 'premium',
    primary: { usedPercent: 26, windowMinutes: 300, resetsAt: 1900000000 },
    secondary: { usedPercent: 62.5, windowMinutes: 10080, resetsAt: 1900500000 },
    credits: { hasCredits: true, unlimited: false, balance: '120.5' },
    capturedAt: 1900000000000,
  };

  it('logs a usage.rate_limit wire record with the full snapshot', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const { agent } = testAgent({ persistence });

    agent.usage.recordRateLimit(snapshot);
    await agent.records.flush();

    expect(persistence.records).toHaveLength(2);
    expect(persistence.records[0]?.type).toBe('metadata');
    expect(persistence.records[1]).toMatchObject({
      type: 'usage.rate_limit',
      snapshot,
    });
  });

  it('restores the persisted snapshot on replay, latest record wins', async () => {
    const newer: RateLimitSnapshot = {
      ...snapshot,
      primary: { usedPercent: 41, windowMinutes: 300, resetsAt: 1900001000 },
      capturedAt: snapshot.capturedAt + 60_000,
    };
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'usage.rate_limit', snapshot },
      { type: 'usage.rate_limit', snapshot: newer },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.usage.data().rateLimit).toEqual(newer);
    expect(agent.usage.status()?.rateLimit).toEqual(newer);
  });

  it('does not re-log the record while replaying it', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'usage.rate_limit', snapshot },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.usage.data().rateLimit).toEqual(snapshot);
    expect(
      persistence.records.filter((record) => record.type === 'usage.rate_limit'),
    ).toHaveLength(1);
  });

  it('round-trips a live capture into a resumed agent', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const live = testAgent({ persistence });
    live.agent.usage.recordRateLimit(snapshot);
    await live.agent.records.flush();

    const resumed = testAgent({
      persistence: new InMemoryAgentRecordPersistence([...persistence.records]),
    });
    await resumed.agent.records.replay();

    expect(resumed.agent.usage.data().rateLimit).toEqual(snapshot);
  });
});
