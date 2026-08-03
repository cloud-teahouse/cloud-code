/**
 * QuestionDialog — pi-tui version of the structured question prompt.
 *
 * Each question collects an answer locally, and a final Submit tab
 * reviews everything before the answers are emitted upstream.
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

import { currentTheme } from '#/tui/theme';
import { t } from '#/tui/i18n';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { wrapHint } from '#/tui/utils/hint';
import type {
  PendingQuestion,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from '#/tui/reverse-rpc/types';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const MAX_BODY_LINES = 12;
const SUBMIT_ACTION_KEYS = ['dialogs.question.submit', 'dialogs.question.cancel'] as const;

interface DisplayOption {
  readonly label: string;
  readonly description?: string | undefined;
  readonly kind: 'preset' | 'other';
}

/**
 * Push `content` to `lines`, wrapping it to fit `width` with a hanging
 * indent. The first physical line starts with `firstPrefix`; continuation
 * lines get `continuationPrefix`. Pass `tone` to wrap every emitted line
 * in a single ANSI span (cleaner for selection highlights and matches the
 * pre-wrap rendering tests expect); leave it undefined when the prefixes
 * already carry their own mixed styling.
 */
function appendWrapped(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
  tone?: (s: string) => string,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  const styleLine = tone ?? ((s: string) => s);
  if (wrapped.length === 0) {
    lines.push(styleLine(firstPrefix));
    return;
  }
  lines.push(styleLine(`${firstPrefix}${wrapped[0] ?? ''}`));
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(styleLine(`${continuationPrefix}${wrapped[i] ?? ''}`));
  }
}

export class QuestionDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly request: PendingQuestion;
  private readonly onAnswer: (response: QuestionPanelResponse) => void;
  private readonly maxVisibleOptions: number;
  private readonly otherInput = new Input();

  private currentTab = 0;
  private submitActionIdx = 0;
  private editingOther = false;
  private reviewMessage: string | undefined;
  private lastAnswerMethod: QuestionSubmissionMethod | undefined;

  /** Per-question cursor position. */
  private readonly cursors: number[];
  /** Per-question single-select choice. */
  private readonly singleSelections: (number | undefined)[];
  /** Per-question multi-select choices. */
  private readonly multiSelections: Set<number>[];
  /** Per-question free-text drafts for the synthetic Other option. */
  private readonly otherDrafts: string[];
  /** Per-question committed Other values. */
  private readonly committedOtherValues: (string | undefined)[];
  /** Per-question derived answers used by tabs + review. */
  private readonly answers: (string | undefined)[];

  private readonly onToggleToolOutput: (() => void) | undefined;

  /**
   * Hovered interactive element (mouse motion), namespaced: `tab:N` (question
   * tabs + the submit tab), `option:N` (visible option rows), `submit:N`
   * (submit-tab Submit/Cancel rows). Null when the pointer is elsewhere.
   */
  private readonly hover = new HoverState<string>();
  /** The dialog skeleton owning the chrome (divider/title) and its row math. */
  private readonly frame = new DialogFrame({ minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (tab cells, option rows,
   * submit actions) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(
    request: PendingQuestion,
    onAnswer: (response: QuestionPanelResponse) => void,
    maxVisibleOptions = 6,
    onToggleToolOutput?: () => void,
  ) {
    super();
    this.request = request;
    this.onAnswer = onAnswer;
    this.maxVisibleOptions = maxVisibleOptions;
    this.onToggleToolOutput = onToggleToolOutput;
    this.otherInput.onSubmit = (value) => {
      this.commitOtherInput(value, 'enter');
    };

    const total = request.data.questions.length;
    this.cursors = Array.from({ length: total }, (): number => 0);
    this.singleSelections = Array.from({ length: total }, (): number | undefined => undefined);
    this.multiSelections = Array.from({ length: total }, () => new Set<number>());
    this.otherDrafts = Array.from({ length: total }, (): string => '');
    this.committedOtherValues = Array.from({ length: total }, (): string | undefined => undefined);
    this.answers = Array.from({ length: total }, (): string | undefined => undefined);
  }

  // ── Input ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
    // Esc peels the innermost state first: while an Other answer is being
    // typed it leaves the inline input (draft kept); only then does Esc
    // cancel the dialog.
    if (matchesKey(data, Key.escape)) {
      if (this.isEditingOther()) {
        const questionIdx = this.currentQuestionIndex();
        if (questionIdx !== undefined) this.syncOtherDraft(questionIdx);
        this.editingOther = false;
        return;
      }
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.isEditingOther()) {
      this.handleOtherInput(data);
      return;
    }

    if (this.isSubmitTab()) {
      this.handleSubmitInput(data);
      return;
    }

    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const optionCount = this.displayOptions(questionIdx).length;
    if (optionCount === 0) return;

    if (matchesKey(data, Key.up)) {
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveQuestionCursor(1);
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift('tab'))) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.activateQuestionOption(this.currentCursor(), 'enter');
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numIdx = NUMBER_KEYS.indexOf(printable);
    if (numIdx >= 0 && numIdx < optionCount) {
      this.cursors[questionIdx] = numIdx;
      this.activateQuestionOption(numIdx, 'number_key');
      return;
    }

    if ((printable === ' ' || matchesKey(data, Key.space)) && question.multi_select) {
      this.activateQuestionOption(this.currentCursor(), 'space');
    }
  }

  private handleOtherInput(data: string): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    if (matchesKey(data, Key.tab)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.gotoTab(this.currentTab + 1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(1);
      return;
    }

    this.otherInput.handleInput(data);
    this.syncOtherDraft(questionIdx);
    this.reviewMessage = undefined;
  }

  private handleSubmitInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.submitActionIdx =
        (this.submitActionIdx - 1 + SUBMIT_ACTION_KEYS.length) % SUBMIT_ACTION_KEYS.length;
      this.reviewMessage = undefined;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.submitActionIdx = (this.submitActionIdx + 1) % SUBMIT_ACTION_KEYS.length;
      this.reviewMessage = undefined;
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift('tab'))) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.executeSubmitAction(this.submitActionIdx, 'enter');
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === '1') {
      this.submitActionIdx = 0;
      this.executeSubmitAction(0, 'number_key');
      return;
    }
    if (printable === '2') {
      this.submitActionIdx = 1;
      this.executeSubmitAction(1, 'number_key');
    }
  }

  // ── State mutation ────────────────────────────────────────────────

  /**
   * Mouse: the wheel moves the option cursor (or the submit-tab action),
   * clamped at the ends rather than wrapping like the arrow keys. Left-press
   * activates what it hits, mirroring the dialog's own key idioms: a tab
   * switches (←/→/Tab), an option answers/toggles it (number keys), a
   * submit-tab action highlights it — or executes it when already
   * highlighted (Enter). Motion underlines the hovered tab/option/action.
   * While typing an Other answer the inline input owns its row; presses
   * elsewhere commit to the pressed target like the arrow keys do.
   *
   * Press and hover targeting is declared as hit zones (tab cells, option
   * rows, submit actions — see renderQuestionContent/renderSubmitContent);
   * the TUI dispatches zone presses to {@link onHitZone} and tracks the
   * hovered zone via {@link setHoveredZone}. This handler keeps the wheel
   * behavior and routes presses/motion arriving outside the zone dispatch
   * (e.g. direct component-relative events) through the same zones.
   */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type !== 'wheel') {
      // Re-derived from the current state: direct callers (unit tests) may
      // fire keys without an intervening render, so the render cache can be
      // stale.
      const zones = this.currentZones();
      if (event.type === 'motion') {
        const zone = event.row < 0 ? null : hitZoneAt(zones, event.row, event.col, 'hover');
        return this.setHoveredZone(zone?.id ?? null);
      }
      if (event.type === 'press' && event.button === 0) {
        const zone = hitZoneAt(zones, event.row, event.col, 'action');
        if (zone === null) return false;
        return this.onHitZone(zone.id, event);
      }
      return false;
    }
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.isEditingOther()) return false;
    if (this.isSubmitTab()) {
      const next = Math.max(
        0,
        Math.min(SUBMIT_ACTION_KEYS.length - 1, this.submitActionIdx + delta),
      );
      if (next === this.submitActionIdx) return false;
      this.submitActionIdx = next;
      this.reviewMessage = undefined;
      this.invalidate();
      return;
    }
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return false;
    const total = this.displayOptions(questionIdx).length;
    if (total <= 0) return false;
    const nextCursor = Math.max(0, Math.min(total - 1, this.currentCursor() + delta));
    if (nextCursor === this.currentCursor()) return false;
    this.cursors[questionIdx] = nextCursor;
    this.reviewMessage = undefined;
    this.invalidate();
  }

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zones derived from the current state at the last render width (a
   * discarded render refreshes the cache). The handleMouse fallback consults
   * these so it never acts on a stale layout. */
  private currentZones(): HitZone[] {
    this.render(this.lastRenderWidth);
    return this.frameZones;
  }

  /**
   * Zone press: a tab cell switches tabs (←/→/Tab equivalent); an option row
   * answers/toggles it directly (toggle rows activate on press — see
   * utils/mouse-hover); a submit action highlights it, or executes it when
   * already highlighted (Enter equivalent).
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (typeof id !== 'string') return false;
    if (id.startsWith('tab:')) {
      const tab = Number(id.slice('tab:'.length));
      if (!Number.isInteger(tab) || tab < 0 || tab >= this.totalTabs() || tab === this.currentTab) {
        return false;
      }
      this.gotoTab(tab);
      this.invalidate();
      return;
    }
    if (id.startsWith('submit:')) {
      const action = Number(id.slice('submit:'.length));
      if (!Number.isInteger(action) || action < 0 || action >= SUBMIT_ACTION_KEYS.length) {
        return false;
      }
      if (action === this.submitActionIdx) {
        this.executeSubmitAction(action, 'enter');
        return;
      }
      this.submitActionIdx = action;
      this.reviewMessage = undefined;
      this.invalidate();
      return;
    }
    if (id.startsWith('option:')) {
      const optionIdx = Number(id.slice('option:'.length));
      const questionIdx = this.currentQuestionIndex();
      if (!Number.isInteger(optionIdx) || optionIdx < 0 || questionIdx === undefined) return false;
      if (optionIdx >= this.displayOptions(questionIdx).length) return false;
      this.activateQuestionOption(optionIdx, 'enter');
      this.invalidate();
      return;
    }
    return false;
  }

  /** Zone hover: the hovered tab/option/submit-action underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(typeof id === 'string' ? id : null);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  private gotoTab(target: number): void {
    const total = this.totalTabs();
    if (total <= 0) return;

    const wrapped = ((target % total) + total) % total;
    if (wrapped === this.currentTab) return;

    this.currentTab = wrapped;
    this.editingOther = false;
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
  }

  private moveQuestionCursor(delta: number): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const total = this.displayOptions(questionIdx).length;
    if (total <= 0) return;

    this.cursors[questionIdx] = (this.currentCursor() + delta + total) % total;
    this.reviewMessage = undefined;
  }

  private activateQuestionOption(optionIdx: number, method: QuestionSubmissionMethod): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    this.cursors[questionIdx] = optionIdx;
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (this.isOtherOption(questionIdx, optionIdx)) {
      this.enterOtherInput(questionIdx);
      return;
    }

    if (question.multi_select) {
      const set = this.multiSelections[questionIdx];
      if (set === undefined) return;
      if (set.has(optionIdx)) set.delete(optionIdx);
      else set.add(optionIdx);
      this.lastAnswerMethod = method;
      this.updateAnswer(questionIdx);
      return;
    }

    this.singleSelections[questionIdx] = optionIdx;
    this.committedOtherValues[questionIdx] = undefined;
    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.advanceAfterSingleSelect(questionIdx);
  }

  private enterOtherInput(questionIdx: number): void {
    this.cursors[questionIdx] = this.otherOptionIndex(questionIdx);
    this.editingOther = true;
    this.otherInput.setValue(this.otherDraftValue(questionIdx));
    this.reviewMessage = undefined;
  }

  private commitOtherInput(rawValue: string | undefined, method: QuestionSubmissionMethod): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const value = (rawValue ?? this.otherInput.getValue()).trim();
    if (value.length === 0) return;

    this.otherInput.setValue(value);
    this.otherDrafts[questionIdx] = value;
    this.committedOtherValues[questionIdx] = value;

    if (question.multi_select) {
      this.multiSelections[questionIdx]?.add(this.otherOptionIndex(questionIdx));
    } else {
      this.singleSelections[questionIdx] = this.otherOptionIndex(questionIdx);
    }

    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (!question.multi_select) this.advanceAfterSingleSelect(questionIdx);
  }

  private advanceAfterSingleSelect(questionIdx: number): void {
    const next = this.findNextUnansweredAfter(questionIdx);
    this.currentTab = next ?? this.submitTabIndex();
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
  }

  private findNextUnansweredAfter(fromIdx: number): number | null {
    const total = this.request.data.questions.length;
    for (let idx = fromIdx + 1; idx < total; idx++) {
      if (!this.isAnswered(idx)) return idx;
    }
    return null;
  }

  private updateAnswer(questionIdx: number): void {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    if (question.multi_select) {
      const labels: string[] = [];
      const set = this.multiSelections[questionIdx] ?? new Set<number>();
      const otherIdx = this.otherOptionIndex(questionIdx);
      for (let i = 0; i < question.options.length; i++) {
        if (!set.has(i)) continue;
        const label = question.options[i]?.label;
        if (label !== undefined && label.length > 0) labels.push(label);
      }
      const otherText = this.committedOtherValues[questionIdx];
      if (set.has(otherIdx) && otherText !== undefined && otherText.length > 0) {
        labels.push(otherText);
      }
      this.answers[questionIdx] = labels.length > 0 ? labels.join(', ') : undefined;
      return;
    }

    const selection = this.singleSelections[questionIdx];
    if (selection === undefined) {
      this.answers[questionIdx] = undefined;
      return;
    }

    if (this.isOtherOption(questionIdx, selection)) {
      const otherText = this.committedOtherValues[questionIdx];
      this.answers[questionIdx] =
        otherText !== undefined && otherText.length > 0 ? otherText : undefined;
      return;
    }

    const label = question.options[selection]?.label;
    this.answers[questionIdx] = label !== undefined && label.length > 0 ? label : undefined;
  }

  private executeSubmitAction(actionIdx: number, method: QuestionSubmissionMethod): void {
    if (actionIdx === 1) {
      this.onAnswer({ answers: [] });
      return;
    }

    this.reviewMessage = undefined;
    this.emitAnswers(method);
  }

  private emitAnswers(method: QuestionSubmissionMethod): void {
    const out: string[] = [];
    for (let i = 0; i < this.answers.length; i++) {
      const answer = this.answers[i];
      if (answer !== undefined && answer.length > 0) out[i] = answer;
    }
    this.onAnswer({ answers: out, method: this.lastAnswerMethod ?? method });
  }

  // ── Render ────────────────────────────────────────────────────────

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    this.otherInput.focused = this.focused && this.isEditingOther();
    const { lines, zones } = this.isSubmitTab()
      ? this.renderSubmitContent(width)
      : this.renderQuestionContent(width);
    const frameLines = this.frame.render(width, {
      title: t('dialogs.question.title'),
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region of a question tab (everything between the title's
   * blank line and the closing divider): the tab strip, the question, the
   * option rows, and the key hints. Returns the lines plus the
   * content-relative hit zones (row 0 = the tab strip; one zone per tab cell
   * and per visible option row). While the Other input is armed its row is
   * owned by the input (no zone) and the option zones stop hovering; presses
   * on the other rows still retarget like the arrow keys.
   */
  private renderQuestionContent(width: number): { lines: string[]; zones: HitZone[] } {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return this.renderSubmitContent(width);

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return { lines: [], zones: [] };

    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const success = (text: string) => currentTheme.fg('success', text);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const zones: HitZone[] = [];
    this.pushTabs(lines, zones);
    lines.push('');

    appendWrapped(lines, ' ? ', '   ', question.question, renderWidth, accent);
    if (this.isEditingOther()) {
      // One dim line when it fits; word-wrapped only when narrow.
      const otherHint = t('dialogs.question.otherHint');
      if (visibleWidth(otherHint) <= renderWidth) {
        lines.push(dim(otherHint));
      } else {
        appendWrapped(lines, '', '', otherHint, renderWidth, dim);
      }
    }

    if (question.body !== undefined && question.body.trim().length > 0) {
      lines.push('');
      const bodyLines = question.body.trim().split('\n');
      const visibleBodyLines = bodyLines.slice(0, MAX_BODY_LINES);
      for (const bodyLine of visibleBodyLines) {
        appendWrapped(lines, '   ', '   ', bodyLine, renderWidth, dim);
      }
      if (bodyLines.length > visibleBodyLines.length) {
        lines.push(
          dim(t('dialogs.question.moreLines', { count: bodyLines.length - visibleBodyLines.length })),
        );
      }
    }

    lines.push('');

    const options = this.displayOptions(questionIdx);
    const cursor = this.currentCursor();
    const visibleStart = this.computeVisibleStart(cursor, options.length);
    const visibleEnd = Math.min(options.length, visibleStart + this.maxVisibleOptions);
    const multiSet = this.multiSelections[questionIdx] ?? new Set<number>();
    const singleSelection = this.singleSelections[questionIdx];
    const editing = this.isEditingOther();

    for (let i = visibleStart; i < visibleEnd; i++) {
      const option = options[i];
      if (option === undefined) continue;
      const num = i + 1;
      const isCursor = i === cursor;
      const isOther = option.kind === 'other';
      const isSelected = question.multi_select ? multiSet.has(i) : singleSelection === i;
      const optionTop = lines.length;

      if (editing && isCursor && isOther) {
        lines.push(this.renderEditingOtherLine(renderWidth, questionIdx, option, num, isSelected));
        // The inline Other input owns its row — no zone.
        continue;
      }

      const label = this.renderOptionLabel(questionIdx, option, isCursor);

      let tone: (s: string) => string;
      let prefix: string;
      if (question.multi_select) {
        const checked = isSelected ? '✓' : ' ';
        prefix = `  [${checked}] `;
        if (isSelected && isCursor) tone = (s) => currentTheme.boldFg('success', s);
        else if (isSelected) tone = success;
        else if (isCursor) tone = accent;
        else tone = dim;
      } else if (isSelected && this.isAnswered(questionIdx)) {
        prefix = isCursor ? `  → [${String(num)}] ` : `    [${String(num)}] `;
        tone = isCursor ? (s) => currentTheme.boldFg('success', s) : success;
      } else if (isCursor) {
        prefix = `  → [${String(num)}] `;
        tone = accent;
      } else {
        prefix = `    [${String(num)}] `;
        tone = dim;
      }
      const continuation = ' '.repeat(visibleWidth(prefix));
      appendWrapped(lines, prefix, continuation, label, renderWidth, tone);

      if (
        option.description !== undefined &&
        option.description.length > 0 &&
        !(editing && isCursor && isOther)
      ) {
        appendWrapped(lines, '        ', '        ', option.description, renderWidth, dim);
      }
      zones.push({
        id: `option:${String(i)}`,
        row: optionTop,
        col: 1,
        width,
        height: lines.length - optionTop,
        // While the Other input is armed the options don't hover (presses
        // still retarget, matching the pre-zone hit-test).
        ...(editing ? { semantics: { hover: false } } : {}),
      });
    }

    // Hover underline: every text row of the hovered option (mouse motion) —
    // the whole option range is clickable, so all of its rows underline.
    const hoveredOption = this.hoverKeyIndex('option:');
    if (hoveredOption !== null) {
      const zone = zones.find((z) => z.id === `option:${String(hoveredOption)}`);
      if (zone !== undefined) {
        for (let row = zone.row; row < zone.row + zone.height; row++) {
          const line = lines[row];
          if (line !== undefined) lines[row] = underlineText(line, true);
        }
      }
    }

    if (visibleEnd < options.length || visibleStart > 0) {
      lines.push(
        dim(
          t('dialogs.question.showingRange', {
            from: visibleStart + 1,
            to: visibleEnd,
            total: options.length,
          }),
        ),
      );
    }

    lines.push('');
    for (const hintLine of this.buildQuestionHint(dim, questionIdx, renderWidth)) {
      lines.push(hintLine);
    }
    return { lines, zones };
  }

  /**
   * The content region of the submit tab: the tab strip, the review block,
   * the Submit/Cancel action rows, and the key hints. Returns the lines plus
   * the content-relative hit zones (row 0 = the tab strip; one zone per tab
   * cell and per action row).
   */
  private renderSubmitContent(width: number): { lines: string[]; zones: HitZone[] } {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const text = (t: string) => currentTheme.fg('text', t);
    const warning = (text: string) => currentTheme.fg('warning', text);

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const zones: HitZone[] = [];
    this.pushTabs(lines, zones);
    lines.push('');
    lines.push(currentTheme.boldFg('text', ` ${t('dialogs.question.reviewTitle')}`));
    const reviewWarning =
      this.reviewMessage ??
      (this.hasUnansweredQuestions() ? t('dialogs.question.unansweredWarning') : undefined);
    if (reviewWarning !== undefined) {
      lines.push(warning(`  ${reviewWarning}`));
    }
    lines.push('');

    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      const answer = this.answers[i];
      appendWrapped(
        lines,
        `  ${dim(t('dialogs.question.questionMarker'))}  `,
        '       ',
        question.question,
        renderWidth,
      );
      if (answer !== undefined && answer.length > 0) {
        appendWrapped(
          lines,
          `  ${accent('→')}  `,
          '       ',
          text(answer),
          renderWidth,
        );
      } else {
        lines.push(`  ${dim('→')}  ${dim(t('dialogs.question.notAnswered'))}`);
      }
    }

    lines.push('');
    lines.push(text(` ${t('dialogs.question.submitPrompt')}`));
    lines.push('');

    const hoveredAction = this.hoverKeyIndex('submit:');
    for (let i = 0; i < SUBMIT_ACTION_KEYS.length; i++) {
      const actionKey = SUBMIT_ACTION_KEYS[i];
      if (actionKey === undefined) continue;
      const label = t(actionKey);
      const num = i + 1;
      zones.push({ id: `submit:${String(i)}`, row: lines.length, col: 1, width, height: 1 });
      if (i === this.submitActionIdx) {
        lines.push(underlineText(accent(`  → [${String(num)}] ${label}`), i === hoveredAction));
      } else {
        lines.push(underlineText(dim(`    [${String(num)}] ${label}`), i === hoveredAction));
      }
    }

    lines.push('');
    for (const hintLine of this.buildSubmitHint(dim, renderWidth)) {
      lines.push(hintLine);
    }
    return { lines, zones };
  }

  /**
   * The tab strip: one cell per question (✓/○ answer status) plus the submit
   * cell, rendered as the first content line, plus one `tab:N` zone per cell
   * (content-relative row 0). Cells are built unstyled first: their visible
   * widths feed the zone columns, then styling (+ hover underline) is applied
   * per cell.
   */
  private pushTabs(lines: string[], zones: HitZone[]): void {
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const active = (text: string) =>
      currentTheme.bg('primary', currentTheme.boldFg('text', text));

    const cells: { plain: string; tabIndex: number }[] = [];
    for (let i = 0; i < this.request.data.questions.length; i++) {
      const question = this.request.data.questions[i];
      if (question === undefined) continue;
      const label =
        question.header !== undefined && question.header.length > 0
          ? question.header
          : `Q${String(i + 1)}`;
      if (i === this.currentTab) cells.push({ plain: ` ${label} `, tabIndex: i });
      else if (this.isAnswered(i)) cells.push({ plain: `(✓) ${label}`, tabIndex: i });
      else cells.push({ plain: `(○) ${label}`, tabIndex: i });
    }

    const submitLabel = t('dialogs.question.submit');
    cells.push({ plain: ` ${submitLabel} `, tabIndex: this.submitTabIndex() });

    const tabs: string[] = [];
    let nextCol = 2; // the rendered line starts with one space (1-based col 2)
    for (const cell of cells) {
      const cellWidth = visibleWidth(cell.plain);
      zones.push({ id: `tab:${String(cell.tabIndex)}`, row: 0, col: nextCol, width: cellWidth, height: 1 });
      nextCol += cellWidth + 2; // cells join with two spaces
      const isActive = cell.tabIndex === this.currentTab;
      const styled = isActive
        ? active(cell.plain)
        : cell.tabIndex < this.request.data.questions.length && this.isAnswered(cell.tabIndex)
          ? currentTheme.fg('success', cell.plain)
          : dim(cell.plain);
      tabs.push(underlineText(styled, this.hover.isHovered(`tab:${String(cell.tabIndex)}`)));
    }

    lines.push(` ${tabs.join('  ')}`);
  }

  /** Numeric suffix of the current hover key within one namespace. */
  private hoverKeyIndex(prefix: string): number | null {
    const key = this.hover.index;
    if (key === null || !key.startsWith(prefix)) return null;
    const idx = Number(key.slice(prefix.length));
    return Number.isInteger(idx) ? idx : null;
  }

  private buildQuestionHint(dim: (s: string) => string, questionIdx: number, width: number): string[] {
    const wrap = (parts: readonly string[]): string[] =>
      wrapHint(parts, Math.max(1, width - 2), '  ').map((line) => dim(`  ${line}`));
    if (this.isEditingOther()) {
      const parts: string[] = [
        t('dialogs.question.hint.typeAnswer'),
        t('dialogs.question.hint.save'),
        ...(this.totalTabs() > 1 ? [t('dialogs.question.hint.tabSwitch')] : []),
        t('dialogs.question.hint.escCancel'),
      ];
      return wrap(parts);
    }

    const optionCount = Math.min(this.displayOptions(questionIdx).length, NUMBER_KEYS.length);
    const numberHint = optionCount <= 1 ? '1' : `1-${String(optionCount)}`;
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return wrap([t('dialogs.question.hint.escCancel')]);

    const parts: string[] = [
      t('dialogs.question.hint.select'),
      question.multi_select
        ? t('dialogs.question.hint.numberToggle', { n: numberHint })
        : t('dialogs.question.hint.numberChoose', { n: numberHint }),
    ];
    if (this.totalTabs() > 1) parts.push(t('dialogs.question.hint.arrowTabSwitch'));
    parts.push(t('dialogs.question.hint.escCancel'));
    return wrap(parts);
  }

  private buildSubmitHint(dim: (s: string) => string, width: number): string[] {
    const parts: string[] = [
      t('dialogs.question.hint.select'),
      t('dialogs.question.hint.chooseOneTwo'),
      t('dialogs.question.hint.confirm'),
    ];
    if (this.totalTabs() > 1) parts.push(t('dialogs.question.hint.arrowTabSwitch'));
    parts.push(t('dialogs.question.hint.escCancel'));
    return wrapHint(parts, Math.max(1, width - 2), '  ').map((line) => dim(`  ${line}`));
  }

  private computeVisibleStart(cursor: number, total: number): number {
    if (total <= this.maxVisibleOptions) return 0;
    const half = Math.floor(this.maxVisibleOptions / 2);
    const max = Math.max(0, total - this.maxVisibleOptions);
    return Math.max(0, Math.min(cursor - half, max));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private totalTabs(): number {
    return this.request.data.questions.length + 1;
  }

  private submitTabIndex(): number {
    return this.request.data.questions.length;
  }

  private isSubmitTab(): boolean {
    return this.currentTab === this.submitTabIndex();
  }

  private isEditingOther(): boolean {
    return this.editingOther && !this.isSubmitTab();
  }

  private currentQuestionIndex(): number | undefined {
    return this.isSubmitTab() ? undefined : this.currentTab;
  }

  private currentCursor(): number {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return 0;
    return this.cursors[questionIdx] ?? 0;
  }

  private displayOptions(questionIdx: number): DisplayOption[] {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return [];

    return [
      ...question.options.map((option) => ({
        label: option.label,
        description: option.description,
        kind: 'preset' as const,
      })),
      {
        label: question.other_label?.length ? question.other_label : t('dialogs.question.other'),
        description: question.other_description?.length ? question.other_description : undefined,
        kind: 'other' as const,
      },
    ];
  }

  private otherOptionIndex(questionIdx: number): number {
    return this.request.data.questions[questionIdx]?.options.length ?? 0;
  }

  private isOtherOption(questionIdx: number, optionIdx: number): boolean {
    return optionIdx === this.otherOptionIndex(questionIdx);
  }

  private renderOptionLabel(questionIdx: number, option: DisplayOption, isCursor: boolean): string {
    if (option.kind !== 'other') return option.label;

    const value = this.otherDraftValue(questionIdx);
    if (this.isEditingOther() && isCursor) {
      return `${option.label}: ${value ?? ''}█`;
    }
    if (value !== undefined && value.length > 0) return `${option.label}: ${value}`;
    return option.label;
  }

  private renderEditingOtherLine(
    width: number,
    questionIdx: number,
    option: DisplayOption,
    num: number,
    isSelected: boolean,
  ): string {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return option.label;

    let prefix: string;
    if (question.multi_select) {
      const checked = isSelected ? '✓' : ' ';
      const body = `  [${checked}] ${option.label}: `;
      prefix = isSelected
        ? currentTheme.boldFg('success', body)
        : currentTheme.fg('primary', body);
    } else {
      const body = `  → [${String(num)}] ${option.label}: `;
      prefix =
        isSelected && this.isAnswered(questionIdx)
          ? currentTheme.boldFg('success', body)
          : currentTheme.fg('primary', body);
    }

    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.otherInput.render(inputWidth)[0] ?? '❯ ';
    const inlineInput = inputLine.startsWith('❯ ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
  }

  private otherDraftValue(questionIdx: number): string {
    return (this.otherDrafts[questionIdx] ?? this.committedOtherValues[questionIdx]) ?? '';
  }

  private syncOtherDraft(questionIdx: number): void {
    this.otherDrafts[questionIdx] = this.otherInput.getValue();
  }

  private isAnswered(questionIdx: number): boolean {
    const answer = this.answers[questionIdx];
    return answer !== undefined && answer.length > 0;
  }

  private hasUnansweredQuestions(): boolean {
    for (let i = 0; i < this.request.data.questions.length; i++) {
      if (!this.isAnswered(i)) return true;
    }
    return false;
  }

  override invalidate(): void {
    super.invalidate();
    this.otherInput.invalidate();
  }
}
