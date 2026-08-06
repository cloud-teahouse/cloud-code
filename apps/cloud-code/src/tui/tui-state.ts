import {
  applyBackgroundToLine,
  Container,
  ProcessTerminal,
  truncateToWidth,
  TUI,
} from '@cloud-code/pi-tui';

import { BottomAnchorContainer } from './components/chrome/bottom-anchor-container';
import { FooterComponent } from './components/chrome/footer';
import { EditorSlotContainer, GutterContainer } from './components/chrome/gutter-container';
import { LayeredSlotContainer } from './components/chrome/layered-slot-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_TUI_CONFIG } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import type { TeamsBrowserState } from './controllers/teams-browser';
import type { WorkflowsBrowserState } from './controllers/workflows-browser';
import { t } from './i18n';
import { currentTheme, type Theme } from './theme';
import { createScrollIndicatorStyle, createScrollbarStyle } from './theme/pi-tui-theme';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import { getTranscriptComponentEntry } from './utils/transcript-component-metadata';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type CloudCodeTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  /** Root of the layout tree; the only direct child of `ui`. Holds exactly
   *  two children: `transcriptContainer` (scroll region) and `slotContainer`
   *  (fixed bottom slot). In fullscreen mode the TUI renders the two regions
   *  directly; in inline mode this container's own render() inserts a filler
   *  gap after the transcript to bottom-anchor the slot. */
  rootContainer: BottomAnchorContainer;
  /** Fixed bottom slot: notice/activity/swarm/todo/queue/btw/editor/footer, in order. */
  slotContainer: LayeredSlotContainer;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  btwPanelContainer: Container;
  /** Single-slot notice area heading the slot, right under the transcript;
   *  transient showStatus/showNotice output lands here (latest replaces). */
  noticeContainer: Container;
  /** Live Agent Swarm progress grids, pinned right above the input editor
   *  while running; on completion each grid moves into the transcript. */
  swarmContainer: Container;
  editorContainer: EditorSlotContainer;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  toolOutputExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  sessionsScope: 'cwd' | 'all';
  activeDialog: 'session-picker' | 'help' | null;
  tasksBrowser: TasksBrowserState | undefined;
  workflowsBrowser: WorkflowsBrowserState | undefined;
  teamsBrowser: TeamsBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  /**
   * True while a queued user message has been shifted out of
   * {@link queuedMessages} but its deferred send has not run yet. The queue
   * looks empty during this window, so queued-goal promotion must also check
   * this flag to avoid starting a goal ahead of the user's earlier message.
   */
  queuedMessageDispatchPending: boolean;
  swarmModeEntry: 'manual' | 'task' | undefined;
}

export function createTUIState(options: CloudCodeTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const slotContainer = new LayeredSlotContainer();
  // BottomAnchor only affects inline mode (its render() pads a filler gap);
  // fullscreen renders the registered regions directly and never sees filler.
  const rootContainer = new BottomAnchorContainer(() => terminal.rows, transcriptContainer);
  rootContainer.addChild(transcriptContainer);
  rootContainer.addChild(slotContainer);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent();
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const noticeContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const swarmContainer = new Container();
  const editorContainer = new EditorSlotContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  // Vim modal editing (tui.toml editor.vim_mode). The footer badge reads the
  // mirrored AppState.vimMode; mode flips arrive via onVimModeChange.
  editor.setVimEnabled(initialAppState.vimMode === 'INSERT' || initialAppState.vimMode === 'NORMAL');
  const footer = new FooterComponent({ ...initialAppState }, () => {
    ui.requestRender();
  });

  // Fullscreen (alternate screen + pinned bottom slot) is the default; tui.toml
  // `fullscreen = false` falls back to classic inline scrollback rendering.
  ui.setFullscreen(initialAppState.fullscreen ?? DEFAULT_TUI_CONFIG.fullscreen);
  ui.setLayoutRegions({ scroll: transcriptContainer, slot: slotContainer });
  ui.setScrollIndicatorLabel((hidden) => t('status.scrollIndicator', { count: hidden }));
  ui.setScrollIndicatorStyle(createScrollIndicatorStyle());
  ui.setScrollbarStyle(createScrollbarStyle());

  const state: TUIState = {
    ui,
    terminal,
    rootContainer,
    slotContainer,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    btwPanelContainer,
    noticeContainer,
    swarmContainer,
    editorContainer,
    editor,
    footer,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    toolOutputExpanded: false,
    sessions: [],
    loadingSessions: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    tasksBrowser: undefined,
    workflowsBrowser: undefined,
    teamsBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
  };

  // Sticky prompt header (Claude Code style): while scrolled up, pin the user
  // message anchoring the current view as a one-line full-width summary at the
  // viewport top. Scrolling past a message flips the header to the previous
  // one; clicking the row jumps to that message's position (pi-tui handles it).
  ui.setStickyHeaderContent((width, scrollTop, viewportHeight, transcript) => {
    const viewportBottom = scrollTop + viewportHeight;
    let selected: { entry: TranscriptEntry; start: number } | null = null;
    if (transcript !== null) {
      // Row-index geometry: base/height are exact line offsets at the current
      // layout width, so a scrolled-up frame costs a number walk instead of a
      // render call per transcript child.
      for (const { child, base } of transcript) {
        const entry = getTranscriptComponentEntry(child);
        if (entry?.kind !== 'user') continue;
        // The header anchors to the last user message whose first line is
        // above the viewport bottom (visible or just above it).
        if (base >= viewportBottom) break;
        selected = { entry, start: base };
      }
    } else {
      // Legacy whole-render fallback (row index declined): measure by render.
      const innerWidth = Math.max(1, width - CHROME_GUTTER * 2);
      let offset = 0;
      for (const child of state.transcriptContainer.children) {
        const entry = getTranscriptComponentEntry(child);
        if (entry?.kind === 'user') {
          if (offset >= viewportBottom) break;
          selected = { entry, start: offset };
        }
        offset += child.render(innerWidth).length;
      }
    }
    if (!selected) return null;
    const firstLine = selected.entry.content.split('\n').find((line) => line.trim().length > 0) ?? '';
    if (firstLine.length === 0) return null;
    const summary = truncateToWidth(firstLine.trim(), Math.max(1, width - 5), '…');
    const line = ` ${currentTheme.boldFg('roleUser', '⏺')} ${summary}`;
    return {
      line: applyBackgroundToLine(truncateToWidth(line, width, '…'), width, (s) =>
        currentTheme.bg('userMessageBackground', s),
      ),
      jumpTo: selected.start,
    };
  });

  return state;
}
