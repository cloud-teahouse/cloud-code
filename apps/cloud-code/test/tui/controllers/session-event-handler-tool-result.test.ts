import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

/**
 * Live tool.result plumbing: the display ref riding the wire event must land
 * on the ToolResultBlockData handed to the transcript — the TUI renders the
 * localized form from there, and unlocalized results pass through unchanged.
 */
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
      getToolComponent: vi.fn(() => undefined),
      completeToolResult: vi.fn(() => undefined),
      setTodoList: vi.fn(),
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
  // oxlint-disable-next-line no-explicit-any -- test harness mocks the host structurally
  return host as any;
}

describe('SessionEventHandler tool.result display plumbing', () => {
  it('forwards the display ref from the wire event into the result block', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'tool.result',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        toolCallId: 'tc-1',
        output: 'Deleted cron job abc12345.',
        display: { key: 'toolResult.cron.deleted', params: { id: 'abc12345' } },
      },
      vi.fn(),
    );

    expect(host.streamingUI.completeToolResult).toHaveBeenCalledWith('tc-1', {
      tool_call_id: 'tc-1',
      output: 'Deleted cron job abc12345.',
      is_error: undefined,
      synthetic: undefined,
      display: { key: 'toolResult.cron.deleted', params: { id: 'abc12345' } },
    });
  });

  it('passes results without a display ref through unchanged', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'tool.result',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        toolCallId: 'tc-2',
        output: 'raw english output',
        isError: true,
      },
      vi.fn(),
    );

    expect(host.streamingUI.completeToolResult).toHaveBeenCalledWith('tc-2', {
      tool_call_id: 'tc-2',
      output: 'raw english output',
      is_error: true,
      synthetic: undefined,
      display: undefined,
    });
  });
});
