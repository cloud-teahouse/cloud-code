import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOUBLE_ESC_WINDOW_MS } from '#/tui/constant/cloud-code-tui';
import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

interface Harness {
  readonly host: EditorKeyboardHost;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  readonly openUndoSelector: ReturnType<typeof vi.fn>;
  readonly cancelRunningShellCommand: ReturnType<typeof vi.fn>;
  readonly cancelCompaction: ReturnType<typeof vi.fn>;
  readonly cancelRateLimitPause: ReturnType<typeof vi.fn>;
  readonly btwCancelRunning: ReturnType<typeof vi.fn>;
  readonly btwCloseOrCancel: ReturnType<typeof vi.fn>;
  readonly handleUserInput: ReturnType<typeof vi.fn>;
  readonly showHelpPanel: ReturnType<typeof vi.fn>;
  readonly restoreInputText: ReturnType<typeof vi.fn>;
  readonly showStatus: ReturnType<typeof vi.fn>;
  readonly consumeInterruptRecall: ReturnType<typeof vi.fn>;
  readonly removeRecalledTranscriptEntries: ReturnType<typeof vi.fn>;
}

function createHarness(
  options: {
    streamingPhase?: string;
    isCompacting?: boolean;
    rateLimitPause?: { resumeAtMs: number; attempt: number } | null;
  } = {},
): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
    getText: vi.fn(() => '') as unknown as (...args: never[]) => unknown,
    setText: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = vi.fn();
  const cancelRunningShellCommand = vi.fn();
  const cancelCompaction = vi.fn(async () => {});
  const cancelRateLimitPause = vi.fn();
  const btwCancelRunning = vi.fn(() => false);
  const btwCloseOrCancel = vi.fn(() => false);
  const handleUserInput = vi.fn();
  const showHelpPanel = vi.fn();
  const restoreInputText = vi.fn();
  const showStatus = vi.fn();
  const consumeInterruptRecall = vi.fn(
    (): { text: string; transcriptEntryIds: readonly string[] } | undefined => undefined,
  );
  const removeRecalledTranscriptEntries = vi.fn();
  const session = { cancel: vi.fn(async () => {}), cancelCompaction };

  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: {
        streamingPhase: options.streamingPhase ?? 'idle',
        isCompacting: options.isCompacting ?? false,
        rateLimitPause: options.rateLimitPause ?? null,
      },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
    btwPanelController: { cancelRunning: btwCancelRunning, closeOrCancel: btwCloseOrCancel },
    openUndoSelector,
    cancelRunningShellCommand,
    cancelRateLimitPause,
    handleUserInput,
    showHelpPanel,
    restoreInputText,
    showStatus,
    consumeInterruptRecall,
    removeRecalledTranscriptEntries,
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
  );
  controller.install();

  return {
    host,
    editor,
    openUndoSelector,
    cancelRunningShellCommand,
    cancelCompaction,
    cancelRateLimitPause,
    btwCancelRunning,
    btwCloseOrCancel,
    handleUserInput,
    showHelpPanel,
    restoreInputText,
    showStatus,
    consumeInterruptRecall,
    removeRecalledTranscriptEntries,
  };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressCtrlC(editor: Harness['editor']): void {
  const handler = editor['onCtrlC'];
  if (handler === undefined) throw new Error('onCtrlC handler not installed');
  (handler as () => void)();
}

function pressNonEscape(editor: Harness['editor']): void {
  const handler = editor['onNonEscapeInput'];
  if (handler === undefined) throw new Error('onNonEscapeInput handler not installed');
  (handler as () => void)();
}

describe('EditorKeyboardController double-Esc undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the undo selector when Esc is pressed twice within the window while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledOnce();
  });

  it('does nothing for a single Esc while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when the second Esc arrives after the window expires', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    vi.advanceTimersByTime(DOUBLE_ESC_WINDOW_MS + 1);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when another key is pressed between the two Esc presses', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    pressNonEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger undo while streaming; Esc cancels the stream instead', () => {
    const { editor, host, openUndoSelector, cancelRunningShellCommand } = createHarness({
      streamingPhase: 'waiting',
    });

    pressEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
    expect(cancelRunningShellCommand).toHaveBeenCalled();
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    expect(session.cancel).toHaveBeenCalled();
  });

  it('cancels a parked rate-limit auto-retry on Esc instead of arming undo (C1 P2)', () => {
    const { editor, cancelRateLimitPause, cancelRunningShellCommand, openUndoSelector } =
      createHarness({
        rateLimitPause: { resumeAtMs: Date.now() + 90_000, attempt: 1 },
      });

    pressEscape(editor);

    expect(cancelRateLimitPause).toHaveBeenCalledOnce();
    // The session is idle during the pause: no stream cancel, no undo arming.
    expect(cancelRunningShellCommand).not.toHaveBeenCalled();
    expect(openUndoSelector).not.toHaveBeenCalled();
  });
});

describe('EditorKeyboardController btw panel priority', () => {
  it('Esc closes the btw panel first while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Esc cancels compaction on the next press once the btw panel is gone', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValueOnce(true);

    pressEscape(editor);
    expect(cancelCompaction).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Esc cancels compaction directly when no btw panel is open', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Ctrl+C cancels a running btw question first while compacting', () => {
    const { editor, btwCancelRunning, cancelCompaction } = createHarness({ isCompacting: true });
    btwCancelRunning.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C closes an idle btw panel while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C cancels compaction when no btw panel is open', () => {
    const { editor, btwCancelRunning, btwCloseOrCancel, cancelCompaction } = createHarness({
      isCompacting: true,
    });

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });
});

describe('EditorKeyboardController shell history recall', () => {
  type Recall = (entry: string, direction: 1 | -1) => string | undefined;
  type Mock = ReturnType<typeof vi.fn>;

  it('installs a filter that allows shell entries only in bash mode', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    expect(setHistoryFilter).toHaveBeenCalledOnce();
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(true);

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(false);
  });

  it('locks the filter to the browse-entry mode once browsing starts', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    // Enter browse from prompt mode, then simulate landing on a shell entry
    // (which flips inputMode to bash). The filter should stay locked to prompt
    // and keep allowing plain entries.
    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    save();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    expect(filter('hello')).toBe(true);
    expect(filter('!cmd')).toBe(true);
  });

  it('strips the leading ! and switches to bash mode when recalling a shell entry', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('!cmd', -1);

    expect(result).toBe('cmd');
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('bash');
  });

  it('keeps plain entries as-is and switches to prompt mode', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('hello', -1);

    expect(result).toBeUndefined();
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });

  it('saves the current input mode as the history draft host state', () => {
    const { editor } = createHarness();
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(save()).toBe('prompt');

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(save()).toBe('bash');
  });

  it('restores the input mode from the saved draft host state', () => {
    const { editor } = createHarness();
    const restore = editor['onHistoryDraftRestore'] as unknown as (state: unknown) => void;

    restore('prompt');

    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });
});

describe('EditorKeyboardController `?` help shortcut', () => {
  function submit(editor: Harness['editor'], text: string): void {
    const handler = editor['onSubmit'];
    if (handler === undefined) throw new Error('onSubmit handler not installed');
    (handler as (text: string) => void)(text);
  }

  it('opens the help panel for a lone `?` instead of sending a user message', () => {
    const { editor, handleUserInput, showHelpPanel } = createHarness();

    submit(editor, '?');

    expect(showHelpPanel).toHaveBeenCalledOnce();
    expect(handleUserInput).not.toHaveBeenCalled();
  });

  it('restores the `?` draft so Esc/Backspace returns to editing it', () => {
    const { editor } = createHarness();

    submit(editor, '?');

    expect(editor['setText']).toHaveBeenCalledWith('?');
  });

  it('submits `?` as normal input in bash mode (it is a shell command there)', () => {
    const { editor, handleUserInput, showHelpPanel } = createHarness();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    submit(editor, '?');

    expect(showHelpPanel).not.toHaveBeenCalled();
    expect(handleUserInput).toHaveBeenCalledWith('?');
  });

  it('submits text that merely contains `?` as normal input', () => {
    const { editor, handleUserInput, showHelpPanel } = createHarness();

    submit(editor, 'what is this?');

    expect(showHelpPanel).not.toHaveBeenCalled();
    expect(handleUserInput).toHaveBeenCalledWith('what is this?');
  });
});

describe('EditorKeyboardController T2 interrupt recall', () => {
  it('Esc recalls the submitted text into the editor when the turn produced no output', () => {
    const {
      editor,
      host,
      restoreInputText,
      showStatus,
      consumeInterruptRecall,
      removeRecalledTranscriptEntries,
    } = createHarness({
      streamingPhase: 'waiting',
    });
    consumeInterruptRecall.mockReturnValue({ text: 're-edit me', transcriptEntryIds: ['e1'] });

    pressEscape(editor);

    expect(consumeInterruptRecall).toHaveBeenCalledOnce();
    expect(restoreInputText).toHaveBeenCalledWith('re-edit me');
    expect(showStatus).toHaveBeenCalledOnce();
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    // The recall doubles as the withdrawal signal: the interrupted message is
    // pulled out of the context and its echo leaves the transcript.
    expect(session.cancel).toHaveBeenCalledWith({ withdrawInput: true });
    expect(removeRecalledTranscriptEntries).toHaveBeenCalledWith(['e1']);
  });

  it('Ctrl+C shares the same interrupt-before-output recall semantics', () => {
    const {
      editor,
      host,
      restoreInputText,
      showStatus,
      consumeInterruptRecall,
      removeRecalledTranscriptEntries,
    } = createHarness({
      streamingPhase: 'composing',
    });
    consumeInterruptRecall.mockReturnValue({ text: 're-edit me', transcriptEntryIds: ['e1'] });

    pressCtrlC(editor);

    expect(restoreInputText).toHaveBeenCalledWith('re-edit me');
    expect(showStatus).toHaveBeenCalledOnce();
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    expect(session.cancel).toHaveBeenCalledWith({ withdrawInput: true });
    expect(removeRecalledTranscriptEntries).toHaveBeenCalledWith(['e1']);
  });

  it('keeps an in-progress editor draft instead of recalling over it (Esc)', () => {
    const {
      editor,
      host,
      restoreInputText,
      showStatus,
      consumeInterruptRecall,
      removeRecalledTranscriptEntries,
    } = createHarness({
      streamingPhase: 'waiting',
    });
    consumeInterruptRecall.mockReturnValue({ text: 're-edit me', transcriptEntryIds: ['e1'] });
    (editor['getText'] as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      'draft in progress',
    );

    pressEscape(editor);

    expect(restoreInputText).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
    // The draft only wins the editor: the interrupted message is still
    // withdrawn from the context and dropped from the transcript.
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    expect(session.cancel).toHaveBeenCalledWith({ withdrawInput: true });
    expect(removeRecalledTranscriptEntries).toHaveBeenCalledWith(['e1']);
  });

  it('does not recall when the turn already produced visible output', () => {
    const {
      editor,
      host,
      restoreInputText,
      showStatus,
      consumeInterruptRecall,
      removeRecalledTranscriptEntries,
    } = createHarness({
      streamingPhase: 'composing',
    });
    consumeInterruptRecall.mockReturnValue(undefined);

    pressEscape(editor);
    pressCtrlC(editor);

    expect(consumeInterruptRecall).toHaveBeenCalledTimes(2);
    expect(restoreInputText).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
    // No recall → no withdrawal: the context keeps the interrupted message.
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    expect(session.cancel).toHaveBeenCalledTimes(2);
    expect(session.cancel).toHaveBeenCalledWith({ withdrawInput: false });
    expect(removeRecalledTranscriptEntries).not.toHaveBeenCalled();
  });

  it('never consults the recall on the compaction path (Esc or Ctrl+C)', () => {
    const { editor, restoreInputText, showStatus, consumeInterruptRecall, cancelCompaction } =
      createHarness({ isCompacting: true });
    consumeInterruptRecall.mockReturnValue({ text: 're-edit me', transcriptEntryIds: ['e1'] });

    pressEscape(editor);
    pressCtrlC(editor);

    expect(cancelCompaction).toHaveBeenCalledTimes(2);
    expect(consumeInterruptRecall).not.toHaveBeenCalled();
    expect(restoreInputText).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
  });
});
