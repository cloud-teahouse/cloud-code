import { describe, expect, it, vi } from 'vitest';

import type { AgentReplayRecord } from '@cloud-code/sdk';

import { CloudCodeTUI, type CloudCodeTUIStartupInput, type TUIState } from '#/tui/cloud-code-tui';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StepSummaryComponent } from '#/tui/components/messages/step-summary';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { SessionReplayRenderer, type SessionReplayHost } from '#/tui/controllers/session-replay';
import { t } from '#/tui/i18n';
import { TRANSCRIPT_KEEP_RECENT_STEPS } from '#/tui/utils/transcript-window';

function makeStartupInput(): CloudCodeTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'auto',
      disablePasteBurst: false,
      fullscreen: false,
      editorCommand: null,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeLongTurnReplay(toolCallCount: number): AgentReplayRecord[] {
  const records: unknown[] = [
    {
      type: 'message',
      time: 1,
      message: { role: 'user', content: [{ type: 'text', text: 'run the task' }] },
    },
  ];
  for (let i = 0; i < toolCallCount; i++) {
    const id = `tc-${i}`;
    records.push(
      {
        type: 'message',
        time: 2 + i * 2,
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ id, name: 'Bash', arguments: '{"command":"ls"}' }],
        },
      },
      {
        type: 'message',
        time: 3 + i * 2,
        message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }] },
      },
    );
  }
  records.push({
    type: 'message',
    time: 2 + toolCallCount * 2,
    message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }], toolCalls: [] },
  });
  return records as AgentReplayRecord[];
}

function makeResumedAgent(replay: AgentReplayRecord[]) {
  return {
    type: 'main',
    config: { modelAlias: 'k2' },
    context: { history: [], tokenCount: 0 },
    replay,
    permission: { mode: 'manual' },
    plan: null,
    swarmMode: false,
    coordinatorMode: false,
    usage: {},
    tools: [],
    background: [],
  };
}

function makeSession(replay: AgentReplayRecord[]) {
  return {
    id: 'ses-replay',
    model: 'k2',
    summary: { title: 'Replay session' },
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    getGoal: vi.fn(async () => ({ goal: null })),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: { main: makeResumedAgent(replay) },
    })),
    getSessionWarnings: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    listPlugins: vi.fn(async () => []),
    onEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeHarness(session: ReturnType<typeof makeSession>) {
  const interactiveAgentScope = new (class {
    private store: string | undefined;
    getStore() {
      return this.store;
    }
    run<T>(agentId: string, fn: () => T): T {
      this.store = agentId;
      try {
        return fn();
      } finally {
        this.store = undefined;
      }
    }
  })();
  return {
    getConfig: vi.fn(async () => ({
      models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
    })),
    setConfig: vi.fn(async () => ({ providers: {} })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    forkSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    get interactiveAgentId() {
      return interactiveAgentScope.getStore() ?? 'main';
    },
    withInteractiveAgent: vi.fn((agentId: string, fn: () => unknown) =>
      interactiveAgentScope.run(agentId, fn),
    ),
    getExperimentalFeatures: vi.fn(async () => []),
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      getAccountSnapshot: vi.fn(async () => ({ state: 'not-logged-in' })),
    },
  };
}

interface ReplayDriver {
  state: TUIState;
  init(): Promise<boolean>;
  switchToSession(session: unknown, statusMessage: string): Promise<void>;
  mergeAllTurnSteps(): void;
  foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean;
  persistInputHistory: () => Promise<void>;
}

async function makeDriver(session: ReturnType<typeof makeSession>): Promise<ReplayDriver> {
  const harness = makeHarness(session);
  const driver = new CloudCodeTUI(harness as never, makeStartupInput()) as unknown as ReplayDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  driver.persistInputHistory = vi.fn(async () => {});
  await driver.init();
  return driver;
}

describe('session replay folding', () => {
  it('folds a long replayed turn in a single pass instead of per appended step', async () => {
    const toolCallCount = 80;
    const driver = await makeDriver(makeSession(makeLongTurnReplay(toolCallCount)));
    const foldSpy = vi.spyOn(driver, 'foldCurrentTurnContent');
    const mergeAllSpy = vi.spyOn(driver, 'mergeAllTurnSteps');

    await driver.switchToSession(makeSession(makeLongTurnReplay(toolCallCount)), 'resumed');

    expect(foldSpy).not.toHaveBeenCalled();
    expect(mergeAllSpy).toHaveBeenCalledTimes(1);

    const children = driver.state.transcriptContainer.children;
    const toolComponents = children.filter((child) => child instanceof ToolCallComponent);
    const summaries = children.filter((child) => child instanceof StepSummaryComponent);
    expect(children.filter((child) => child instanceof UserMessageComponent)).toHaveLength(1);
    expect(children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(1);
    expect(toolComponents).toHaveLength(TRANSCRIPT_KEEP_RECENT_STEPS);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.render(80).join('')).toContain(
      t('swarm.stepSummary.tools', { count: toolCallCount - TRANSCRIPT_KEEP_RECENT_STEPS }),
    );
  });

  it('leaves a short replayed turn unfolded', async () => {
    const driver = await makeDriver(makeSession(makeLongTurnReplay(2)));
    const foldSpy = vi.spyOn(driver, 'foldCurrentTurnContent');
    const mergeAllSpy = vi.spyOn(driver, 'mergeAllTurnSteps');

    await driver.switchToSession(makeSession(makeLongTurnReplay(2)), 'resumed');

    expect(foldSpy).not.toHaveBeenCalled();
    expect(mergeAllSpy).toHaveBeenCalledTimes(1);
    const children = driver.state.transcriptContainer.children;
    expect(children.filter((child) => child instanceof StepSummaryComponent)).toHaveLength(0);
    expect(children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(2);
  });
});

describe('session replay event-loop yields', () => {
  function makeHost(): SessionReplayHost {
    return {
      state: {
        footer: { setBackgroundCounts: vi.fn() },
        ui: { requestRender: vi.fn() },
      },
      streamingUI: {
        setTodoList: vi.fn(),
        applyBackgroundTaskTerminalStatus: vi.fn(),
        setTurnId: vi.fn(),
        setStep: vi.fn(),
        onThinkingUpdate: vi.fn(),
        onThinkingEnd: vi.fn(),
        onStreamingTextStart: vi.fn(),
        onStreamingTextUpdate: vi.fn(),
        onStreamingTextEnd: vi.fn(),
        clearAssistantDraft: vi.fn(),
        setActiveToolCall: vi.fn(),
        onToolCallStart: vi.fn(),
        onToolCallEnd: vi.fn(),
        removeActiveToolCall: vi.fn(),
        cleanupAfterReplay: vi.fn(),
      },
      sessionEventHandler: {
        subAgentEventHandler: { backgroundAgentMetadata: new Map() },
        backgroundTasks: new Map(),
        backgroundTaskTranscriptedTerminal: new Set(),
        renderedSkillActivationIds: new Set(),
        renderedPluginCommandActivationIds: new Set(),
      },
      setAppState: vi.fn(),
      showError: vi.fn(),
      appendTranscriptEntry: vi.fn(),
      mergeAllTurnSteps: vi.fn(),
    } as unknown as SessionReplayHost;
  }

  it('yields to the event loop while rendering a long replay', async () => {
    const host = makeHost();
    const renderer = new SessionReplayRenderer(host);
    const recordCount = 120;
    const replay: AgentReplayRecord[] = Array.from({ length: recordCount }, (_, i) => ({
      type: 'message',
      time: i,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `line ${i}` }],
        toolCalls: [],
      },
    })) as AgentReplayRecord[];
    const session = {
      getResumeState: () => ({ agents: { main: makeResumedAgent(replay) } }),
    };

    let yielded = false;
    const done = renderer.hydrateFromReplay(session as never);
    setImmediate(() => {
      yielded = true;
    });
    await expect(done).resolves.toBe(true);

    // With a fully synchronous render loop this callback could only run after
    // hydration finished; it must have fired mid-replay.
    expect(yielded).toBe(true);
    expect(host.streamingUI.onStreamingTextStart).toHaveBeenCalledTimes(recordCount);
    expect(host.mergeAllTurnSteps).toHaveBeenCalledTimes(1);
  });
});
