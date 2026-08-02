// First-token latency — recorded once per turn (turn start → first visible
// delta) into a last-10 rolling window, cleared on session reset.

import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        model: 'm',
        permissionMode: 'auto',
        turnUsage: undefined,
        recentFirstTokenLatencies: undefined as number[] | undefined,
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
      getToolComponent: vi.fn(() => undefined),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    }),
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
    backgroundTasks: new Map(),
    backgroundTaskTranscriptedTerminal: new Set(),
    subAgentEventHandler: { resetRuntimeState: vi.fn() },
    workflowTracker: { reset: vi.fn() },
    renderedSkillActivationIds: new Set(),
    renderedPluginCommandActivationIds: new Set(),
    renderedMcpServerStatusKeys: new Set(),
    mcpServers: new Map(),
    goalCompletionAwaitingClear: false,
    goalCompletionTurnEnded: false,
    currentTurnHasAssistantText: false,
    currentTurnHasVisibleOutput: false,
    recallableTurnInput: undefined,
    currentTurnUsage: null,
    currentTurnStartedAtMs: 0,
    pendingModelBlockedFallback: undefined,
    queuedGoalPromotionPending: false,
    queuedGoalPromotionInFlight: false,
    markActiveAgentSwarmsCancelled: vi.fn(),
    renderPendingModelBlockedFallback: vi.fn(),
    scheduleQueuedGoalPromotion: vi.fn(),
  };
  // oxlint-disable-next-line no-explicit-any -- structural test double
  return host as any;
}

const turnStarted = () => ({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' } }) as const;
const assistantDelta = () => ({ type: 'assistant.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'hello' }) as const;
const thinkingDelta = () => ({ type: 'thinking.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'hmm' }) as const;

describe('first-token latency accumulation', () => {
  it('records turn start → first delta once per turn, capped at 10, cleared on reset', () => {
    vi.useFakeTimers();
    try {
      const host = makeHost();
      const handler = new SessionEventHandler(host);
      const sendQueued = vi.fn();

      for (let i = 1; i <= 12; i++) {
        handler.handleEvent(turnStarted(), sendQueued);
        vi.advanceTimersByTime(i * 100);
        handler.handleEvent(assistantDelta(), sendQueued);
        // A second delta in the same turn must not double-record.
        handler.handleEvent(assistantDelta(), sendQueued);
      }

      const latencies = host.state.appState.recentFirstTokenLatencies;
      expect(latencies).toHaveLength(10);
      expect(latencies[0]).toBe(300);
      expect(latencies.at(-1)).toBe(1200);

      handler.resetRuntimeState();
      expect(host.state.appState.recentFirstTokenLatencies).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records on the first thinking delta too, and never before any delta', () => {
    vi.useFakeTimers();
    try {
      const host = makeHost();
      const handler = new SessionEventHandler(host);
      const sendQueued = vi.fn();

      handler.handleEvent(turnStarted(), sendQueued);
      expect(host.state.appState.recentFirstTokenLatencies).toBeUndefined();
      vi.advanceTimersByTime(250);
      handler.handleEvent(thinkingDelta(), sendQueued);
      expect(host.state.appState.recentFirstTokenLatencies).toEqual([250]);
    } finally {
      vi.useRealTimers();
    }
  });
});
