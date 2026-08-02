import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

/**
 * Turn-id adoption rules in SessionEventHandler.handleEvent: a turn id may be
 * opened by turn.started and updated while the turn is active, but a straggler
 * event after turn.ended (e.g. tool.progress, whose turnId is mandatory) must
 * not resurrect the finished turn's id.
 */
function makeHost() {
  let currentTurnId: string | undefined;
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
      setTurnId: vi.fn((turnId: string | undefined) => {
        currentTurnId = turnId;
      }),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      // finalizeTurn mirrors the real StreamingUIController: it clears the
      // active turn id once the turn has ended.
      finalizeTurn: vi.fn(() => {
        currentTurnId = undefined;
      }),
      noteTokenActivity: vi.fn(),
      hasActiveTurn: vi.fn(() => currentTurnId !== undefined),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
      getToolComponent: vi.fn(() => undefined),
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

function turnEnded() {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as const;
}

function toolProgress() {
  return {
    type: 'tool.progress',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    toolCallId: 'tc-1',
    update: { kind: 'status', text: 'still working' },
  } as const;
}

describe('SessionEventHandler turn id adoption', () => {
  it('adopts turn ids while a turn is active and ignores stragglers after turn.ended', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const sendQueued = vi.fn();

    handler.handleEvent(turnStarted(), sendQueued);
    expect(host.streamingUI.setTurnId).toHaveBeenCalledWith('1');
    expect(host.streamingUI.hasActiveTurn()).toBe(true);

    host.streamingUI.setTurnId.mockClear();
    handler.handleEvent(toolProgress(), sendQueued);
    expect(host.streamingUI.setTurnId).toHaveBeenCalledWith('1');

    handler.handleEvent(turnEnded(), sendQueued);
    expect(host.streamingUI.hasActiveTurn()).toBe(false);

    host.streamingUI.setTurnId.mockClear();
    handler.handleEvent(toolProgress(), sendQueued);
    expect(host.streamingUI.setTurnId).not.toHaveBeenCalled();
    expect(host.streamingUI.hasActiveTurn()).toBe(false);
  });

  it('still opens a new turn via turn.started after the previous one ended', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const sendQueued = vi.fn();

    handler.handleEvent(turnStarted(), sendQueued);
    handler.handleEvent(turnEnded(), sendQueued);
    expect(host.streamingUI.hasActiveTurn()).toBe(false);

    host.streamingUI.setTurnId.mockClear();
    handler.handleEvent(turnStarted(), sendQueued);
    expect(host.streamingUI.setTurnId).toHaveBeenCalledWith('1');
    expect(host.streamingUI.hasActiveTurn()).toBe(true);
  });
});
