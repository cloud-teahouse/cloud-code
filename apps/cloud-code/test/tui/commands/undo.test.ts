import { describe, expect, it, vi } from 'vitest';

import { handleUndoCommand, undoByCount } from '#/tui/commands/undo';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptEntry } from '#/tui/types';

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

const USER_ENTRY_1: TranscriptEntry = {
  id: 'entry-1',
  kind: 'user',
  renderMode: 'markdown',
  content: 'first user message',
};

const USER_ENTRY_2: TranscriptEntry = {
  id: 'entry-2',
  kind: 'user',
  renderMode: 'markdown',
  content: 'second user message',
};

function userContextMessage(text: string) {
  return {
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    toolCalls: [],
    origin: { kind: 'user' as const },
  };
}

function makeHost(options: { readonly undoHistory?: ReturnType<typeof vi.fn> } = {}) {
  const entries = [USER_ENTRY_1, USER_ENTRY_2];
  const state = {
    appState: {
      streamingPhase: 'idle',
      isCompacting: false,
    },
    transcriptEntries: entries,
    transcriptContainer: {
      children: [] as unknown[],
      invalidate: vi.fn(),
      addChild: vi.fn(),
    },
    ui: {
      requestRender: vi.fn(),
    },
  };
  let mountedPanel: MountedPanel | null = null;
  const session = {
    id: 'session-1',
    undoHistory: options.undoHistory ?? vi.fn(async () => {}),
    getContext: vi.fn(async () => ({
      history: [userContextMessage('first user message'), userContextMessage('second user message')],
    })),
  };
  const host = {
    state,
    session,
    skillCommandMap: new Map<string, string>(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    appendTranscriptEntry: vi.fn((entry: TranscriptEntry) => {
      entries.push(entry);
    }),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(() => {
      mountedPanel = null;
    }),
    restoreInputText: vi.fn(),
  } as unknown as SlashCommandHost & {
    session: typeof session;
    state: typeof state;
    showError: ReturnType<typeof vi.fn>;
    appendTranscriptEntry: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    restoreInputText: ReturnType<typeof vi.fn>;
  };
  return {
    host,
    session,
    entries,
    getMountedPanel: () => mountedPanel,
  };
}

describe('handleUndoCommand', () => {
  it('refuses to undo while streaming', async () => {
    const { host, session } = makeHost();
    host.state.appState.streamingPhase = 'composing';

    await handleUndoCommand(host, '1');

    expect(host.showError).toHaveBeenCalledWith(
      'Cannot undo while streaming — press Esc or Ctrl-C first.',
    );
    expect(session.undoHistory).not.toHaveBeenCalled();
  });

  it('undoes the selected prompt and restores its input text', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleUndoCommand(host, '');
    const panel = getMountedPanel();
    expect(panel).not.toBeNull();
    panel!.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });
    await vi.waitFor(() => {
      expect(host.restoreInputText).toHaveBeenCalledWith('second user message');
    });
  });

  it('runs undoHistory only once when Enter is pressed twice on the selector', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleUndoCommand(host, '');
    const panel = getMountedPanel();
    expect(panel).not.toBeNull();
    panel!.handleInput('\r');
    panel!.handleInput('\r');

    await vi.waitFor(() => {
      expect(host.restoreInputText).toHaveBeenCalledWith('second user message');
    });
    expect(session.undoHistory).toHaveBeenCalledTimes(1);
  });

  it('drops a second typed /undo submitted inside the RPC window', async () => {
    let resolveUndo: (() => void) | undefined;
    const undoHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUndo = resolve;
        }),
    );
    const { host, session } = makeHost({ undoHistory });

    const first = handleUndoCommand(host, '1');
    // Wait until the first call is inside the RPC window (flag latched).
    await vi.waitFor(() => {
      expect(undoHistory).toHaveBeenCalledTimes(1);
    });
    const second = handleUndoCommand(host, '1');
    // Let the second command drain its async availability probe and arrive at
    // the in-flight gate before the first RPC completes.
    await new Promise((resolve) => setImmediate(resolve));
    resolveUndo?.();
    await Promise.all([first, second]);

    expect(session.undoHistory).toHaveBeenCalledTimes(1);
    expect(session.undoHistory).toHaveBeenCalledWith(1);
  });
});

describe('undoByCount', () => {
  it('drops a concurrent call instead of truncating the history twice', async () => {
    let resolveUndo: (() => void) | undefined;
    const undoHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUndo = resolve;
        }),
    );
    const { host, session } = makeHost({ undoHistory });

    const first = undoByCount(host, 1);
    const second = await undoByCount(host, 1);
    resolveUndo?.();
    const firstResult = await first;

    expect(second).toBe(false);
    expect(firstResult).toBe(true);
    expect(session.undoHistory).toHaveBeenCalledTimes(1);
  });
});
