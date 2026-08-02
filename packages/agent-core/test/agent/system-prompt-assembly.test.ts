import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import { InMemoryAgentRecordPersistence, type AgentRecordOf } from '../../src/agent/records';
import type { Logger } from '../../src/logging';
import {
  changedSectionIds,
  DEFAULT_AGENT_PROFILES,
  SystemPromptAssembly,
  type PreparedSystemPromptContext,
  type SystemPromptContext,
} from '../../src/profile';
import { testAgent, type TestAgentContext } from './harness/agent';

/** sha256 hex — the same whole-prompt hash the recorder's fingerprint computes. */
function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function recordsOf<T extends AgentRecord['type']>(
  persistence: InMemoryAgentRecordPersistence,
  type: T,
): AgentRecordOf<T>[] {
  return persistence.records.filter(
    (record): record is AgentRecordOf<T> => record.type === type,
  );
}

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

interface RecordedLog {
  readonly message: string;
  readonly payload?: unknown;
}

/** A silent logger that captures warn/info entries for diagnostics assertions. */
function mockLogger(): { logger: Logger; warnings: RecordedLog[]; infos: RecordedLog[] } {
  const warnings: RecordedLog[] = [];
  const infos: RecordedLog[] = [];
  const logger: Logger = {
    error: () => {},
    warn: (message, payload) => {
      warnings.push({ message, payload });
    },
    info: (message, payload) => {
      infos.push({ message, payload });
    },
    debug: () => {},
    createChild: () => logger,
  };
  return { logger, warnings, infos };
}

/** Deterministic refresh context: refreshSystemPrompt never touches the fs. */
const STABLE_CONTEXT: PreparedSystemPromptContext = {
  cwdListing: 'LISTING',
  agentsMd: 'AGENTS_MD',
  additionalDirsInfo: '',
};
const stableContextProvider = () => Promise.resolve(STABLE_CONTEXT);

const agentProfile = () => DEFAULT_AGENT_PROFILES['agent']!;

describe('system prompt assembly wiring', () => {
  it('stores the profile render byte-identically through the sectioned assembly', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.useProfile(agentProfile());

    const expected = agentProfile().systemPrompt({
      osEnv: ctx.agent.kaos.osEnv,
      cwd: ctx.agent.config.cwd,
      now: ctx.agent.systemPromptNow,
    });
    expect(ctx.agent.config.systemPrompt).toBe(expected);

    const snapshot = ctx.agent.systemPromptSections.snapshot()!;
    expect(snapshot.sections.length).toBeGreaterThan(1);
    expect(snapshot.sections[snapshot.dynamicBoundaryIndex]!.id).toBe('language');
  });

  it('applies the configured output style to the rendered prompt and switches live', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, outputStyle: 'concise' },
      systemPromptContextProvider: stableContextProvider,
    });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());

    const styledPrompt = ctx.agent.config.systemPrompt;
    expect(styledPrompt).toContain('as few words as clarity allows');
    expect(styledPrompt).not.toContain('teammate who stepped away');
    // The style-name marker lets the model self-report its active style.
    expect(styledPrompt).toContain('Output style: concise');
    const styled = ctx.agent.systemPromptSections.snapshot()!;
    const communicating = styled.sections.find(
      (section) => section.id === 'communicating-with-user',
    )!;
    expect(communicating.style).toBe('concise');

    // Live switch: one re-render, the new style latched.
    await ctx.agent.setOutputStyle('explanatory');
    expect(ctx.agent.config.systemPrompt).toContain('this style is educational');
    expect(ctx.agent.config.systemPrompt).toContain('Output style: explanatory');
    expect(ctx.agent.config.systemPrompt).not.toContain('Output style: concise');
    expect(ctx.agent.config.systemPrompt).not.toBe(styledPrompt);

    // Clearing restores the stock render, with no style markers left.
    await ctx.agent.setOutputStyle(undefined);
    expect(ctx.agent.config.systemPrompt).toContain('teammate who stepped away');
    expect(ctx.agent.config.systemPrompt).not.toContain('Output style:');
    const restored = ctx.agent.systemPromptSections.snapshot()!;
    expect(restored.sections.every((section) => section.style === undefined)).toBe(true);
  });

  it('attributes a dynamic-section refresh to its id and keeps static hashes fixed', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    // Baseline render WITH the refresh context, so the later `/language`
    // switch moves exactly one dynamic section.
    await ctx.agent.refreshSystemPrompt();
    const before = ctx.agent.systemPromptSections.snapshot()!;

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    // A `/language` switch re-renders exactly one dynamic section.
    await ctx.agent.setUserLanguage('简体中文');
    const after = ctx.agent.systemPromptSections.snapshot()!;
    expect(after.prompt).not.toBe(before.prompt);
    expect(changedSectionIds(before, after)).toEqual(['language']);
    for (const section of after.sections.filter((section) => section.cache === 'static')) {
      const counterpart = before.sections.find((candidate) => candidate.id === section.id)!;
      expect(section.hash).toBe(counterpart.hash);
    }

    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prefixDriftReasons).toEqual(['system']);
    expect(requests[1]!.systemPromptChangedSections).toEqual(['language']);
  });

  it('leaves attribution absent when the drifted prompt is not a known assembly', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    // A direct config.update override bypasses the section assembly, so the
    // drift keeps its dimension but gains no section list.
    ctx.agent.config.update({ systemPrompt: 'You are an overridden test agent.' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prefixDriftReasons).toEqual(['system']);
    expect(requests[1]!.systemPromptChangedSections).toBeUndefined();
  });
});

describe('system prompt append bus', () => {
  it('hangs addenda at the tail with a normalized separator and restores on clear', async () => {
    const ctx = testAgent({ systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    await ctx.agent.refreshSystemPrompt();
    const base = ctx.agent.config.systemPrompt;
    expect(base).toMatch(/The current date and time in ISO format is `[^`]+`/);

    ctx.agent.setSystemPromptAddendum('note', 'EXTRA TAIL');
    const withNote = `${base.replace(/\n+$/, '')}\n\nEXTRA TAIL`;
    expect(ctx.agent.config.systemPrompt).toBe(withNote);
    const appended = ctx.agent.systemPromptSections
      .snapshot()!
      .sections.find((section) => section.id === 'append:note')!;
    expect(appended.origin).toBe('append');
    expect(appended.cache).toBe('dynamic');

    // Same id replaces in place; bus order is insertion order.
    ctx.agent.setSystemPromptAddendum('note', 'V2');
    ctx.agent.setSystemPromptAddendum('other', 'OTHER');
    expect(ctx.agent.config.systemPrompt).toBe(`${base.replace(/\n+$/, '')}\n\nV2\n\nOTHER`);

    // Byte-identical refreshes keep the addendum tail.
    await ctx.agent.refreshSystemPrompt();
    expect(ctx.agent.config.systemPrompt).toBe(`${base.replace(/\n+$/, '')}\n\nV2\n\nOTHER`);

    ctx.agent.clearSystemPromptAddendum('note');
    expect(ctx.agent.config.systemPrompt).toBe(`${base.replace(/\n+$/, '')}\n\nOTHER`);
    ctx.agent.clearSystemPromptAddendum('other');
    expect(ctx.agent.config.systemPrompt).toBe(base);
    // Unknown id: no change, no record churn.
    ctx.agent.clearSystemPromptAddendum('never-added');
    expect(ctx.agent.config.systemPrompt).toBe(base);
  });

  it('applies addenda queued before the first profile render', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.setSystemPromptAddendum('early', 'EARLY');
    expect(ctx.agent.config.systemPrompt).not.toContain('EARLY');

    ctx.agent.useProfile(agentProfile());
    expect(ctx.agent.config.systemPrompt.endsWith('\n\nEARLY')).toBe(true);
  });

  it('never composes with or clobbers a live override prompt', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    const base = ctx.agent.config.systemPrompt;

    ctx.agent.setSystemPromptAddendum('note', 'EXTRA');
    expect(ctx.agent.config.systemPrompt).toContain('EXTRA');

    // Override replaces the assembled prompt wholesale.
    ctx.agent.config.update({ systemPrompt: 'OVERRIDE' });

    // Unknown-id clear is a true no-op: it must not re-assemble over the
    // override.
    ctx.agent.clearSystemPromptAddendum('never-added');
    expect(ctx.agent.config.systemPrompt).toBe('OVERRIDE');

    // Real bus operations register but do not clobber the override either —
    // Claude's override branch returns the override WITHOUT append.
    ctx.agent.setSystemPromptAddendum('late', 'LATE');
    expect(ctx.agent.config.systemPrompt).toBe('OVERRIDE');
    ctx.agent.clearSystemPromptAddendum('note');
    expect(ctx.agent.config.systemPrompt).toBe('OVERRIDE');

    // The next profile render resumes the assembly and applies the bus as
    // registered: 'note' cleared, 'late' present, 'EXTRA' gone.
    ctx.agent.useProfile(agentProfile());
    expect(ctx.agent.config.systemPrompt).toBe(`${base.replace(/\n+$/, '')}\n\nLATE`);
  });

  it('reproduces the persisted prompt after resume once the session re-applies the bus', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, systemPromptContextProvider: stableContextProvider });
    ctx.configure();
    ctx.agent.useProfile(agentProfile());
    ctx.agent.setSystemPromptAddendum('note', 'EXTRA');
    const promptBefore = ctx.agent.config.systemPrompt;

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    const resumedPersistence = new InMemoryAgentRecordPersistence(
      structuredClone(persistence.records),
    );
    const resumed = testAgent({
      persistence: resumedPersistence,
      systemPromptContextProvider: stableContextProvider,
    });
    await resumed.agent.resume();
    // The session-owned contract: the profile is re-activated and the bus
    // re-applied after resume; `CLOUD_CODE_NOW` latches out of the persisted
    // (addendum-carrying) prompt, so the bytes reproduce exactly.
    resumed.agent.useProfile(agentProfile());
    resumed.agent.setSystemPromptAddendum('note', 'EXTRA');
    expect(resumed.agent.config.systemPrompt).toBe(promptBefore);

    resumed.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(resumed, 'second');

    const requestsBefore = recordsOf(persistence, 'llm.request');
    const requestsAfter = recordsOf(resumedPersistence, 'llm.request');
    expect(requestsAfter.at(-1)!.systemPromptHash).toBe(requestsBefore.at(-1)!.systemPromptHash);
    expect(requestsAfter.at(-1)!.prefixDriftReasons).toBeUndefined();
  });
});

describe('SystemPromptAssembly disciplines', () => {
  function renderAgent(vars?: Partial<SystemPromptContext>): string {
    return agentProfile().systemPrompt({
      osEnv: {
        osKind: 'Linux',
        osArch: 'x86_64',
        osVersion: 'test',
        shellName: 'bash',
        shellPath: '/bin/bash',
      },
      cwd: '/workspace',
      now: '2026-05-09T00:00:00.000Z',
      ...vars,
    });
  }

  it('warns when a static section drifts between same-profile assemblies', () => {
    const { logger, warnings } = mockLogger();
    const assembly = new SystemPromptAssembly({ log: logger });
    const base = renderAgent();
    assembly.assemble('agent', base);

    // Dynamic-section movement (AGENTS.md refresh): attributed, not warned.
    assembly.assemble('agent', renderAgent({ agentsMd: 'REFRESHED' }));
    expect(warnings.filter((warning) => warning.message.includes('static sections'))).toHaveLength(
      0,
    );

    // Static-section movement: an undeclared volatile input — loud warning.
    const tampered = base.replace(
      'Do not use a colon before tool calls',
      'Never use a colon before tool calls',
    );
    expect(tampered).not.toBe(base);
    assembly.assemble('agent', tampered);
    const staticWarnings = warnings.filter(
      (warning) => warning.message === 'system prompt static sections drifted between assemblies',
    );
    expect(staticWarnings).toHaveLength(1);
    expect(staticWarnings[0]!.payload).toMatchObject({
      profileName: 'agent',
      sections: 'prompt-and-tool-use',
    });
  });

  it('does not warn across a profile switch', () => {
    const { logger, warnings } = mockLogger();
    const assembly = new SystemPromptAssembly({ log: logger });
    assembly.assemble('agent', renderAgent());
    assembly.assemble('coder', renderAgent({ roleAdditional: 'You are a subagent.' }));
    expect(warnings).toHaveLength(0);
  });

  it('dumps per-section token accounting only while diagnostics are enabled', () => {
    const { logger, infos } = mockLogger();
    const rendered = renderAgent();

    const gated = new SystemPromptAssembly({ log: logger, isDiagnosticsEnabled: () => true });
    gated.assemble('agent', rendered);
    const dumps = infos.filter((info) => info.message === 'llm system prompt sections');
    expect(dumps).toHaveLength(1);
    const payload = dumps[0]!.payload as {
      profileName: string;
      sectionCount: number;
      dynamicBoundary: string;
      staticPrefixTokens: number;
      totalTokens: number;
      sections: { id: string; cache: string; origin: string; tokens: number; hash: string }[];
    };
    expect(payload.profileName).toBe('agent');
    expect(payload.dynamicBoundary).toBe('language');
    expect(payload.sectionCount).toBe(payload.sections.length);
    expect(payload.sections[0]).toMatchObject({ id: 'identity', cache: 'static', origin: 'profile' });
    expect(payload.sections[0]!.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.totalTokens).toBe(
      payload.sections.reduce((total, section) => total + section.tokens, 0),
    );
    expect(payload.staticPrefixTokens).toBe(payload.sections[0]!.tokens);

    // Byte-identical re-assembly does not re-dump.
    gated.assemble('agent', rendered);
    expect(infos.filter((info) => info.message === 'llm system prompt sections')).toHaveLength(1);

    // Gate off: silent.
    const off = new SystemPromptAssembly({ log: logger, isDiagnosticsEnabled: () => false });
    off.assemble('agent', renderAgent({ agentsMd: 'OTHER' }));
    expect(infos.filter((info) => info.message === 'llm system prompt sections')).toHaveLength(1);
  });

  it('gates the agent-level dump on CLOUD_CODE_DEBUG_CACHE', () => {
    vi.stubEnv('CLOUD_CODE_DEBUG_CACHE', '1');
    try {
      const { logger, infos } = mockLogger();
      const ctx = testAgent({ log: logger });
      ctx.configure();
      ctx.agent.useProfile(agentProfile());
      expect(infos.filter((info) => info.message === 'llm system prompt sections')).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns undefined attribution for prompts it never assembled', () => {
    const { logger } = mockLogger();
    const assembly = new SystemPromptAssembly({ log: logger });
    const first = assembly.assemble('agent', renderAgent());
    const second = assembly.assemble('agent', renderAgent({ agentsMd: 'OTHER' }));
    expect(assembly.attributeDrift('0'.repeat(64), '1'.repeat(64))).toBeUndefined();
    // Both sides known: attribution names the moved section.
    expect(assembly.attributeDrift(promptHash(first.prompt), promptHash(second.prompt))).toEqual([
      'project-information',
    ]);
    // Identical hashes attribute to an empty change set.
    expect(assembly.attributeDrift(promptHash(first.prompt), promptHash(first.prompt))).toEqual([]);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
