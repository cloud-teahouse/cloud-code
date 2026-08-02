import type { CloudCodeHarness, Session } from '@cloud-code/sdk';
import { compressImageForModel, persistOriginalImage, sessionMediaOriginalsDir } from '@cloud-code/sdk';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';
import type { ColorToken } from '#/tui/theme';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import { extractMediaAttachments } from '../utils/image-placeholder';
import type { PendingExit, QueuedMessage, SteerInputItem } from '../types';
import type { TUIState } from '../tui-state';
import type { BtwPanelController } from './btw-panel';
import type { InterruptRecall } from './session-event-handler';

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  cancelInFlight: (() => void) | undefined;
  /**
   * The host's harness (CloudCodeTUI always has one). Its `imageLimits` drives
   * paste-time image compression; hosts without one fall back to the
   * env/built-in default.
   */
  harness?: CloudCodeHarness | undefined;

  handleUserInput(text: string): void;
  showHelpPanel(): void;
  readonly btwPanelController: BtwPanelController;
  steerMessage(session: Session, input: readonly SteerInputItem[]): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;
  recallLastQueued(): QueuedMessage | undefined;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  restoreInputText(text: string): void;
  /**
   * T2 "interrupt before output → recall for re-edit": returns the input
   * submitted for the in-flight turn when it has not produced any visible
   * assistant output yet (consuming the record), or undefined when the turn
   * already streamed output, the running phase is a `!` shell command, or
   * nothing recallable was submitted. Compaction cancellation takes a
   * separate path and never consults this.
   */
  consumeInterruptRecall(): InterruptRecall | undefined;
  /**
   * T2: drop the recalled input's echo entries from the transcript (see the
   * host implementation). Called when an interrupt recall fires.
   */
  removeRecalledTranscriptEntries(entryIds: readonly string[]): void;
  updateEditorBorderHighlight(text?: string): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  /**
   * Esc during a parked rate-limit auto-retry: cancels the core-side
   * resume timer (via session cancel) and retires the countdown line. The
   * session itself is idle and stays intact.
   */
  cancelRateLimitPause(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  stop(exitCode?: number): Promise<void>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  /**
   * Mirror the editor's vim mode into AppState for the footer badge.
   * `null` when vim mode is disabled.
   */
  setVimMode(mode: 'INSERT' | 'NORMAL' | null): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    // Keybindings boundary: the Ctrl+C / Ctrl+D / Escape handlers below are
    // time-based state machines (double-press exit confirm, double-Esc undo,
    // stream/compaction cancel) and intentionally stay hardcoded — ctrl+c and
    // ctrl+d are reserved keys, and Escape is a sequence, not an action. Only
    // the stateless chat shortcuts (ctrl+g/o/s/b/t, shift+tab, image paste)
    // live in the rebindable table (tui/keybindings/default-bindings.ts),
    // dispatched by CustomEditor.handleInput; the callbacks they fire are
    // wired here.

    editor.onSubmit = (text: string) => {
      // A lone `?` opens the help panel (keyboard-shortcuts section sits at
      // the top) instead of becoming a user message. pi-tui clears the buffer
      // before firing onSubmit, so put the `?` back — Esc/Backspace on the
      // panel returns to the editor with the draft intact. Bash mode is
      // excluded: `?` there is a shell command.
      if (text === '?' && editor.inputMode !== 'bash') {
        host.showHelpPanel();
        editor.setText('?');
        return;
      }
      host.handleUserInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.updateEditorBorderHighlight(text);
    };

    // bash mode recalls only shell (`!`-prefixed) history entries; prompt mode
    // recalls everything. The filter is locked to the mode captured when the
    // user first enters history browsing (see onHistoryDraftSave), so landing on
    // a shell entry mid-browse doesn't switch the filter to shell-only.
    let browseMode: 'prompt' | 'bash' | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === 'bash' ? entry.startsWith('!') : true;
    });

    // Recalling a `!`-prefixed entry strips the marker and returns to bash
    // mode; recalling a plain entry returns to prompt mode. The filter above
    // guarantees bash mode only ever lands on `!` entries, so this never
    // misfires on commands typed in bash mode.
    editor.onRecall = (entry: string) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };

    // Save/restore the input mode alongside pi-tui's history draft. Without
    // this, recalling a shell entry and then pressing Down back to an empty
    // draft would leave the editor stuck in bash mode, so the next typed
    // message would be submitted as a shell command. Also locks the history
    // filter (browseMode) for the duration of the browse session.
    editor.onHistoryDraftSave = () => {
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      editor.setInputMode(state as 'prompt' | 'bash');
      browseMode = null;
    };

    editor.onNonEscapeInput = () => {
      this.clearPendingUndoEsc();
    };

    editor.onCtrlC = () => {
      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      // The btw panel stacks above the transcript, so Ctrl+C cancels/closes it
      // before touching an in-flight compaction or stream.
      if (host.btwPanelController.cancelRunning()) {
        this.clearPendingExit();
        return;
      }
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingExit();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        this.cancelCurrentCompaction();
        return;
      }

      if (host.state.appState.streamingPhase !== 'idle') {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        this.cancelCurrentStream();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void host.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', resolveDescription(CTRL_C_HINT));
    };

    editor.onCtrlD = () => {
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', resolveDescription(CTRL_D_HINT));
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        this.clearPendingUndoEsc();
        return;
      }
      // The btw panel stacks above the transcript, so Esc dismisses it before
      // touching an in-flight compaction or stream.
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.streamingPhase !== 'idle') {
        this.cancelCurrentStream();
        this.clearPendingUndoEsc();
        return;
      }
      // A parked rate-limit auto-retry takes Esc as "cancel the
      // countdown" — the session itself is idle and stays intact.
      const rateLimitPause = host.state.appState.rateLimitPause;
      if (rateLimitPause !== null && rateLimitPause !== undefined) {
        host.cancelRateLimitPause();
        this.clearPendingUndoEsc();
        return;
      }
      // Idle: a second Esc within the double-tap window opens the undo selector.
      if (this.pendingUndoEsc !== null) {
        this.clearPendingUndoEsc();
        host.openUndoSelector();
        return;
      }
      this.armPendingUndoEsc();
    };

    editor.onShiftTab = () => {
      if (host.session === undefined) {
        host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
        return;
      }
      const next = !host.state.appState.planMode;
      host.handlePlanToggle(next);
    };

    editor.onInputModeChange = (mode) => {
      host.handleInputModeChange(mode);
    };

    // Vim mode flips are mirrored into AppState so the footer can show the
    // INSERT/NORMAL badge (and so its render signature picks up the change).
    editor.onVimModeChange = (mode) => {
      host.setVimMode(mode);
    };

    editor.onOpenExternalEditor = () => {
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.toggleToolOutputExpansion();
    };

    editor.onToggleTodoExpand = (): boolean => {
      if (!host.state.todoPanel.hasOverflow()) return false;
      // Disarm a pending double-press exit confirmation so expanding the
      // todo list in between two Ctrl-C presses does not accidentally exit.
      this.clearPendingExit();
      host.toggleTodoPanelExpansion();
      return true;
    };

    editor.onCtrlS = () => {
      if (
        host.state.appState.streamingPhase === 'idle' ||
        host.state.appState.streamingPhase === 'shell' ||
        host.state.appState.isCompacting
      )
        return;
      const text = editor.getText().trim();
      const editorIsBash = editor.inputMode === 'bash';

      // Bash commands (`! …`) are not steerable: keep them queued so they run
      // after the current task instead of being injected into the turn as text.
      const queued = host.state.queuedMessages;
      const steerable = queued.filter((m) => m.mode !== 'bash');

      const items: SteerInputItem[] = [];
      for (const m of steerable) {
        const trimmed = m.text.trim();
        if (trimmed.length > 0) {
          // Queued items carry the parts extracted when they were submitted
          // (and were already capability-validated then).
          items.push({ text: trimmed, parts: m.parts, imageAttachmentIds: m.imageAttachmentIds });
        }
      }
      let editorExtraction: ReturnType<typeof extractMediaAttachments> | undefined;
      if (!editorIsBash && text.length > 0) {
        try {
          editorExtraction = extractMediaAttachments(text, this.imageStore);
        } catch (error) {
          // Cache copy failed (e.g. the pasted video's source vanished) —
          // leave the queue and the editor draft untouched.
          host.showError(t('status.mediaAttachmentFailed', { message: formatErrorMessage(error) }));
          return;
        }
        items.push({
          text,
          parts: editorExtraction.hasMedia ? editorExtraction.parts : undefined,
          imageAttachmentIds:
            editorExtraction.imageAttachmentIds.length > 0
              ? editorExtraction.imageAttachmentIds
              : undefined,
        });
      }

      if (items.length > 0) {
        // The editor draft is fresh input: gate it on the model's media
        // capabilities before splicing the queue, so a rejection leaves the
        // queue and the draft untouched.
        if (
          editorExtraction !== undefined &&
          !host.validateMediaCapabilities(editorExtraction)
        ) {
          return;
        }
        host.state.queuedMessages = queued.filter((m) => m.mode === 'bash');
        if (!editorIsBash) editor.setText('');
        const session = host.session;
        if (host.state.appState.model.trim().length === 0 || session === undefined) {
          host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
        } else {
          host.steerMessage(session, items);
        }
      }
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlB = (): boolean => {
      // Shell command execution is treated as a streaming phase ('shell'), so
      // this gate already covers it; only idle + not-compacting falls through.
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) {
        return false;
      }
      host.detachCurrentForegroundTask();
      return true;
    };

    editor.onUpArrowEmpty = () => {
      if (host.btwPanelController.scroll('up')) return true;
      if (host.state.appState.streamingPhase === 'idle' && !host.state.appState.isCompacting) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled.text);
        // Restore the queued item's mode so a recalled `!` command runs as a
        // shell command again instead of being submitted as a normal prompt.
        const mode = recalled.mode ?? 'prompt';
        if (editor.inputMode !== mode) {
          editor.inputMode = mode;
          editor.onInputModeChange?.(mode);
        }
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onDownArrowEmpty = () => host.btwPanelController.scroll('down');

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.host.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.host.state.ui.requestRender();
  }

  private clearEditorTextIfPresent(): boolean {
    const editor = this.host.state.editor;
    if (editor.getText().length === 0) return false;
    editor.setText('');
    return true;
  }

  private cancelCurrentStream(): void {
    // Cancel any running `!` shell command (treated as a streaming phase) in
    // addition to the agent turn, so Esc / Ctrl+C interrupts it too.
    this.host.cancelRunningShellCommand();
    // T2: interrupting a turn before it produced any visible assistant output
    // recalls the submitted text into the editor for re-editing instead of
    // dropping it. The recall doubles as the withdrawal signal: the cancelled
    // turn's unanswered input is pulled out of the context as it unwinds, so
    // the edited resend never sits next to a stale interrupted copy. A
    // non-empty editor draft always wins — never clobber text the user is
    // currently typing (Esc path; Ctrl+C clears drafts first).
    const recall = this.host.consumeInterruptRecall();
    void this.host.session?.cancel({ withdrawInput: recall !== undefined });
    if (recall === undefined) return;
    this.host.removeRecalledTranscriptEntries(recall.transcriptEntryIds);
    if (this.host.state.editor.getText().length === 0) {
      this.host.restoreInputText(recall.text);
      this.host.showStatus(t('controllers.editor.cancelledInputRecalled'));
    }
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(t('controllers.editor.cancelCompactionFailed', { message }));
    });
  }

  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      const attachment = this.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
      this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.host.state.ui.requestRender();
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    // Compress at ingestion — a pure data step while building the attachment, so
    // the stored bytes, the inline thumbnail, the `[image #N (W×H)]` placeholder,
    // and the submitted image all agree, and the agent core only ever sees an
    // already-compressed image. Best effort: originals pass through on failure.
    // When compression changed the bytes, the original is persisted (into the
    // session's media-originals dir when known, else the temp-dir fallback)
    // and recorded on the attachment, so submit-time expansion can announce
    // the compression and point the model at the full-fidelity copy.
    // The edge cap comes from the host harness's [image] config (resolved per
    // paste so a config reload applies immediately); hosts without a harness
    // use the env/built-in default.
    const compressed = await compressImageForModel(media.bytes, meta.mime, {
      maxEdge: this.host.harness?.imageLimits?.maxEdgePx(),
    });
    const sessionDir = this.host.session?.summary?.sessionDir;
    // Dimensions come from the compression result, not parseImageMeta: the
    // compressor reports display space (EXIF orientation applied) — the space
    // the sent image, the caption, and ReadMediaFile region readback share —
    // while parseImageMeta reads the raw pre-rotation header.
    const attachment = compressed.changed
      ? this.imageStore.addImage(
          compressed.data,
          compressed.mimeType,
          compressed.width,
          compressed.height,
          {
            path: await persistOriginalImage(
              media.bytes,
              meta.mime,
              sessionDir === undefined ? {} : { dir: sessionMediaOriginalsDir(sessionDir) },
            ),
            width: compressed.originalWidth,
            height: compressed.originalHeight,
            byteLength: media.bytes.length,
            mime: meta.mime,
          },
        )
      : this.imageStore.addImage(
          media.bytes,
          meta.mime,
          compressed.width || meta.width,
          compressed.height || meta.height,
        );
    this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.host.state.ui.requestRender();
    return true;
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError(t('controllers.editor.noEditorConfigured'));
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed = state.editor.getExpandedText?.() ?? state.editor.getText();
    state.ui.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(t('controllers.editor.externalEditorFailed', { message: msg }));
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      state.ui.start();
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
      this.host.setExternalEditorRunning(false);
    }
  }
}
