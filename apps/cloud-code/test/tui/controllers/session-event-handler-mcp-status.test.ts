// MCP server status rows: live session diagnostics that must render exactly
// once per server across a /reload view rebuild. /reload keeps the transcript
// but resets the handler runtime (clearing the renderedMcpServerStatusKeys
// dedupe) and then re-syncs the status snapshot — without removing the stale
// rows first, every server would show twice.

import { describe, expect, it, vi } from 'vitest';

import type { Event, McpServerStatusPayload } from '@cloud-code/sdk';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { StatusMessageComponent } from '#/tui/components/messages/status-message';
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
        rateLimitPause: null,
        isReplaying: false,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: {
        children: [] as unknown[],
        addChild: vi.fn((child: unknown) => {
          host.state.transcriptContainer.children.push(child);
        }),
      },
      ui: { requestRender: vi.fn() },
    },
    session: undefined as unknown,
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
      setTodoList: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: undefined, step: 0 })),
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
    confirmUserEcho: vi.fn(),
    updateTerminalTitle: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  // oxlint-disable-next-line no-explicit-any -- test harness mocks the host structurally
  return host as any;
}

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function transcriptText(host: ReturnType<typeof makeHost>): string {
  return host.state.transcriptContainer.children
    .map((child: { render: (width: number) => string[] }) => strip(child.render(120).join('\n')))
    .join('\n');
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function mcpStatusEvent(server: McpServerStatusPayload): Event {
  return {
    type: 'mcp.server.status',
    sessionId: 's1',
    agentId: 'main',
    server,
  } as Event;
}

const connectedServer: McpServerStatusPayload = {
  name: 'local-tools',
  transport: 'stdio',
  status: 'connected',
  toolCount: 2,
};

function makeSession(servers: readonly McpServerStatusPayload[]) {
  return {
    id: 's1',
    listMcpServers: vi.fn(async () => servers),
  };
}

describe('SessionEventHandler MCP server status rows', () => {
  it('renders each server exactly once across a /reload-style reset and snapshot re-sync', async () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const session = makeSession([connectedServer]);
    host.session = session;

    // Pre-reload: the live event stream renders the row once.
    handler.handleEvent(mcpStatusEvent(connectedServer), vi.fn());
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(1);

    // /reload: resetSessionRuntime clears the dedupe map; the stale row must
    // leave the transcript with it.
    handler.resetRuntimeState();
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(0);

    // Post-reload: startSubscription's snapshot sync renders the current
    // status — one row total, not a duplicate of the pre-reload one.
    await handler.syncMcpServerStatusSnapshot(session as never);
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(1);
  });

  it('removes a pending spinner on reset so the snapshot final row stands alone', async () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const session = makeSession([connectedServer]);
    host.session = session;

    handler.handleEvent(
      mcpStatusEvent({ ...connectedServer, status: 'pending', toolCount: 0 }),
      vi.fn(),
    );
    expect(
      host.state.transcriptContainer.children.some((child: unknown) => child instanceof MoonLoader),
    ).toBe(true);

    handler.resetRuntimeState();

    expect(
      host.state.transcriptContainer.children.some((child: unknown) => child instanceof MoonLoader),
    ).toBe(false);
    // The spinner's interval is stopped by the reset — safe to leave the test.
    await handler.syncMcpServerStatusSnapshot(session as never);
    const text = transcriptText(host);
    expect(countOccurrences(text, 'MCP server "local-tools" connected')).toBe(1);
    expect(countOccurrences(text, 'MCP server "local-tools" connecting')).toBe(0);
  });

  it('drops rows orphaned by status transitions too, so only the fresh snapshot row remains', async () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const session = makeSession([connectedServer]);
    host.session = session;

    // connected → pending → connected: the reconnect transition legitimately
    // appends a second row live (the spinner finalizes in place, the first
    // final row stays as history of the transition).
    handler.handleEvent(mcpStatusEvent(connectedServer), vi.fn());
    handler.handleEvent(
      mcpStatusEvent({ ...connectedServer, status: 'pending', toolCount: 0 }),
      vi.fn(),
    );
    handler.handleEvent(mcpStatusEvent(connectedServer), vi.fn());
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(2);

    handler.resetRuntimeState();
    await handler.syncMcpServerStatusSnapshot(session as never);
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(1);
  });

  it('still dedupes live events against the post-reset snapshot row', async () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const session = makeSession([connectedServer]);
    host.session = session;

    handler.resetRuntimeState();
    await handler.syncMcpServerStatusSnapshot(session as never);

    // A duplicate live event for an already-rendered status stays deduped.
    handler.handleEvent(mcpStatusEvent(connectedServer), vi.fn());
    expect(countOccurrences(transcriptText(host), 'MCP server "local-tools" connected')).toBe(1);
    // A genuine status change still renders (append-only diagnostics).
    handler.handleEvent(
      mcpStatusEvent({ ...connectedServer, status: 'failed', toolCount: 0, error: 'boom' }),
      vi.fn(),
    );
    const text = transcriptText(host);
    expect(countOccurrences(text, 'MCP server "local-tools" connected')).toBe(1);
    expect(countOccurrences(text, 'MCP server "local-tools" failed: boom')).toBe(1);
  });

  it('finalizes rows as StatusMessageComponent children (no notice-slot routing)', async () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);
    const session = makeSession([connectedServer]);
    host.session = session;

    await handler.syncMcpServerStatusSnapshot(session as never);

    const rows = host.state.transcriptContainer.children.filter(
      (child: unknown) => child instanceof StatusMessageComponent,
    );
    expect(rows).toHaveLength(1);
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
