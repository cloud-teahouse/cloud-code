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
      appendThinkingDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: '1', step: 1 })),
      registerToolCall: vi.fn(),
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

function assistantDelta(delta: string) {
  return {
    type: 'assistant.delta',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    delta,
  } as const;
}

function thinkingDelta(delta: string) {
  return {
    type: 'thinking.delta',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    delta,
  } as const;
}

function toolCallStarted() {
  return {
    type: 'tool.call.started',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    toolCallId: 'tc-1',
    name: 'Bash',
    args: { command: 'ls' },
  } as const;
}

function turnEnded(reason: 'completed' | 'cancelled') {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason,
  } as const;
}

describe('SessionEventHandler T2 interrupt recall', () => {
  it('recalls the recorded input when the turn produced no visible output, consuming the record', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';

    expect(handler.consumeInterruptRecall()).toEqual({
      text: 're-edit me',
      transcriptEntryIds: [],
    });
    // Consumed: a second interrupt has nothing to recall.
    expect(handler.consumeInterruptRecall()).toBeUndefined();
  });

  it('carries the recorded transcript entry ids so the caller can drop the echo', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';
    handler.recallableTranscriptEntryIds = ['entry-1'];

    expect(handler.consumeInterruptRecall()).toEqual({
      text: 're-edit me',
      transcriptEntryIds: ['entry-1'],
    });
    expect(handler.recallableTranscriptEntryIds).toBeUndefined();
  });

  it('withholds the recall once an assistant text delta streamed', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';
    handler.handleEvent(assistantDelta('partial answer'), vi.fn());

    expect(handler.consumeInterruptRecall()).toBeUndefined();
  });

  it('withholds the recall once a tool call started', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';
    handler.handleEvent(toolCallStarted(), vi.fn());

    expect(handler.consumeInterruptRecall()).toBeUndefined();
  });

  it('still recalls when only whitespace text or thinking streamed', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';
    handler.handleEvent(assistantDelta('   '), vi.fn());
    handler.handleEvent(thinkingDelta('let me think'), vi.fn());

    expect(handler.consumeInterruptRecall()?.text).toBe('re-edit me');
  });

  it('clears the record on turn end so a later turn (e.g. cron) cannot recall a stale prompt', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 're-edit me';
    handler.recallableTranscriptEntryIds = ['entry-1'];
    handler.handleEvent(turnEnded('cancelled'), vi.fn());

    expect(handler.recallableTranscriptEntryIds).toBeUndefined();
    // A new turn that never recorded an input (cron-fired, goal promotion…).
    handler.handleEvent(turnStarted(), vi.fn());
    expect(handler.consumeInterruptRecall()).toBeUndefined();
  });

  it('clears the visible-output flag and the record on resetRuntimeState', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 'first';
    handler.handleEvent(assistantDelta('output'), vi.fn());
    handler.resetRuntimeState();

    expect(handler.recallableTurnInput).toBeUndefined();
    expect(handler.recallableTranscriptEntryIds).toBeUndefined();
    // The flag reset means a freshly recorded input recalls again.
    handler.recallableTurnInput = 'second';
    expect(handler.consumeInterruptRecall()?.text).toBe('second');
  });

  it('resets the visible-output flag on each new turn', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    handler.handleEvent(assistantDelta('output'), vi.fn());
    handler.handleEvent(turnEnded('completed'), vi.fn());

    handler.handleEvent(turnStarted(), vi.fn());
    handler.recallableTurnInput = 'second turn input';
    expect(handler.consumeInterruptRecall()?.text).toBe('second turn input');
  });
});
