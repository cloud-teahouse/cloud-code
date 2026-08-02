import { describe, expect, it } from 'vitest';

import { InMemoryAgentRecordPersistence, type AgentRecordOf } from '../../src/agent/records';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import type { PreparedSystemPromptContext } from '../../src/profile';
import { testAgent, type TestAgentContext } from './harness/agent';

const STABLE_CONTEXT: PreparedSystemPromptContext = {
  cwdListing: 'LISTING',
  agentsMd: 'AGENTS_MD',
  additionalDirsInfo: '',
};
const stableContextProvider = () => Promise.resolve(STABLE_CONTEXT);

const agentProfile = () => DEFAULT_AGENT_PROFILES['agent']!;

function coordinatorRecords(
  persistence: InMemoryAgentRecordPersistence,
): Array<AgentRecordOf<'coordinator_mode.enter'> | AgentRecordOf<'coordinator_mode.exit'>> {
  return persistence.records.filter(
    (record): record is AgentRecordOf<'coordinator_mode.enter'> | AgentRecordOf<'coordinator_mode.exit'> =>
      record.type === 'coordinator_mode.enter' || record.type === 'coordinator_mode.exit',
  );
}

function statusEvents(ctx: TestAgentContext): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.event === 'agent.status.updated')
    .map((entry) => entry.args as Record<string, unknown>);
}

describe('coordinator mode', () => {
  it('enter rewrites the system prompt role through the append bus and emits status', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.agent.refreshSystemPrompt();
    const base = ctx.agent.config.systemPrompt;

    await ctx.rpc.enterCoordinator({});

    expect(ctx.agent.coordinatorMode.isActive).toBe(true);
    const prompt = ctx.agent.config.systemPrompt;
    // The base prompt survives; the coordinator role hangs at the tail.
    expect(prompt.startsWith(base.replace(/\n+$/, ''))).toBe(true);
    expect(prompt).toContain('# Coordinator Mode');
    expect(prompt).toContain('orchestrates software engineering tasks across multiple workers');
    // The four-phase workflow is explicit.
    expect(prompt).toContain('| Research | Workers (parallel) |');
    expect(prompt).toContain('| Synthesis | **You** (coordinator) |');
    expect(prompt).toContain('| Implementation | Workers |');
    expect(prompt).toContain('| Verification | Workers |');
    // The task-notification protocol is spelled out.
    expect(prompt).toContain('<task-notification>');
    expect(prompt).toContain('<task-id>{agentId}</task-id>');
    // The coordinator does not edit files directly.
    expect(prompt).toContain('You do not edit files yourself.');
    // The addendum is a dynamic tail section owned by the bus.
    const section = ctx.agent.systemPromptSections
      .snapshot()!
      .sections.find((candidate) => candidate.id === 'append:coordinator-mode')!;
    expect(section.origin).toBe('append');
    expect(section.cache).toBe('dynamic');

    const records = coordinatorRecords(persistence);
    expect(records.map((record) => record.type)).toEqual(['coordinator_mode.enter']);
    const statuses = statusEvents(ctx);
    expect(statuses.at(-1)?.['coordinatorMode']).toBe(true);
  });

  it('enter is idempotent and exit restores the base prompt byte-for-byte', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.agent.refreshSystemPrompt();
    const base = ctx.agent.config.systemPrompt;

    await ctx.rpc.enterCoordinator({});
    await ctx.rpc.enterCoordinator({});
    expect(coordinatorRecords(persistence)).toHaveLength(1);

    await ctx.rpc.exitCoordinator({});
    expect(ctx.agent.coordinatorMode.isActive).toBe(false);
    expect(ctx.agent.config.systemPrompt).toBe(base);
    expect(coordinatorRecords(persistence).map((record) => record.type)).toEqual([
      'coordinator_mode.enter',
      'coordinator_mode.exit',
    ]);
    const statuses = statusEvents(ctx);
    expect(statuses.at(-1)?.['coordinatorMode']).toBe(false);

    // A redundant exit stays a no-op.
    await ctx.rpc.exitCoordinator({});
    expect(coordinatorRecords(persistence)).toHaveLength(2);
  });

  it('rejects entering Coordinator Mode on a subagent', async () => {
    const ctx = testAgent({ type: 'sub' });
    ctx.configure();

    await expect(ctx.rpc.enterCoordinator({})).rejects.toThrow(
      'Coordinator Mode is only available on the main agent',
    );
    expect(ctx.agent.coordinatorMode.isActive).toBe(false);
  });

  it('rejects exiting Coordinator Mode on a subagent', async () => {
    const ctx = testAgent({ type: 'sub' });
    ctx.configure();

    await expect(ctx.rpc.exitCoordinator({})).rejects.toThrow(
      'Coordinator Mode is only available on the main agent',
    );
    expect(ctx.agent.coordinatorMode.isActive).toBe(false);
  });

  it('coexists with swarm mode: addendum and reminder channels stay independent, exit restores byte-for-byte', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.agent.refreshSystemPrompt();
    const base = ctx.agent.config.systemPrompt;
    const baseHistoryLength = ctx.agent.context.history.length;

    // Swarm mode rides the history-reminder channel; coordinator mode rides
    // the system-prompt append bus. Entering one must not disturb the other.
    ctx.agent.swarmMode.enter('manual');
    await ctx.rpc.enterCoordinator({});

    expect(ctx.agent.swarmMode.isActive).toBe(true);
    expect(ctx.agent.coordinatorMode.isActive).toBe(true);

    const prompt = ctx.agent.config.systemPrompt;
    expect(prompt.startsWith(base.replace(/\n+$/, ''))).toBe(true);
    expect(prompt).toContain('# Coordinator Mode');

    const swarmReminder = ctx.agent.context.history.find(
      (message) =>
        message.origin?.kind === 'injection' &&
        (message.origin as { variant?: string }).variant === 'swarm_mode',
    );
    expect(swarmReminder).toBeDefined();

    // Exiting coordinator peels only the addendum — the swarm reminder and
    // the base prompt are untouched.
    await ctx.rpc.exitCoordinator({});
    expect(ctx.agent.coordinatorMode.isActive).toBe(false);
    expect(ctx.agent.config.systemPrompt).toBe(base);
    expect(
      ctx.agent.context.history.some(
        (message) =>
          message.origin?.kind === 'injection' &&
          (message.origin as { variant?: string }).variant === 'swarm_mode',
      ),
    ).toBe(true);

    // Exiting swarm pops its reminder — history and prompt both return to
    // their pre-mode bytes.
    ctx.agent.swarmMode.exit();
    expect(ctx.agent.swarmMode.isActive).toBe(false);
    expect(
      ctx.agent.context.history.some(
        (message) =>
          message.origin?.kind === 'injection' &&
          (message.origin as { variant?: string }).variant === 'swarm_mode',
      ),
    ).toBe(false);
    expect(ctx.agent.context.history.length).toBe(baseHistoryLength);
    expect(ctx.agent.config.systemPrompt).toBe(base);
  });

  it('records replay restores the mode flag and the addendum without writing records', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.rpc.enterCoordinator({});
    expect(ctx.agent.coordinatorMode.isActive).toBe(true);

    // Replay the same record log onto a fresh agent: the mode is restored.
    const resumed = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    resumed.configure();
    await resumed.agent.resume();
    expect(resumed.agent.coordinatorMode.isActive).toBe(true);

    // The addendum re-registers with the bus, so a post-resume refresh keeps
    // the coordinator role instead of silently dropping it.
    resumed.agent.useProfile(agentProfile());
    expect(resumed.agent.config.systemPrompt).toContain('# Coordinator Mode');

    // Replay wrote no new coordinator records.
    expect(coordinatorRecords(persistence)).toHaveLength(1);
  });

  it('records replay of enter+exit restores the inactive mode', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.rpc.enterCoordinator({});
    await ctx.rpc.exitCoordinator({});

    const resumed = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    resumed.configure();
    await resumed.agent.resume();
    expect(resumed.agent.coordinatorMode.isActive).toBe(false);
    resumed.agent.useProfile(agentProfile());
    expect(resumed.agent.config.systemPrompt).not.toContain('# Coordinator Mode');
  });
});
