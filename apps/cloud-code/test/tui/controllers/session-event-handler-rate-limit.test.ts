import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        rateLimitPause: null,
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

function stepRetrying(delayMs: number) {
  return {
    type: 'turn.step.retrying',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    step: 1,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 10,
    delayMs,
    errorName: 'APIProviderRateLimitError',
    errorMessage: 'rate limited',
    statusCode: 429,
  } as const;
}

function rateLimitPaused(resumeAtMs: number, attempt = 1) {
  return {
    type: 'turn.rate_limit_paused',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    resumeAtMs,
    attempt,
  } as const;
}

function rateLimitResuming(attempt = 1) {
  return {
    type: 'turn.rate_limit_resuming',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    attempt,
  } as const;
}

describe('SessionEventHandler rate-limit retry/pause presentation (C1 P2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an in-backoff status for turn.step.retrying instead of ignoring it', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(stepRetrying(3200), vi.fn());

    expect(host.showStatus).toHaveBeenCalledTimes(1);
    const text = host.showStatus.mock.calls[0]![0] as string;
    expect(text).toContain('2/10');
    expect(text).toContain('4s');
  });

  it('renders a ticking countdown line for turn.rate_limit_paused', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(rateLimitPaused(1_000_000 + 90_000), vi.fn());

    expect(host.state.appState.rateLimitPause).toEqual({ resumeAtMs: 1_090_000, attempt: 1 });
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('01:30'), 'warning');

    // The line ticks down once per second.
    vi.advanceTimersByTime(1000);
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('01:29'), 'warning');
  });

  it('clears the countdown on turn.rate_limit_resuming', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(rateLimitPaused(1_000_000 + 90_000), vi.fn());
    handler.handleEvent(rateLimitResuming(1), vi.fn());

    expect(host.state.appState.rateLimitPause).toBeNull();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('attempt 1'));

    // No more countdown ticks after the resume.
    host.showStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('clears the countdown when a new turn starts', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(rateLimitPaused(1_000_000 + 90_000), vi.fn());
    handler.handleEvent(
      {
        type: 'turn.started',
        sessionId: 's1',
        agentId: 'main',
        turnId: 2,
        origin: { kind: 'user' },
      },
      vi.fn(),
    );

    expect(host.state.appState.rateLimitPause).toBeNull();
    host.showStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(host.showStatus).not.toHaveBeenCalledWith(
      expect.stringContaining('01:2'),
      'warning',
    );
  });

  it('suppresses the transcript error for an auto-resume rate-limit failure', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'error',
        sessionId: 's1',
        agentId: 'main',
        code: 'provider.rate_limit',
        message: 'Rate limit wait of 90000ms exceeds the foreground retry budget',
        retryable: true,
        details: { statusCode: 429, resumeAfterMs: 90_000, autoResume: true },
      },
      vi.fn(),
    );

    expect(host.showError).not.toHaveBeenCalled();
  });

  it('still reports a plain provider.rate_limit error', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'error',
        sessionId: 's1',
        agentId: 'main',
        code: 'provider.rate_limit',
        message: 'rate limited',
        retryable: true,
        details: { statusCode: 429, requestId: 'req-1' },
      },
      vi.fn(),
    );

    expect(host.showError).toHaveBeenCalledTimes(1);
  });
});
