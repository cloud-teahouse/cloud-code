import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        model: 'kimi-model',
        permissionMode: 'auto',
        turnUsage: undefined,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      noteTokenActivity: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    updateActivityPane: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  // oxlint-disable-next-line no-explicit-any -- test harness mocks the host structurally
  return host as any;
}

function turnStarted() {
  return {
    type: 'turn.started',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    origin: { kind: 'user' },
  } as const;
}

function stepCompleted(
  step: number,
  usage?: { inputOther: number; inputCacheRead: number; inputCacheCreation: number; output: number },
) {
  return {
    type: 'turn.step.completed',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    step,
    ...(usage === undefined ? {} : { usage }),
  } as const;
}

describe('SessionEventHandler turn usage accumulation', () => {
  it('resets turn usage on turn.started and mirrors step usage into AppState', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    expect(host.state.appState.turnUsage).toBeNull();

    handler.handleEvent(
      stepCompleted(1, { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 25, output: 10 }),
      vi.fn(),
    );
    expect(host.state.appState.turnUsage).toEqual({
      inputOther: 100,
      inputCacheRead: 50,
      inputCacheCreation: 25,
      output: 10,
    });
  });

  it('sums usage across the steps of a single turn', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.handleEvent(
      stepCompleted(1, { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 25, output: 10 }),
      vi.fn(),
    );
    handler.handleEvent(
      stepCompleted(2, { inputOther: 200, inputCacheRead: 0, inputCacheCreation: 0, output: 5 }),
      vi.fn(),
    );

    expect(host.state.appState.turnUsage).toEqual({
      inputOther: 300,
      inputCacheRead: 50,
      inputCacheCreation: 25,
      output: 15,
    });
  });

  it('leaves the breakdown untouched for steps without usage and clears it on the next turn', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.handleEvent(
      stepCompleted(1, { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 25, output: 10 }),
      vi.fn(),
    );
    handler.handleEvent(stepCompleted(2), vi.fn());
    expect(host.state.appState.turnUsage).toEqual({
      inputOther: 100,
      inputCacheRead: 50,
      inputCacheCreation: 25,
      output: 10,
    });

    handler.handleEvent(turnStarted(), vi.fn());
    expect(host.state.appState.turnUsage).toBeNull();
  });
});
