/**
 * Output-style effectiveness end to end: a style switch must land in the NEXT
 * LLM request's system prompt — the stock communicating/delivering bodies
 * gone, the style's bodies in their place — and the style must survive every
 * later prompt-refresh path instead of being clobbered back to stock:
 *
 *   - the post-compaction `refreshSystemPrompt` re-render,
 *   - append-bus set/clear (which re-assembles from the tracked base sections),
 *   - session resume (records restore + the first re-render after it),
 *   - subagent spawns after a live switch (the child renders its own prompt
 *     from the session's style state).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { CloudCodeConfig } from '../../src/config/schema';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import {
  createScriptedGenerate,
} from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

// Deterministic prompt renders: git context collection is exercised in
// git-context.test.ts; here the snapshot stays empty so refreshes reproduce
// the bootstrap render byte-for-byte.
vi.mock('../../src/session/git-context', () => ({
  collectGitContext: vi.fn(async () => ''),
  getGitStatusSnapshot: vi.fn(async () => ''),
}));

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const STOCK_COMMUNICATING_ANCHOR = 'teammate who stepped away';
const STOCK_DELIVERING_ANCHOR = 'Do ordinary work as asked';
const REVIEWER_COMMUNICATING_ANCHOR = 'code review addressed to the author';
const REVIEWER_DELIVERING_ANCHOR = 'review report on your own change';

function expectReviewerStyle(prompt: string): void {
  expect(prompt).toContain(REVIEWER_COMMUNICATING_ANCHOR);
  expect(prompt).toContain(REVIEWER_DELIVERING_ANCHOR);
  expect(prompt).toContain('Output style: reviewer');
  expect(prompt).not.toContain(STOCK_COMMUNICATING_ANCHOR);
  expect(prompt).not.toContain(STOCK_DELIVERING_ANCHOR);
}

function expectStockStyle(prompt: string): void {
  expect(prompt).toContain(STOCK_COMMUNICATING_ANCHOR);
  expect(prompt).toContain(STOCK_DELIVERING_ANCHOR);
  expect(prompt).not.toContain(REVIEWER_COMMUNICATING_ANCHOR);
  expect(prompt).not.toContain(REVIEWER_DELIVERING_ANCHOR);
  expect(prompt).not.toContain('Output style:');
}

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

afterEach(async () => {
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((session) => session.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'output-style-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;
}

function makeSession(options: {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly config?: CloudCodeConfig;
}): Session {
  return track(
    new Session({
      id: options.id,
      kaos: testKaos.withCwd(options.workDir),
      homedir: options.sessionDir,
      rpc: createSessionRpc([]),
      initializeMainAgent: false,
      skills: { explicitDirs: [join(options.workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
      ...(options.config === undefined ? {} : { config: options.config }),
    }),
  );
}

async function createMainAgent(
  session: Session,
  scripted: ReturnType<typeof createScriptedGenerate>,
): Promise<Agent> {
  const { agent } = await session.createAgent(
    { type: 'main', generate: scripted.generate },
    { profile: DEFAULT_AGENT_PROFILES['agent']! },
  );
  agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  agent.permission.setMode('yolo');
  return agent;
}

async function runTurn(
  scripted: ReturnType<typeof createScriptedGenerate>,
  agent: Agent,
  text: string,
): Promise<void> {
  scripted.mockNextResponse({ type: 'text', text: `Reply to: ${text}` });
  agent.turn.prompt([{ type: 'text', text }]);
  await agent.turn.waitForCurrentTurn();
}

describe('output style effectiveness', () => {
  it('lands in the next request and survives refreshes and append-bus churn', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const scripted = createScriptedGenerate();
    const session = makeSession({ id: 'style-e2e-live', workDir, sessionDir });
    const agent = await createMainAgent(session, scripted);

    // Baseline: the stock prompt goes out before any switch.
    await runTurn(scripted, agent, 'first');
    expectStockStyle(scripted.calls[0]!.systemPrompt);

    await session.setOutputStyle('reviewer');

    // The very next request carries the style surface replacement.
    await runTurn(scripted, agent, 'second');
    expectReviewerStyle(scripted.calls[1]!.systemPrompt);

    // The post-compaction re-render path keeps the latched style.
    await agent.refreshSystemPrompt();
    await runTurn(scripted, agent, 'third');
    expectReviewerStyle(scripted.calls[2]!.systemPrompt);

    // Append-bus churn re-assembles from the tracked (styled) base sections.
    agent.setSystemPromptAddendum('note', 'EXTRA TAIL');
    expect(agent.config.systemPrompt).toContain('EXTRA TAIL');
    expectReviewerStyle(agent.config.systemPrompt);
    agent.clearSystemPromptAddendum('note');
    expect(agent.config.systemPrompt).not.toContain('EXTRA TAIL');
    expectReviewerStyle(agent.config.systemPrompt);
    await runTurn(scripted, agent, 'fourth');
    expectReviewerStyle(scripted.calls[3]!.systemPrompt);

    // Switching back to default restores the stock prompt.
    await session.setOutputStyle('default');
    await runTurn(scripted, agent, 'fifth');
    expectStockStyle(scripted.calls[4]!.systemPrompt);
  });

  it('survives session resume and the first re-render after it', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const config: CloudCodeConfig = { providers: {}, outputStyle: 'reviewer' };

    const before = createScriptedGenerate();
    const session = makeSession({ id: 'style-e2e-resume', workDir, sessionDir, config });
    const agent = await createMainAgent(session, before);
    await runTurn(before, agent, 'first');
    expectReviewerStyle(before.calls[0]!.systemPrompt);
    await session.close();

    // The host reopens the session with the persisted style in config.
    const resumed = makeSession({ id: 'style-e2e-resumed', workDir, sessionDir, config });
    await resumed.resume();
    const main = resumed.getReadyAgent('main')!;
    // The records-restored prompt is the styled one, without a re-render.
    expectReviewerStyle(main.config.systemPrompt);

    // The first re-render after resume re-applies the configured style
    // instead of dropping back to stock.
    await main.refreshSystemPrompt();
    expectReviewerStyle(main.config.systemPrompt);
  });

  it('applies to a subagent spawned after the live switch', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const scripted = createScriptedGenerate();
    const session = makeSession({ id: 'style-e2e-spawn', workDir, sessionDir });
    const agent = await createMainAgent(session, scripted);

    await runTurn(scripted, agent, 'first');
    expectStockStyle(scripted.calls[0]!.systemPrompt);

    await session.setOutputStyle('reviewer');

    // Turn 2: the main agent spawns a subagent through the Agent tool. The
    // child inherits the parent's generate, so the call order is: parent
    // request, child request, parent follow-up.
    scripted.mockNextResponse({
      type: 'function',
      id: 'call_review',
      name: 'Agent',
      arguments: JSON.stringify({
        prompt: 'Review the parser change.',
        description: 'Review parser change',
      }),
    });
    scripted.mockNextResponse({
      type: 'text',
      text: 'Verdict: the parser change is sound. Findings: none blocking. Evidence: the rewritten spec suite passes end to end and the fallback path is covered by the new fixture. Residual risk: the error-recovery branch is only exercised by a slow integration test.',
    });
    scripted.mockNextResponse({ type: 'text', text: 'The review came back clean.' });
    agent.turn.prompt([{ type: 'text', text: 'Delegate the review.' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls).toHaveLength(4);
    // The parent runs the style from the live switch...
    expectReviewerStyle(scripted.calls[1]!.systemPrompt);
    expectReviewerStyle(scripted.calls[3]!.systemPrompt);
    // ...and the child spawned after the switch renders its prompt with it too.
    expectReviewerStyle(scripted.calls[2]!.systemPrompt);
  });
});
