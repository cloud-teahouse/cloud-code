import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';
import type { ExperimentalFeatureState } from '@cloud-code/sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList, type SearchableListView } from '#/tui/utils/searchable-list';

import { DIALOG_SEARCH_ZONE, DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

const ELLIPSIS = '…';

export interface ExperimentalFeatureDraftChange {
  readonly id: ExperimentalFeatureState['id'];
  readonly enabled: boolean;
}

export interface ExperimentsSelectorOptions {
  readonly features: readonly ExperimentalFeatureState[];
  readonly onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => void;
  readonly onCancel: () => void;
}

/** Zone id of the Apply button row (feature rows use their item index). */
const APPLY_ZONE = 'apply';

export class ExperimentsSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: ExperimentsSelectorOptions;
  private readonly list: SearchableList<ExperimentalFeatureState>;
  private readonly draft = new Map<ExperimentalFeatureState['id'], boolean>();
  /** The dialog skeleton owning the chrome (divider/title/hint/search box)
   * and its row math. */
  private readonly frame = new DialogFrame({ titleIndent: ' ', minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (search box, feature rows,
   * Apply button) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /**
   * Hovered interactive element (mouse motion): a feature row hovers its item
   * index; the Apply button hovers APPLY_ZONE; null elsewhere.
   */
  private readonly hover = new HoverState<HitZoneId>();

  constructor(opts: ExperimentsSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.features,
      toSearchText: (feature) => `${feature.title} ${feature.id} ${feature.description}`,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.frame.handleEscape(this.list, this.opts.onCancel);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const changes = this.draftChanges();
      if (changes.length > 0) this.opts.onApply(changes);
      return;
    }
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      // While the search box is focused Space is a query character, like in
      // every other searchable dialog; the toggle applies with the list
      // focused only.
      if (!this.list.view().searchFocused) {
        const selected = this.list.selected();
        if (selected !== undefined) this.toggleDraft(selected);
        return;
      }
    }
    this.list.handleKey(data);
  }

  /** Mouse: the wheel moves the cursor one row per tick, clamped by
   * SearchableList exactly like ↑/↓. Press and hover targeting is declared as
   * hit zones (see renderContent); the TUI dispatches zone presses to
   * {@link onHitZone} and tracks the hovered zone via {@link setHoveredZone}.
   * This handler keeps the wheel behavior and routes presses/motion arriving
   * outside the zone dispatch (e.g. direct component-relative events) through
   * the same zones. */
  handleMouse(event: MouseEvent): void | boolean {
    // Re-derived from the current state: direct callers (unit tests) may fire
    // keys without an intervening render, so the render cache can be stale.
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
    if (event.type !== 'wheel') return false;
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.list.view().items.length === 0) return false;
    if (delta < 0) this.list.moveUp();
    else this.list.moveDown();
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
   * Zone press: the search box selects it (the mouse counterpart of `/`); a
   * feature row moves the cursor onto it and toggles its draft (checkbox
   * semantics — Space in one gesture); the Apply button applies the pending
   * changes.
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      this.list.focusSearch();
      this.invalidate();
      return;
    }
    if (id === APPLY_ZONE) {
      const changes = this.draftChanges();
      if (changes.length > 0) this.opts.onApply(changes);
      return;
    }
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    this.list.selectIndex(hit);
    const feature = view.items[hit];
    if (feature !== undefined) this.toggleDraft(feature);
    this.invalidate();
  }

  /** Zone hover: the hovered feature row / Apply button underlines. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  /** Key-hint segments for the current view (paging, query, search state). */
  private hintParts(view: SearchableListView<ExperimentalFeatureState>): string[] {
    const hintParts = [t('common.hint.navigate')];
    if (view.page.pageCount > 1) hintParts.push(t('selectors.experiments.hintPage'));
    hintParts.push(
      t('selectors.experiments.hintToggle'),
      t('selectors.experiments.hintApply'),
    );
    if (view.query.length > 0) hintParts.push(t('dialogs.hint.backspaceClear'));
    // The focused search box swaps the cancel segment for the Esc-exit; the
    // unfocused box advertises the `/` focus key.
    if (view.searchFocused) {
      hintParts.push(t('common.hint.searchExit'));
    } else {
      hintParts.push(t('common.hint.searchFocus'), t('common.hint.cancel'));
    }
    return hintParts;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const view = this.list.view();
    const { lines, zones } = this.renderContent(width, view);
    const frameLines = this.frame.render(width, {
      title: t('selectors.experiments.title'),
      hintParts: this.hintParts(view),
      search: { query: view.query, focused: view.searchFocused },
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  /**
   * The content region (everything between the search box and the closing
   * divider): the feature rows, a blank, the optional match/more indicator,
   * and the Apply button. Returns the lines plus the content-relative hit
   * zones (row 0 = first content line): one zone per feature spanning its
   * label, detail, and description rows, plus the Apply button — declared
   * only while it is actionable (a disabled button has no hover/press
   * affordance).
   */
  private renderContent(
    width: number,
    view: SearchableListView<ExperimentalFeatureState>,
  ): { lines: string[]; zones: HitZone[] } {
    const lines: string[] = [];
    const zones: HitZone[] = [];

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', `   ${t('common.noMatches')}`));
    }

    for (let i = view.page.start; i < view.page.end; i++) {
      const feature = view.items[i]!;
      const rowStart = lines.length;
      const featureLines = this.renderFeature(feature, i === view.selectedIndex, width);
      // Hover underline on the feature's label row (mouse motion).
      if (this.hover.isHovered(i) && featureLines.length > 0) {
        featureLines[0] = underlineText(featureLines[0]!, true);
      }
      lines.push(...featureLines);
      zones.push({ id: i, row: rowStart, col: 1, width, height: lines.length - rowStart });
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${String(view.items.length)} / ${String(this.opts.features.length)}`,
        ),
      );
    } else if (view.page.end < view.items.length) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          t('dialogs.model.more', { count: view.items.length - view.page.end }),
        ),
      );
    }
    const applyRow = lines.length;
    lines.push(this.renderApplyButton());
    if (this.draftChanges().length > 0) {
      zones.push({ id: APPLY_ZONE, row: applyRow, col: 1, width, height: 1 });
    }
    return { lines, zones };
  }

  private toggleDraft(feature: ExperimentalFeatureState): void {
    if (isLocked(feature)) return;

    const enabled = !this.effectiveEnabled(feature);
    if (enabled === feature.enabled) {
      this.draft.delete(feature.id);
      return;
    }
    this.draft.set(feature.id, enabled);
  }

  private effectiveEnabled(feature: ExperimentalFeatureState): boolean {
    return this.draft.get(feature.id) ?? feature.enabled;
  }

  private isDraftChanged(feature: ExperimentalFeatureState): boolean {
    return this.effectiveEnabled(feature) !== feature.enabled;
  }

  private draftChanges(): ExperimentalFeatureDraftChange[] {
    const changes: ExperimentalFeatureDraftChange[] = [];
    for (const feature of this.opts.features) {
      if (this.isDraftChanged(feature)) {
        changes.push({ id: feature.id, enabled: this.effectiveEnabled(feature) });
      }
    }
    return changes;
  }

  private renderApplyButton(): string {
    const changes = this.draftChanges();
    const count = changes.length;
    const label = t('selectors.experiments.apply');
    const summary =
      count === 0
        ? t('selectors.experiments.noChanges')
        : t(
            count === 1 ? 'selectors.experiments.change.one' : 'selectors.experiments.change.other',
            { count },
          );
    const button = count === 0
      ? currentTheme.fg('textDim', label)
      : currentTheme.boldFg('primary', label);
    const summaryText = count === 0
      ? currentTheme.fg('textMuted', summary)
      : currentTheme.fg('success', summary);
    return underlineText(
      ` ${button}  ${summaryText}`,
      count > 0 && this.hover.isHovered(APPLY_ZONE),
    );
  }

  private renderFeature(
    feature: ExperimentalFeatureState,
    selected: boolean,
    width: number,
  ): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected ? currentTheme.boldFg('primary', feature.title) : currentTheme.fg('text', feature.title);
    const enabled = this.effectiveEnabled(feature);
    const status = enabled ? t('selectors.experiments.enabled') : t('selectors.experiments.disabled');
    const statusText = enabled ? currentTheme.fg('success', status) : currentTheme.fg('textDim', status);
    const detail = this.isDraftChanged(feature)
      ? `${featureDetail(feature)} · ${t('selectors.experiments.modified')}`
      : featureDetail(feature);
    const lines = [
      `${prefix}${label}  ${statusText}`,
      currentTheme.fg('textMuted', `    ${detail}`),
    ];
    const descriptionWidth = Math.max(1, width - 4);
    for (const line of wrapText(feature.description, descriptionWidth)) {
      lines.push(currentTheme.fg('textMuted', `    ${line}`));
    }
    return lines;
  }
}

function isLocked(feature: ExperimentalFeatureState): boolean {
  return feature.source === 'env' || feature.source === 'master-env';
}

function featureDetail(feature: ExperimentalFeatureState): string {
  const source = sourceLabel(feature);
  if (feature.source === 'env' || feature.source === 'master-env') {
    return `id ${feature.id} · ${source}`;
  }
  return `id ${feature.id} · ${source} · ${feature.env}`;
}

function sourceLabel(feature: ExperimentalFeatureState): string {
  switch (feature.source) {
    case 'master-env':
      return t('selectors.experiments.lockedByMasterEnv');
    case 'env':
      return t('selectors.experiments.lockedByEnv', { env: feature.env });
    case 'config':
      return t('selectors.experiments.sourceConfig');
    case 'default':
      return t('selectors.experiments.sourceDefault');
  }
}

function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
