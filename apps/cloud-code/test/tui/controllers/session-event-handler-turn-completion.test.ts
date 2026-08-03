import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TurnCompletionComponent } from '#/tui/components/messages/turn-completion';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { setLocalePreference } from '#/tui/i18n';
import { getBuiltInPalette } from '#/tui/theme';
import { TURN_COMPLETION_SYMBOLS } from '#/tui/utils/turn-completion';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        model: 'kimi-model',
        permissionMode: 'auto',
        turnUsage: undefined,
        rateLimitPause: null,
        isReplaying: false,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn(), children: [] },
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
      setTodoList: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: undefined, step: 0 })),
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
    confirmUserEcho: vi.fn(),
    updateTerminalTitle: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  // oxlint-disable-next-line no-explicit-any -- test harness mocks the host structurally
  return host as any;
}

function turnStarted(turnId = 1) {
  return {
    type: 'turn.started',
    sessionId: 's1',
    agentId: 'main',
    turnId,
    origin: { kind: 'user' },
  } as const;
}

function turnEnded(reason: 'completed' | 'cancelled' | 'failed', turnId = 1) {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId,
    reason,
  } as const;
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function completionComponentsOf(host: ReturnType<typeof makeHost>): TurnCompletionComponent[] {
  return host.state.transcriptContainer.addChild.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((child: unknown): child is TurnCompletionComponent => child instanceof TurnCompletionComponent);
}

describe('SessionEventHandler turn completion line', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts a gray "<symbol> <verb> for <duration>s" transcript line when a turn completes', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    vi.advanceTimersByTime(10_000);
    handler.handleEvent(turnEnded('completed'), vi.fn());

    const lines = completionComponentsOf(host);
    expect(lines).toHaveLength(1);
    const rendered = lines[0]!.render(120).map((line) => strip(line));
    // One blank line, then the dim flavor line.
    expect(rendered[0]).toBe('');
    const body = rendered[1]!.trim();
    const symbol = body.slice(0, 1);
    expect(TURN_COMPLETION_SYMBOLS).toContain(symbol);
    expect(body).toMatch(/for 10s$/);
  });

  it('no longer routes the verb line to the transient notice slot', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    vi.advanceTimersByTime(10_000);
    handler.handleEvent(turnEnded('completed'), vi.fn());

    // Functional indicators still flow through finalizeTurn / live-pane reset;
    // only the flavor line left the slot.
    expect(host.streamingUI.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('uses the turn wall-clock duration, rounded to seconds', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    vi.advanceTimersByTime(65_400);
    handler.handleEvent(turnEnded('completed'), vi.fn());

    const lines = completionComponentsOf(host);
    expect(lines).toHaveLength(1);
    const text = lines[0]!.render(120).map((line) => strip(line)).join('\n');
    expect(text).toContain('for 1m 5s');
  });

  it('renders the line in zh-CN when that locale is active', () => {
    setLocalePreference('zh-CN');
    try {
      const host = makeHost();
      const handler = new SessionEventHandler(host);

      handler.handleEvent(turnStarted(), vi.fn());
      vi.advanceTimersByTime(10_000);
      handler.handleEvent(turnEnded('completed'), vi.fn());

      const lines = completionComponentsOf(host);
      expect(lines).toHaveLength(1);
      const body = lines[0]!.render(120).map((line) => strip(line))[1]!.trim();
      expect(body).toMatch(/^[✢✳✶✻✽✦] \S+ 10 秒$/);
    } finally {
      setLocalePreference('en');
    }
  });

  it('skips the line for cancelled turns', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    vi.advanceTimersByTime(10_000);
    handler.handleEvent(turnEnded('cancelled'), vi.fn());

    expect(completionComponentsOf(host)).toHaveLength(0);
  });

  it('skips the line while replaying session history', () => {
    const host = makeHost();
    host.state.appState.isReplaying = true;
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted(), vi.fn());
    vi.advanceTimersByTime(10_000);
    handler.handleEvent(turnEnded('completed'), vi.fn());

    expect(completionComponentsOf(host)).toHaveLength(0);
  });
});
