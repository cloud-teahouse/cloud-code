/**
 * TabbedModelSelectorComponent — a thin wrapper around ModelSelectorComponent
 * that splits the model list into per-provider tabs.
 *
 * Tabs are derived from the `models` passed at construction time:
 *   ['all', ...uniqueProviderIds]   (insertion order, deduplicated)
 *
 * Each tab owns its own inner ModelSelectorComponent built from the filtered
 * subset of models. ↑/↓/Enter/Esc/←/→ (thinking) and typing (filter) are
 * forwarded to the active inner selector; Tab / Shift-Tab cycle between tabs.
 *
 * The active tab is highlighted with a filled background (matching the
 * AskUserQuestion dialog's tab strip) — see docs/tui-design.md §6.
 *
 * Rendering composes the active tab's header and content region through a
 * DialogFrame with the tab strip between them; mouse targeting is declared
 * as hit zones (tab cells plus the inner selector's content zones), so no
 * row-offset math survives from the splice-based layout.
 */

import type { ModelAlias } from '@cloud-code/sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { HoverState } from '#/tui/utils/mouse-hover';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';
import {
  ModelSelectorComponent,
  providerDisplayName,
  type ModelManageOptions,
  type ModelSelection,
  type ModelSelectorOptions,
  type ModelSubagentOptions,
} from './model-selector';

const ALL_TAB_ID = 'all';

export interface TabbedModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingEffort: string;
  /** Forwarded to each inner selector; overrides the default model-picker
   * title line (e.g. the secondary-model picker). */
  readonly title?: string;
  /** When set, the tab for this provider id is initially active instead of the
   * tab derived from `currentValue`. */
  readonly initialTabId?: string;
  /** Forwarded to each inner selector; when set, warning-colored lines are
   * rendered directly below the key-hint line, wrapping as needed (e.g. the
   * mid-conversation switch cost notice). */
  readonly warning?: string;
  readonly onSelect: (selection: ModelSelection) => void;
  /** Forwarded to each inner selector; when set, Alt+S applies the choice to
   * the current session only without persisting it as the default. */
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  /** When set, the "All" tab's inner selector appends an "Add custom model"
   * action row that invokes this (per-provider tabs don't repeat it). */
  readonly onAddCustom?: () => void;
  /** Custom-model manage actions (badge + Alt+E/Alt+D), forwarded to every
   * tab's inner selector. */
  readonly manage?: ModelManageOptions;
  /** Subagent-default assignment (badge + Alt+A), forwarded to every tab's
   * inner selector. */
  readonly subagent?: ModelSubagentOptions;
  readonly onCancel: () => void;
}

interface ModelTab {
  readonly id: string;
  readonly label: string;
  readonly selector: ModelSelectorComponent;
}

export class TabbedModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TabbedModelSelectorOptions;
  private tabs: readonly ModelTab[];
  private activeIndex: number;
  /** The dialog skeleton composing the active tab's header and content
   * region around the tab strip; owns the row math. */
  private readonly frame = new DialogFrame({ minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (tab cells + the active
   * tab's content zones) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Hovered tab index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width. */
  private lastRenderWidth = 80;

  constructor(opts: TabbedModelSelectorOptions) {
    super();
    this.opts = opts;
    this.tabs = buildTabs(opts);

    // Default to the "All" tab. Only an explicit initialTabId (e.g. the
    // provider just added via /provider) opens on a specific provider tab —
    // the current model is still highlighted inside whichever tab is active.
    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.syncFocusToActive();
  }

  handleInput(data: string): void {
    const normalized = normalizeLegacyMetaKey(data);
    if (this.tabs.length > 1) {
      if (matchesKey(normalized, Key.tab)) {
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
      if (matchesKey(normalized, Key.shift('tab'))) {
        this.activeIndex = (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
    }
    this.tabs[this.activeIndex]?.selector.handleInput(normalized);
  }

  /** Mouse: wheel events are row-independent and forward to the active tab's
   * inner selector, which owns the list cursor. Press and hover targeting is
   * declared as hit zones (tab cells + the active tab's content zones — see
   * render); the TUI dispatches zone presses to {@link onHitZone} and tracks
   * the hovered zone via {@link setHoveredZone}. This handler keeps the wheel
   * forwarding and routes presses/motion arriving outside the zone dispatch
   * (e.g. direct component-relative events) through the same zones. */
  handleMouse(event: MouseEvent): void | boolean {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return false;
    if (event.type === 'wheel') {
      active.selector.handleMouse(event);
      return;
    }
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
    return false;
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

  /** Zone press: a tab cell switches tabs; anything else is the active tab's
   * content zone and forwards to its inner selector. */
  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return false;
    if (typeof id === 'string' && id.startsWith('tab:')) {
      const idx = Number(id.slice('tab:'.length));
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.tabs.length || idx === this.activeIndex) {
        return false;
      }
      this.activeIndex = idx;
      this.hover.update(null);
      this.syncFocusToActive();
      this.invalidate();
      return;
    }
    return active.selector.onHitZone(id, event);
  }

  /** Zone hover: a tab cell underlines the tab (the inner list shows no
   * hover then); anything else forwards as the inner list's hover. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return false;
    let changed: boolean;
    if (typeof id === 'string' && id.startsWith('tab:')) {
      const idx = Number(id.slice('tab:'.length));
      changed = this.hover.update(Number.isInteger(idx) ? idx : null);
      if (active.selector.setHoveredZone(null) !== false) changed = true;
    } else {
      changed = this.hover.update(null);
      if (active.selector.setHoveredZone(id) !== false) changed = true;
    }
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return [];
    if (this.tabs.length <= 1) {
      const inner = active.selector.render(width);
      this.frameZones = [...active.selector.hitZones()];
      return inner.map((line) => truncateToWidth(line, width));
    }
    // Layout: divider, title, hint, optional warning, blank, tab strip,
    // blank, search box, then the active tab's content region — the inner
    // selector supplies the header contents (hint parts, warning) and the
    // content lines with their content-relative zones; the frame owns the
    // composition and the row math.
    const view = active.selector.view();
    const { lines, zones } = active.selector.renderContent(width);
    const frameLines = this.frame.render(width, {
      title: this.opts.title ?? t('dialogs.model.title'),
      hintParts: active.selector.hintParts(view),
      ...(this.opts.warning !== undefined
        ? { notice: { text: this.opts.warning, tone: 'warning' as const, wrap: 'ansi' as const } }
        : {}),
      tabStrip: {
        labels: this.tabs.map((tab) => tab.label),
        activeIndex: this.activeIndex,
        hoverIndex: this.hover.index,
      },
      search: {
        query: view.query,
        focused: view.searchFocused,
        zone: !active.selector.mouseSuppressed,
      },
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * Live-replaces the model set (a background provider refresh landed). Tabs
   * for surviving providers update their rows in place — preserving each
   * tab's query/cursor — while new providers gain a tab and vanished ones
   * drop out. The active tab survives by id; otherwise the view falls back
   * to the "All" tab.
   */
  updateModels(models: Record<string, ModelAlias>): void {
    const activeTabId = this.tabs[this.activeIndex]?.id;
    const entries = Object.entries(models);
    const providerIds: string[] = [];
    const seen = new Set<string>();
    for (const [, model] of entries) {
      if (!seen.has(model.provider)) {
        seen.add(model.provider);
        providerIds.push(model.provider);
      }
    }

    const existing = new Map(this.tabs.map((tab) => [tab.id, tab]));
    const tabs: ModelTab[] = [];
    const adopt = (id: string, label: string, subset: Record<string, ModelAlias>, isAllTab: boolean): void => {
      const tab = existing.get(id);
      if (tab !== undefined) {
        tab.selector.updateModels(subset);
        tabs.push(tab);
      } else {
        tabs.push({ id, label, selector: makeSelector(this.opts, subset, isAllTab) });
      }
    };
    adopt(ALL_TAB_ID, t('selectors.modelTabs.all'), models, true);
    for (const providerId of providerIds) {
      const subset: Record<string, ModelAlias> = {};
      for (const [alias, model] of entries) {
        if (model.provider === providerId) subset[alias] = model;
      }
      adopt(providerId, providerDisplayName(providerId), subset, false);
    }

    this.tabs = tabs;
    this.activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
    this.syncFocusToActive();
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    for (const tab of this.tabs) {
      tab.selector.invalidate();
    }
  }

  private syncFocusToActive(): void {
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      tab.selector.focused = this.focused && i === this.activeIndex;
    }
  }
}

function buildTabs(opts: TabbedModelSelectorOptions): readonly ModelTab[] {
  const entries = Object.entries(opts.models);
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const [, model] of entries) {
    const provider = model.provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      providerIds.push(provider);
    }
  }

  const tabs: ModelTab[] = [
    {
      id: ALL_TAB_ID,
      label: t('selectors.modelTabs.all'),
      selector: makeSelector(opts, opts.models, true),
    },
  ];
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      selector: makeSelector(opts, subset, false),
    });
  }
  return tabs;
}

function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
  isAllTab: boolean,
): ModelSelectorComponent {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  const inner: ModelSelectorOptions = {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinkingEffort: opts.currentThinkingEffort,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    searchable: true,
    providerSwitchHint: true,
    warning: opts.warning,
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    ...(isAllTab && opts.onAddCustom !== undefined ? { onAddCustom: opts.onAddCustom } : {}),
    ...(opts.manage !== undefined ? { manage: opts.manage } : {}),
    ...(opts.subagent !== undefined ? { subagent: opts.subagent } : {}),
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}
