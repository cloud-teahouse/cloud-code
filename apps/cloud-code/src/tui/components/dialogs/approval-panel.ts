/**
 * ApprovalPanel — pi-tui version of the approval request UI.
 *
 * Container-based component with keyboard navigation.
 */

import {
  Container,
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@cloud-code/pi-tui';
import type { PermissionMode } from '@cloud-code/sdk';
import { currentTheme } from '#/tui/theme';
import { t } from '#/tui/i18n';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { wrapHintText } from '#/tui/utils/hint';
import type {
  ApprovalPanelChoice,
  ApprovalPanelData,
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

export interface ApprovalPanelResponse {
  readonly response: 'approved' | 'approved_for_session' | 'approved_always' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
  readonly selected_label?: string | undefined;
  readonly mode?: PermissionMode | undefined;
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

const DIFF_SUMMARY_MAX_LINES = 10;
const CONTENT_SUMMARY_MAX_LINES = 10;

interface BlockStyles {
  strong: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  gutter: (s: string) => string;
  errorBold: (s: string) => string;
}

function makeBlockStyles(): BlockStyles {
  return {
    strong: (s) => currentTheme.fg('textStrong', s),
    dim: (s) => currentTheme.fg('textDim', s),
    accent: (s) => currentTheme.fg('accent', s),
    gutter: (s) => currentTheme.fg('diffGutter', s),
    errorBold: (s) => currentTheme.boldFg('error', s),
  };
}

function appendWrappedLine(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
  const wrapped = wrapTextWithAnsi(content, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(firstPrefix);
    return;
  }
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`);
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(`${continuationPrefix}${wrapped[i] ?? ''}`);
  }
}

function renderShellDisplayBlock(
  block: Extract<DisplayBlock, { type: 'shell' }>,
  s: BlockStyles,
  width: number,
): string[] {
  const lines: string[] = [];
  if (block.cwd !== undefined && block.cwd.length > 0) {
    lines.push(s.dim(`cwd: ${block.cwd}`));
  }
  if (block.danger !== undefined) {
    lines.push(s.errorBold(t('approval.dangerous', { label: block.danger })));
  }
  const cmdLines = block.command.length > 0 ? block.command.split('\n') : [''];
  cmdLines.forEach((cmdLine, idx) => {
    const prefix = idx === 0 ? `${s.accent('$')} ` : `${s.dim('·')} `;
    appendWrappedLine(lines, prefix, '  ', s.strong(cmdLine), width);
  });
  if (block.description !== undefined && block.description.length > 0) {
    lines.push(`  ${s.dim(block.description)}`);
  }
  return lines;
}

function renderDisplayBlock(
  block: DisplayBlock,
  s: BlockStyles,
  contentWidth: number,
): string[] {
  switch (block.type) {
    case 'diff':
      return renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
        contextLines: 3,
        expandKeyHint: t('approval.expandHint'),
        maxLines: DIFF_SUMMARY_MAX_LINES,
      });
    case 'file_content': {
      const lang = block.language ?? langFromPath(block.path);
      const allLines = highlightLines(block.content, lang);
      const shown = allLines.slice(0, CONTENT_SUMMARY_MAX_LINES);
      const lines = [s.strong(block.path)];
      for (const [i, line] of shown.entries()) {
        lines.push(s.gutter(String(i + 1).padStart(4) + '  ') + line);
      }
      const remaining = allLines.length - shown.length;
      if (remaining > 0) {
        lines.push(
          s.dim(
            remaining === 1
              ? t('approval.hiddenLines.one', { count: remaining })
              : t('approval.hiddenLines.other', { count: remaining }),
          ),
        );
      }
      return lines;
    }
    case 'shell':
      return renderShellDisplayBlock(block, s, contentWidth);
    case 'file_op': {
      const op = s.accent(block.operation.padEnd(5));
      const lines = [`${op} ${s.strong(block.path)}`];
      if (block.detail !== undefined && block.detail.length > 0) {
        lines.push(s.dim(block.detail));
      }
      return lines;
    }
    case 'url_fetch': {
      const method = s.accent((block.method ?? 'GET').toUpperCase().padEnd(5));
      return [`${method} ${s.strong(block.url)}`];
    }
    case 'search': {
      const lines = [`${s.accent(t('approval.displayBlock.search'))} ${s.strong(block.query)}`];
      if (block.scope !== undefined && block.scope.length > 0) {
        lines.push(s.dim(`scope: ${block.scope}`));
      }
      return lines;
    }
    case 'invocation': {
      const lines = [`${s.accent(block.kind.padEnd(5))} ${s.strong(block.name)}`];
      if (block.description !== undefined && block.description.length > 0) {
        lines.push(s.dim(truncateOneLine(block.description, 200)));
      }
      return lines;
    }
    case 'brief':
      return block.text
        ? block.text.split('\n').map((line) => (line.length > 0 ? s.strong(line) : ''))
        : [];
    case 'background_task':
      return [
        s.strong(
          t('approval.displayBlock.backgroundTask', {
            status: block.status,
            kind: block.kind,
            id: block.task_id,
            description: block.description,
          }),
        ),
      ];
    case 'todo':
      return block.items.map((item) => s.strong(`- [${item.status}] ${item.title}`));
    default:
      return [];
  }
}

function normalizeApprovalText(text: string): string {
  return text.replaceAll('\r\n', '\n').trim();
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false;
  const normalizedDescription = normalizeApprovalText(description);
  if (normalizedDescription.length === 0) return false;
  const normalizedBlockText = normalizeApprovalText(block.text);
  if (normalizedBlockText === normalizedDescription) return true;
  const blockLines = normalizedBlockText.split('\n');
  if (blockLines.length <= 1) return false;
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription;
}

function headerFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return t('approval.header.bash');
    case 'Write':
      return t('approval.header.write');
    case 'Edit':
      return t('approval.header.edit');
    case 'TaskStop':
      return t('approval.header.taskStop');
    case 'ExitPlanMode':
      return t('approval.header.exitPlanMode');
    default:
      return t('approval.header.default', { tool: toolName });
  }
}

export class ApprovalPanelComponent extends Container implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private feedbackMode = false;
  private readonly feedbackInput = new Input();
  private onResponse: (response: ApprovalPanelResponse) => void;
  private request: PendingApproval;
  private readonly onToggleToolOutput: (() => void) | undefined;
  private readonly onOpenPreview:
    | ((block: DiffDisplayBlock | FileContentDisplayBlock) => void)
    | undefined;
  /**
   * Fired when the user engages with the panel without deciding (arrow-key
   * navigation, feedback typing). The approval controller timestamps these
   * so async auto-approval must not dismiss a dialog the user is actively
   * working with.
   */
  private readonly onUserInteraction: (() => void) | undefined;
  /** Hovered choice index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState<HitZoneId>();
  /**
   * The dialog skeleton owning the chrome (divider/title/requester badge)
   * and its row math. The approval family's chrome is the borderFocus
   * (amber) token rather than the frame's default border, and the title
   * keeps its ▶ marker — both carried by the frame's tone/formatTitleLine
   * chrome options.
   */
  private readonly frame = new DialogFrame({
    tone: 'borderFocus',
    minSize: inlineDialogMinSize(),
    formatTitleLine: (line) =>
      `  ${currentTheme.boldFg('borderFocus', '▶')} ${currentTheme.boldFg('borderFocus', line)}`,
    // The badge arrives pre-styled and pre-clamped (see render); the frame
    // must not re-style or re-wrap it.
    hintIndent: '',
    formatHintLine: (line) => line,
  });
  /**
   * Frame-relative hit zones of the choice rows, cached by render() — the
   * panel's header height depends on wrapped blocks/descriptions, so the
   * zones declare the layout the renderer actually produced (offset into the
   * component frame by DialogFrame.zones) instead of re-deriving it. Zone id
   * = choice index; each zone spans its choice's full-width rows. The armed
   * feedback row declares no zone — the inline input owns it.
   */
  private choiceZones: HitZone[] = [];

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalPanelResponse) => void,
    onToggleToolOutput?: () => void,
    onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void,
    onUserInteraction?: () => void,
  ) {
    super();
    this.request = request;
    this.onResponse = onResponse;
    this.onToggleToolOutput = onToggleToolOutput;
    this.onOpenPreview = onOpenPreview;
    this.onUserInteraction = onUserInteraction;
    this.feedbackInput.onSubmit = (value) => {
      this.submit(this.selectedIndex, value);
    };
    this.feedbackInput.onEscape = () => {
      this.feedbackMode = false;
      this.feedbackInput.setValue('');
    };
  }

  private submit(index: number, feedback: string = ''): void {
    const option = this.choiceAt(index);
    if (!option) return;
    this.onResponse({
      response: option.response,
      feedback: feedback || undefined,
      selected_label: option.selected_label,
      mode: option.mode,
    });
  }

  private selectAndSubmit(index: number): void {
    const option = this.choiceAt(index);
    if (!option) return;
    if (option.requires_feedback === true) {
      this.selectedIndex = index;
      this.feedbackMode = true;
    } else {
      this.submit(index);
    }
  }

  handleInput(data: string): void {
    // Esc peels the innermost state first: while feedback is armed it exits
    // the inline input (discarding the draft); only then does Esc reject.
    if (matchesKey(data, Key.escape)) {
      if (this.feedbackMode) {
        this.feedbackMode = false;
        this.feedbackInput.setValue('');
        return;
      }
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (matchesKey(data, Key.ctrl('e'))) {
      const previewable = this.findPreviewableBlock();
      if (previewable !== undefined && this.onOpenPreview !== undefined) {
        this.onOpenPreview(previewable);
      }
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.feedbackMode) {
      if (matchesKey(data, Key.up)) {
        this.onUserInteraction?.();
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.onUserInteraction?.();
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
        return;
      }
      // Typing feedback is engagement too — an async approver must not close
      // the dialog mid-sentence.
      this.onUserInteraction?.();
      this.feedbackInput.handleInput(data);
      return;
    }

    if (this.choiceCount() === 0) return;
    if (matchesKey(data, Key.up)) {
      this.onUserInteraction?.();
      this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.onUserInteraction?.();
      this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAndSubmit(this.selectedIndex);
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numericIndex = Number(printable) - 1;
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < this.choiceCount()) {
      this.selectAndSubmit(numericIndex);
    }
  }

  /**
   * Mouse: the wheel moves the highlighted choice, clamped at the ends rather
   * than wrapping like the arrow keys. Left-press highlights the hit choice;
   * a press on the already-highlighted choice submits it (Enter equivalent —
   * see utils/mouse-hover for the uniform click semantics). Motion
   * underlines the hovered choice. While typing feedback a press on another
   * choice leaves feedback mode and highlights it (the ↑/↓ behaviour); the
   * inline input row itself stays owned by the input.
   *
   * Press and hover targeting is declared as hit zones (one per choice row —
   * see renderContent); the TUI dispatches zone presses to {@link onHitZone} and
   * tracks the hovered zone via {@link setHoveredZone}. This handler keeps
   * the wheel behavior and routes presses/motion arriving outside the zone
   * dispatch (e.g. direct component-relative events) through the same zones.
   */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type === 'motion') {
      const zone = event.row < 0 ? null : hitZoneAt(this.choiceZones, event.row, event.col, 'hover');
      return this.setHoveredZone(zone?.id ?? null);
    }
    if (event.type === 'press' && event.button === 0) {
      const zone = hitZoneAt(this.choiceZones, event.row, event.col, 'action');
      if (zone === null) return false;
      return this.onHitZone(zone.id, event);
    }
    if (event.type !== 'wheel') return false;
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.feedbackMode || this.choiceCount() === 0) return false;
    const next = Math.max(0, Math.min(this.choiceCount() - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return false;
    this.onUserInteraction?.();
    this.selectedIndex = next;
    this.invalidate();
  }

  /** The declared choice-row zones — one per choice, full width. */
  hitZones(): Iterable<HitZone> {
    return this.choiceZones;
  }

  /** Zone press: the zone id is the choice index (see renderContent). */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const hit = typeof id === 'number' ? id : -1;
    if (this.choiceAt(hit) === undefined) return false;
    if (this.feedbackMode) {
      if (hit === this.selectedIndex) return false; // the inline input owns its row
      this.onUserInteraction?.();
      this.feedbackMode = false;
      this.selectedIndex = hit;
      this.invalidate();
      return;
    }
    if (hit === this.selectedIndex) {
      this.onUserInteraction?.();
      this.selectAndSubmit(hit);
      return;
    }
    this.onUserInteraction?.();
    this.selectedIndex = hit;
    this.invalidate();
  }

  /** Zone hover: the hovered choice underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  override render(width: number): string[] {
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.choiceZones = [];
      return tooSmall;
    }
    this.clear();
    this.ensureValidSelection();
    this.feedbackInput.focused = this.focused && this.feedbackMode;
    const { data } = this.request;

    const { lines, zones } = this.renderContent(width);
    const frameLines = this.frame.render(width, {
      title: headerFor(data.tool_name),
      // Worker badge: a bridged teammate ask names its requester under the
      // title so concurrent teammate asks never blur into the leader's own.
      // The badge was a single clamped line pre-frame (never wrapped), so it
      // enters the frame pre-styled and pre-clamped; the identity
      // formatHintLine in the chrome config passes it through untouched.
      ...(data.requester !== undefined
        ? { hintLines: [this.requesterBadgeLine(data.requester, width)] }
        : {}),
      content: lines,
    });
    this.choiceZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /** The dim requester badge line under the title, clamped to the width. */
  private requesterBadgeLine(
    requester: NonNullable<ApprovalPanelData['requester']>,
    width: number,
  ): string {
    const badge =
      requester.teamName !== undefined
        ? t('approval.requesterBadge', { name: requester.name, team: requester.teamName })
        : t('approval.requesterBadgeNoTeam', { name: requester.name });
    return truncateToWidth(`  ${currentTheme.fg('textDim', badge)}`, width);
  }

  /**
   * The content region (between the title block's blank line and the closing
   * divider): the display blocks (or the description), the choice rows, and
   * the key hints. Returns the lines plus the content-relative hit zones
   * (row 0 = first content line; one zone per choice, spanning its label and
   * description rows — except the armed feedback row, which the inline input
   * owns and which therefore declares no zone).
   */
  private renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const { data } = this.request;
    const blockStyles = makeBlockStyles();
    const selectColorBold = (text: string) => currentTheme.boldFg('accent', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const strong = (text: string) => currentTheme.fg('textStrong', text);
    const indent = (s: string): string => `  ${s}`;
    const lines: string[] = [];
    const zones: HitZone[] = [];

    const dedupedBlocks = data.display.filter(
      (block) => !isDuplicateBriefBlock(block, data.description),
    );
    const visibleBlocks = dedupedBlocks.slice(0, 5);
    const hasPreviewable = visibleBlocks.some(
      (block) => block.type === 'diff' || block.type === 'file_content',
    );

    if (visibleBlocks.length > 0) {
      for (const block of visibleBlocks) {
        const blockLines = renderDisplayBlock(
          block,
          blockStyles,
          Math.max(1, width - 2),
        );
        for (const line of blockLines) {
          lines.push(indent(line));
        }
      }
      lines.push('');
    } else if (data.description) {
      for (const descLine of data.description.split('\n')) {
        lines.push(indent(dim(descLine)));
      }
      lines.push('');
    }

    for (let idx = 0; idx < data.choices.length; idx++) {
      const option = data.choices[idx];
      if (option === undefined) continue;
      const isSelected = idx === this.selectedIndex;
      const num = idx + 1;
      const choiceTop = lines.length;
      const feedbackArmed =
        this.feedbackMode && option.requires_feedback === true && isSelected;

      const labelWithNum = `${String(num)}. ${option.label}`;
      if (feedbackArmed) {
        lines.push(indent(this.renderInlineFeedbackLine(width - 2, labelWithNum)));
      } else if (isSelected) {
        lines.push(
          underlineText(
            indent(`${selectColorBold('▶')} ${selectColorBold(labelWithNum)}`),
            this.hover.isHovered(idx),
          ),
        );
      } else {
        lines.push(underlineText(indent(strong(`  ${labelWithNum}`)), this.hover.isHovered(idx)));
      }

      // Optional helper text under the label, aligned past the pointer/number.
      // Choices without a description render exactly as before.
      if (
        option.description !== undefined &&
        option.description.length > 0 &&
        !feedbackArmed
      ) {
        for (const descLine of wrapTextWithAnsi(option.description, Math.max(20, width - 7))) {
          lines.push(indent(`     ${dim(descLine)}`));
        }
      }
      if (!feedbackArmed) {
        zones.push({ id: idx, row: choiceTop, col: 1, width, height: lines.length - choiceTop });
      }
    }

    lines.push('');
    if (this.feedbackMode) {
      for (const hintLine of wrapHintText(t('approval.hint.feedback'), width - 2)) {
        lines.push(indent(dim(hintLine)));
      }
    } else {
      const expandHint = hasPreviewable ? t('approval.hint.preview') : '';
      const hint =
        t('approval.hint.select', { numbers: buildNumericHint(data.choices.length) }) + expandHint;
      for (const hintLine of wrapHintText(hint, width - 2)) {
        lines.push(indent(dim(hintLine)));
      }
    }
    return { lines, zones };
  }

  private findPreviewableBlock(): DiffDisplayBlock | FileContentDisplayBlock | undefined {
    for (const block of this.request.data.display) {
      if (block.type === 'diff' || block.type === 'file_content') return block;
    }
    return undefined;
  }

  private choiceAt(index: number): ApprovalPanelChoice | undefined {
    return this.request.data.choices[index];
  }

  private choiceCount(): number {
    return this.request.data.choices.length;
  }

  private ensureValidSelection(): void {
    const count = this.choiceCount();
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex < 0 || this.selectedIndex >= count) {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
    }
  }

  private renderInlineFeedbackLine(width: number, labelWithNum: string): string {
    const prefix = `${currentTheme.boldFg('accent', '▶')} ${currentTheme.boldFg('accent', labelWithNum)}  `;
    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.feedbackInput.render(inputWidth)[0] ?? '❯ ';
    const inlineInput = inputLine.startsWith('❯ ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
  }

  override invalidate(): void {
    super.invalidate();
    this.feedbackInput.invalidate();
  }
}

function buildNumericHint(count: number): string {
  if (count <= 0) return '↵';
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/');
}
