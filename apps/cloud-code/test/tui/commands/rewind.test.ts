import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, CloudCodeError } from '@cloud-code/sdk';

import { handleRewindCommand } from '#/tui/commands/rewind';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptEntry } from '#/tui/types';

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

const USER_ENTRY: TranscriptEntry = {
  id: 'entry-1',
  kind: 'user',
  renderMode: 'markdown',
  content: 'hello world',
};

const USER_CONTEXT_MESSAGE = {
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'hello world' }],
  toolCalls: [],
  origin: { kind: 'user' as const },
};

function makeHost(options: {
  readonly streamingPhase?: string;
  readonly entries?: TranscriptEntry[];
  readonly rewindFiles?: ReturnType<typeof vi.fn>;
  readonly undoHistory?: ReturnType<typeof vi.fn>;
}) {
  const entries = [...(options.entries ?? [USER_ENTRY])];
  const state = {
    appState: {
      streamingPhase: options.streamingPhase ?? 'idle',
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
    rewindFiles:
      options.rewindFiles ??
      vi.fn(async (count: number) => ({
        turnId: 0,
        files: ['a.txt', 'b.txt'],
        preRewindTree: 'f'.repeat(40),
        count,
      })),
    undoHistory: options.undoHistory ?? vi.fn(async () => {}),
    getContext: vi.fn(async () => ({ history: [USER_CONTEXT_MESSAGE] })),
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
    showStatus: ReturnType<typeof vi.fn>;
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

describe('handleRewindCommand', () => {
  it('refuses to rewind while streaming', async () => {
    const { host, session } = makeHost({ streamingPhase: 'streaming' });

    await handleRewindCommand(host, '1');

    expect(host.showError).toHaveBeenCalledWith(
      'Cannot rewind while streaming — press Esc or Ctrl-C first.',
    );
    expect(session.rewindFiles).not.toHaveBeenCalled();
    expect(session.undoHistory).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments', async () => {
    const { host } = makeHost({});

    await handleRewindCommand(host, 'abc');
    await handleRewindCommand(host, '1 sideways');

    expect(host.showError).toHaveBeenCalledTimes(2);
    expect(host.showError).toHaveBeenCalledWith(
      'Usage: /rewind [count] [code|conversation|both], where count is a positive integer.',
    );
  });

  it('rewinds files only in code mode', async () => {
    const { host, session } = makeHost({});

    await handleRewindCommand(host, '2 code');

    expect(session.rewindFiles).toHaveBeenCalledWith(2);
    expect(session.undoHistory).not.toHaveBeenCalled();
    const status = host.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry;
    expect(status.kind).toBe('status');
    expect(status.content).toContain('2 files');
  });

  it('rewinds conversation only in conversation mode', async () => {
    const { host, session } = makeHost({});

    await handleRewindCommand(host, '1 conversation');

    expect(session.undoHistory).toHaveBeenCalledWith(1);
    expect(session.rewindFiles).not.toHaveBeenCalled();
  });

  it('rewinds both by default', async () => {
    const { host, session } = makeHost({});

    await handleRewindCommand(host, '1');

    expect(session.rewindFiles).toHaveBeenCalledWith(1);
    expect(session.undoHistory).toHaveBeenCalledWith(1);
  });

  it('keeps the conversation rewind independent of a file rewind failure', async () => {
    const rewindFiles = vi.fn(async () => {
      throw new Error('shadow repo exploded');
    });
    const { host, session } = makeHost({ rewindFiles });

    await handleRewindCommand(host, '1 both');

    expect(session.rewindFiles).toHaveBeenCalledWith(1);
    expect(session.undoHistory).toHaveBeenCalledWith(1);
    expect(host.showError).toHaveBeenCalledWith(
      'Failed to rewind files: shadow repo exploded',
    );
  });

  it('shows a friendly status when the count exceeds the tracked turns', async () => {
    const rewindFiles = vi.fn(async (count: number) => {
      throw new CloudCodeError(ErrorCodes.REQUEST_INVALID, 'Cannot rewind', {
        details: { reason: 'rewind_limit', requestedCount: count, rewindableCount: 1 },
      });
    });
    const { host } = makeHost({ rewindFiles });

    await handleRewindCommand(host, '5 code');

    const status = host.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry;
    expect(status.content).toBe(
      'Cannot rewind 5 prompts; only 1 prompt have file snapshots.',
    );
  });

  it('reports nothing to rewind when there are no anchors', async () => {
    const { host } = makeHost({ entries: [] });
    (host.session as { getContext: ReturnType<typeof vi.fn> }).getContext = vi.fn(
      async () => ({ history: [] }),
    );

    await handleRewindCommand(host, '');

    const status = host.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry;
    expect(status.content).toBe('Nothing to rewind.');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('walks the two-step interactive flow: anchor pick then mode pick', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleRewindCommand(host, '');

    const anchorPanel = getMountedPanel();
    expect(anchorPanel).not.toBeNull();
    const anchorRendered = anchorPanel!.render(100).map(strip).join('\n');
    expect(anchorRendered).toContain('Select messages to rewind to');
    expect(anchorRendered).toContain('hello world');

    anchorPanel!.handleInput('\r');

    const modePanel = getMountedPanel();
    expect(modePanel).not.toBeNull();
    expect(modePanel).not.toBe(anchorPanel);
    const modeRendered = modePanel!.render(100).map(strip).join('\n');
    expect(modeRendered).toContain('Restore code and conversation');
    expect(modeRendered).toContain('Restore conversation');
    expect(modeRendered).toContain('Restore code');

    modePanel!.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.rewindFiles).toHaveBeenCalledWith(1);
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });
    await vi.waitFor(() => {
      expect(host.restoreInputText).toHaveBeenCalledWith('hello world');
    });
  });

  it('cancels back to the editor from the mode selector', async () => {
    const { host, getMountedPanel } = makeHost({});

    await handleRewindCommand(host, '');
    getMountedPanel()?.handleInput('\r');
    getMountedPanel()?.handleInput('\x1b');

    expect(host.restoreEditor).toHaveBeenCalled();
  });
});
