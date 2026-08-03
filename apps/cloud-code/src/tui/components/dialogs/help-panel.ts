/**
 * HelpPanel — modal `/help` display. Lists keyboard shortcuts, slash
 * commands (with aliases + descriptions) in colour-coded sections.
 *
 * Mirrors the container-replacement pattern used by SessionPicker /
 * ApprovalPanel: host mounts the panel into `editorContainer`, picks
 * it as the focused component, and tears it down on the `onClose`
 * callback (fired on Esc / Enter / Backspace / q).
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
  truncateToWidth,
  visibleWidth,
} from '@cloud-code/pi-tui';
import { resolveDescription, t } from '#/tui/i18n';
import { columnWidth, renderRow } from '#/tui/components/primitives';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';
import { underlineText } from '#/tui/utils/mouse-hover';

export interface KeyboardShortcut {
  readonly keys: string;
  /** Display text, or an i18n key resolved at render time. */
  readonly description: string;
}

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/**
 * Static list — keep in sync with the global editor bindings. Descriptions
 * are i18n keys (module-level constants predate the runtime locale); the
 * panel resolves them at render time via `resolveDescription()`.
 */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Shift-Tab', description: 'help.shortcut.togglePlan' },
  { keys: 'Ctrl-G', description: 'help.shortcut.externalEditor' },
  { keys: 'Ctrl-O', description: 'help.shortcut.toggleToolOutput' },
  { keys: 'Ctrl-T', description: 'help.shortcut.toggleTodo' },
  { keys: 'Ctrl-S', description: 'help.shortcut.steer' },
  { keys: 'Shift-Enter / Ctrl-J', description: 'help.shortcut.newline' },
  { keys: 'Ctrl-C', description: 'help.shortcut.interrupt' },
  { keys: 'Ctrl-D', description: 'help.shortcut.exit' },
  { keys: 'Esc', description: 'help.shortcut.escape' },
  { keys: '↑ / ↓', description: 'help.shortcut.history' },
  { keys: 'Enter', description: 'help.shortcut.submit' },
  { keys: 'Shift-PgUp / Shift-PgDn', description: 'help.shortcut.scrollTranscript' },
  { keys: 'Ctrl-Home / Ctrl-End', description: 'help.shortcut.scrollTranscriptEnds' },
  { keys: 'Shift-Drag', description: 'help.shortcut.mouseSelect' },
];

/**
 * NORMAL-mode keys, shown as their own section when vim editing is enabled
 * (tui.toml editor.vim_mode or /vim). Descriptions are i18n keys resolved at
 * render time, same as DEFAULT_KEYBOARD_SHORTCUTS.
 */
export const VIM_NORMAL_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Esc (INSERT)', description: 'help.shortcut.vim.enterNormal' },
  { keys: 'i a A I o O', description: 'help.shortcut.vim.enterInsert' },
  { keys: 'h j k l', description: 'help.shortcut.vim.move' },
  { keys: 'w b e', description: 'help.shortcut.vim.word' },
  { keys: '0 ^ $', description: 'help.shortcut.vim.linePos' },
  { keys: 'gg G', description: 'help.shortcut.vim.buffer' },
  { keys: 'f t ; ,', description: 'help.shortcut.vim.find' },
  { keys: 'x r', description: 'help.shortcut.vim.deleteChar' },
  { keys: 'd c y + motion', description: 'help.shortcut.vim.operator' },
  { keys: 'p P', description: 'help.shortcut.vim.paste' },
  { keys: 'u Ctrl-R', description: 'help.shortcut.vim.undo' },
  { keys: '.', description: 'help.shortcut.vim.repeat' },
];

export interface HelpPanelOptions {
  readonly commands: readonly HelpPanelCommand[];
  readonly shortcuts?: readonly KeyboardShortcut[];
  /**
   * NORMAL-mode key rows (VIM_NORMAL_SHORTCUTS), rendered as their own
   * section between the global shortcuts and the slash commands. Omit or
   * pass an empty list when vim editing is disabled.
   */
  readonly vimShortcuts?: readonly KeyboardShortcut[];
  readonly onClose: () => void;
  /**
   * Click action for a slash-command row. When set, every visible command
   * row declares a full-width hit zone and a left press on it fires this
   * callback with the row's command (the host typically closes the panel
   * and seeds the editor with `/<name>`). Omit it and the rows stay
   * inert display text, exactly as before.
   */
  readonly onCommandClick?: (command: HelpPanelCommand) => void;
  /**
   * Explicit cap on visible list rows. Wins over `terminalRows` when both
   * are set; floored at 5 so the panel never degenerates to zero rows.
   */
  readonly maxVisible?: number;
  /**
   * Live viewport-height getter (same `() => terminal.rows` idiom as
   * BottomAnchorContainer) — a getter, not a snapshot, so a terminal
   * resize while the panel is open re-caps the list on the next render.
   */
  readonly terminalRows?: () => number;
}

/**
 * Rows reserved around the scrollable list when the host derives
 * `maxVisible` from `terminal.rows`: the panel's own top/bottom borders +
 * "showing X-Y of Z" tail (3, rendered here), the editor-slot `▔`
 * separator above the panel (1) and the two-line footer below it (2,
 * rendered by the host). Without the cap a small terminal pushes the
 * title/borders above the viewport.
 */
export const HELP_PANEL_CHROME_ROWS = 6;

/** Historical default when no terminal height is known. */
const FALLBACK_MAX_VISIBLE = 24;

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private scrollTop = 0;
  /**
   * Render by-products backing hitZones(): the sorted command list the rows
   * were built from and the visible command-row zones (component frame, same
   * coordinate space as translated mouse events). A render always runs
   * before input is dispatched, so the cache is never stale.
   */
  private lastSortedCommands: readonly HelpPanelCommand[] = [];
  private lastCommandZones: HitZone[] = [];
  private hoveredCommandIndex: number | null = null;
  /** Width of the last render; the scroll math is width-aware because the
   * title hint wraps at narrow widths (a render always precedes input). */
  private lastRenderWidth = 80;

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      // Backspace also dismisses: the `?`-shortcut flow opens this panel with
      // a draft still in the editor, and Backspace is the natural "go back
      // and edit" key there.
      matchesKey(data, Key.backspace) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = this.clampScroll(this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop = this.clampScroll(this.scrollTop + 1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = this.clampScroll(this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop = this.clampScroll(this.scrollTop + 10);
    }
  }

  /** Hover-to-scroll: wheel scrolls the shortcut/command list. */
  handleMouse(event: MouseEvent): void {
    if (event.type !== 'wheel') return;
    const delta = event.button === 64 ? -3 : event.button === 65 ? 3 : 0;
    if (delta === 0) return;
    this.scrollTop = this.clampScroll(this.scrollTop + delta);
  }

  /**
   * One full-width action zone per visible slash-command row (cached by
   * render; rows are only clickable when the host supplied onCommandClick).
   * Wheel events are unaffected — zones only intercept presses/hover.
   */
  hitZones(): Iterable<HitZone> {
    return this.lastCommandZones;
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const command = this.lastSortedCommands[Number(id)];
    if (command === undefined) return false;
    this.opts.onCommandClick?.(command);
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const next = id === null ? null : Number(id);
    if (next === this.hoveredCommandIndex) return false;
    this.hoveredCommandIndex = next;
  }

  /**
   * Clamps a scroll position into the valid window for the current content
   * and viewport. The input/wheel handlers own the stored position (render
   * is pure — it derives the same clamped window locally without storing
   * it), so every mutation settles here.
   */
  private clampScroll(scrollTop: number): number {
    const maxVisible = Math.max(5, this.opts.maxVisible ?? this.defaultMaxVisible());
    return Math.max(0, Math.min(scrollTop, this.contentRowCount() - maxVisible));
  }

  /**
   * Rows of the scrollable region (everything between the two dividers).
   * Probed at the last render width: the title hint wraps onto extra rows
   * at narrow widths, so the count is width-dependent.
   */
  private contentRowCount(): number {
    return this.buildLines(this.lastRenderWidth).lines.length - 2;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const { lines, commandRowStart, sortedCommands } = this.buildLines(width);
    this.lastSortedCommands = sortedCommands;

    // Apply scroll windowing — keep the borders visible. The window is a
    // pure function of state: the stored position is clamped locally, never
    // written back (the input/wheel handlers own the stored scrollTop).
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? this.defaultMaxVisible());
    if (content.length > maxVisible) {
      const scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      this.lastCommandZones = this.commandZones(sortedCommands.length, commandRowStart, width, (fullRow) => {
        const row = fullRow - scrollTop;
        return row >= 1 && row <= maxVisible ? row : null;
      });
      const slice = content.slice(scrollTop, scrollTop + maxVisible);
      const scrollInfo = currentTheme.fg(
        'textMuted',
        t('help.scrollInfo', {
          from: scrollTop + 1,
          to: scrollTop + slice.length,
          total: content.length,
        }),
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.lastCommandZones = this.commandZones(sortedCommands.length, commandRowStart, width, (fullRow) => fullRow);
    return lines.map((line) => truncateToWidth(line, width));
  }

  /**
   * Zones for the command rows that survive windowing. `mapRow` translates a
   * full (unwindowed) row index into its rendered row, or null when the row
   * scrolled out of view. Empty unless the host made rows clickable.
   */
  private commandZones(
    commandCount: number,
    commandRowStart: number,
    width: number,
    mapRow: (fullRow: number) => number | null,
  ): HitZone[] {
    if (this.opts.onCommandClick === undefined) return [];
    const zones: HitZone[] = [];
    for (let i = 0; i < commandCount; i++) {
      const row = mapRow(commandRowStart + i);
      if (row === null) continue;
      zones.push({ id: i, row, col: 1, width, height: 1 });
    }
    return zones;
  }

  /** The full, unwindowed panel lines, dividers included. */
  private buildLines(width: number): {
    lines: string[];
    commandRowStart: number;
    sortedCommands: readonly HelpPanelCommand[];
  } {
    const chrome = (text: string) => currentTheme.fg('border', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);

    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    const vimShortcuts = this.opts.vimShortcuts ?? [];
    // Columns align by display width so CJK descriptions never drift them.
    const kbdWidth = columnWidth(
      [...shortcuts.map((s) => s.keys), ...vimShortcuts.map((s) => s.keys)],
      8,
    );
    const sortedCmds = [...this.opts.commands].toSorted(compareSlashCommandsForDisplay);
    const cmdLabels = sortedCmds.map((c) => {
      const aliases = c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
      return `/${c.name}${aliases}`;
    });
    const cmdWidth = columnWidth(cmdLabels, 12);
    const kbdRow = (s: KeyboardShortcut): string =>
      renderRow(
        [
          { text: s.keys, token: 'primary', width: kbdWidth },
          { text: resolveDescription(s.description), token: 'textDim' },
        ],
        { margin: 4 },
      );
    // The title keeps its inline hint while it fits; at narrow widths the
    // hint drops to its own wrapped line(s) instead of truncating mid-token.
    const titleText = ` ${t('help.title')} `;
    const hintText = t('help.hint');
    const titleLines =
      visibleWidth(titleText) + visibleWidth(hintText) <= width
        ? [currentTheme.boldFg('border', titleText) + muted(hintText)]
        : [
            currentTheme.boldFg('border', titleText),
            ...wrapHintText(hintText, width - 1).map((line) => muted(` ${line}`)),
          ];
    const lines: string[] = [
      chrome('─'.repeat(width)),
      ...titleLines,
      '',
      // Greeting
      `  ${dim(t('help.greeting'))}`,
      '',
      // Section: keyboard shortcuts
      `  ${currentTheme.boldFg('primary', t('help.section.shortcuts'))}`,
      ...shortcuts.map(kbdRow),
      // Section: vim NORMAL-mode keys (only when vim editing is enabled)
      ...(vimShortcuts.length > 0
        ? [
            '',
            `  ${currentTheme.boldFg('primary', t('help.section.vim'))}`,
            ...vimShortcuts.map(kbdRow),
          ]
        : []),
      '',
      // Section: slash commands
      `  ${currentTheme.boldFg('primary', t('help.section.commands'))}`,
      ...sortedCmds.map((cmd, i) => {
        const label = cmdLabels[i] ?? `/${cmd.name}`;
        const row = renderRow(
          [
            { text: label, token: 'primary', width: cmdWidth },
            { text: cmd.description, token: 'textDim' },
          ],
          { margin: 4 },
        );
        return underlineText(row, this.hoveredCommandIndex === i);
      }),
      '',
      chrome('─'.repeat(width)),
    ];
    // Rows: 0 divider, then the title block (1+ rows — the hint wraps at
    // narrow widths), blanks/greeting/section head, then the shortcut rows,
    // the optional vim block (blank + head + rows), one blank and the
    // commands section head — command rows start right after.
    const commandRowStart =
      lines.length - 2 - sortedCmds.length;
    return { lines, commandRowStart, sortedCommands: sortedCmds };
  }

  /**
   * Visible list rows when the caller didn't pin `maxVisible`: viewport
   * height minus the surrounding chrome (see HELP_PANEL_CHROME_ROWS), or
   * the historical constant when no terminal height was provided.
   */
  private defaultMaxVisible(): number {
    const rows = this.opts.terminalRows?.();
    return rows === undefined ? FALLBACK_MAX_VISIBLE : rows - HELP_PANEL_CHROME_ROWS;
  }
}

function compareSlashCommandsForDisplay(a: HelpPanelCommand, b: HelpPanelCommand): number {
  return (
    getSlashCommandDisplayGroup(a.name) - getSlashCommandDisplayGroup(b.name) ||
    a.name.localeCompare(b.name)
  );
}

function getSlashCommandDisplayGroup(name: string): number {
  return name.startsWith('skill:') ? 1 : 0;
}
