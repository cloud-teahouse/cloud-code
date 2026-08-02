import { effectiveModelAlias, type ModelAlias, type ThinkingEffort } from '@cloud-code/sdk';
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

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList, type SearchableListView } from '#/tui/utils/searchable-list';

import type { ChoiceOption } from './choice-picker';
import { DIALOG_SEARCH_ZONE, DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  /** Model display name (left column). */
  readonly name: string;
  /** Provider display name (right column). */
  readonly provider: string;
  /** Combined text the fuzzy filter matches against (name + provider). */
  readonly label: string;
}

/** One clickable cell of the thinking-effort control (see renderThinkingControl). */
interface ThinkingSegment {
  /** Unstyled cell text, padding included; its width drives the hit layout. */
  readonly text: string;
  /** Effort applied when the cell is clicked; null = greyed-out, not clickable. */
  readonly effort: string | null;
  /** Whether the cell renders as the active (bracketed) segment. */
  readonly active: boolean;
}

interface ThinkingControlLayout {
  readonly segments: readonly ThinkingSegment[];
  /** Spaces between adjacent cells (1 for the legacy On/Off pair, 2 otherwise). */
  readonly gap: number;
}

export interface ModelSelection {
  readonly alias: string;
  /** Chosen thinking effort: 'off', or a concrete effort such as 'low' /
   * 'high' / 'max'. Boolean 'on' is normalized to the model's default effort
   * before the selection is committed (see commitEffort). */
  readonly thinking: ThinkingEffort;
}

/**
 * Custom-model manage actions for the /model picker. When provided, custom
 * rows carry a `[custom]` badge and Alt+E / Alt+D act on the highlighted row
 * (bare letters would collide with the fuzzy search, hence the Alt modifier,
 * mirroring Alt+S session-only). Deletes confirm inline with a `[y/N]`
 * prompt plus host-computed impact lines (provider-manager pattern).
 */
export interface ModelManageOptions {
  /** Classify an alias; custom rows are editable/deletable. */
  readonly isCustom: (alias: string) => boolean;
  /** Alt+E on a custom row. */
  readonly onEdit: (alias: string) => void;
  /** Fires after the inline [y/N] delete confirmation. */
  readonly onDelete: (alias: string) => void;
  /** Alt+E / Alt+D on a non-custom row — the host shows the guard message. */
  readonly onGuard: (alias: string) => void;
  /** Impact lines rendered under the delete confirmation. */
  readonly deleteImpact?: (alias: string) => readonly string[];
}

/**
 * Subagent-default assignment for the /model picker. When provided, the row
 * matching the current `[secondary_model]` alias carries a `← subagent`
 * badge and Alt+A assigns the highlighted row (with its draft thinking
 * effort) as the subagent default — or clears it when the highlighted row
 * already is the default, so subagents follow the main model again.
 */
export interface ModelSubagentOptions {
  /** Lazy: the current `[secondary_model]` assignment; undefined = subagents
   * follow the main model. Read at render/key time so a late config load
   * repaints the badge without rebuilding the picker. */
  readonly current: () => { readonly alias: string; readonly effort?: string } | undefined;
  /** Alt+A on a model row: assign (selection, effort committed) or clear
   * (undefined — toggled on the row that is already the subagent default). */
  readonly onAssign: (selection: ModelSelection | undefined) => void;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? alias;
}

/**
 * Service-real-name exceptions: these two provider ids are actual services,
 * so the UI shows the service's proper name rather than the raw config id.
 * Every other id renders as configured.
 */
const PROVIDER_SERVICE_NAMES: Readonly<Record<string, string>> = {
  kimi: 'Kimi Code',
  'chatgpt-codex': 'ChatGPT Codex',
};

/**
 * The proper service name for a bare provider id, or undefined when the id
 * has no service-name exception and renders as configured. Shared with the
 * provider manager so a source row labels the same provider identically.
 */
export function providerServiceName(provider: string): string | undefined {
  return PROVIDER_SERVICE_NAMES[provider];
}

export function providerDisplayName(provider: string): string {
  // The built-in OAuth provider is the Kimi Code service.
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PROVIDER_SERVICE_NAMES['kimi']!;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return providerServiceName(provider) ?? provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    return {
      value: alias,
      label: `${modelDisplayName(alias, effective)} (${providerDisplayName(effective.provider)})`,
    };
  });
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  /** Live thinking effort of the currently active model (e.g. 'off', 'on',
   * 'high'). Used to highlight the active segment for the current model. */
  readonly currentThinkingEffort: ThinkingEffort;
  /** Overrides the default model-picker title line (e.g. the secondary-model picker). */
  readonly title?: string;
  /** When true, typed characters filter the list (fuzzy) and the focusable
   * search box is shown (`/` focuses, Esc clears → unfocuses → cancels). */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  /** When true, the hint line mentions the Tab provider switch — set by
   * TabbedModelSelectorComponent so the inner list advertises the tab keys. */
  readonly providerSwitchHint?: boolean;
  /** When set, rendered as warning-colored lines directly below the key-hint
   * line; wraps instead of truncating when it exceeds the width (e.g. the
   * mid-conversation switch cost notice). */
  readonly warning?: string;
  readonly onSelect: (selection: ModelSelection) => void;
  /** When provided, Alt+S invokes this instead of onSelect — used to apply the
   * choice to the current session only, without persisting it as the default. */
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  /** When provided, a synthetic "Add custom model" action row is appended to
   * the list; confirming it invokes this instead of onSelect (mirrors the
   * provider manager's "[ Add New Platform ]" row). */
  readonly onAddCustom?: () => void;
  /** Custom-model manage actions (badge + Alt+E/Alt+D) — set by /model. */
  readonly manage?: ModelManageOptions;
  /** Subagent-default assignment (badge + Alt+A) — set by /model. */
  readonly subagent?: ModelSubagentOptions;
  readonly onCancel: () => void;
}

/** Alias of the synthetic "Add custom model" row (never a real config key). */
export const ADD_CUSTOM_MODEL_ALIAS = '__add_custom_model__';

const ADD_CUSTOM_SENTINEL_MODEL: ModelAlias = { provider: '', model: '', maxContextSize: 1 };

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    const name = modelDisplayName(alias, effective);
    const provider = providerDisplayName(effective.provider);
    return { alias, model: effective, name, provider, label: `${name} (${provider})` };
  });
}

export function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

export function effortsOf(model: ModelAlias): readonly string[] {
  return model.supportEfforts ?? [];
}

/**
 * Ordered list of selectable thinking efforts for a model. Effort-capable models
 * expose their declared efforts (with an 'off' entry when the model is not
 * always-on); legacy boolean models expose 'on'/'off'; single-segment lists
 * mean the control is effectively locked.
 */
export function segmentsFor(model: ModelAlias): readonly string[] {
  const efforts = effortsOf(model);
  const availability = thinkingAvailability(model);
  if (efforts.length > 0) {
    return availability === 'always-on' ? efforts : ['off', ...efforts];
  }
  if (availability === 'always-on') return ['on'];
  if (availability === 'unsupported') return ['off'];
  return ['on', 'off'];
}

export function effortLabel(effort: string): string {
  if (effort.length === 0) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Default thinking effort for a model: declared `default_effort`, else the
 * middle `support_efforts` entry, else `'on'` for boolean models, `'off'` when
 * thinking is unsupported.
 */
function defaultThinkingEffortFor(model: ModelAlias): ThinkingEffort {
  if (thinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = effortsOf(model);
  if (efforts.length > 0) {
    return model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * Normalize a draft effort before committing a selection. A boolean `'on'`
 * never leaks past the UI boundary — it becomes the model's default effort
 * (a concrete effort for effort-capable models, `'on'` only for genuine
 * boolean models).
 */
function commitEffort(choice: ModelChoice, draft: ThinkingEffort): ThinkingEffort {
  if (draft === 'on') return defaultThinkingEffortFor(choice.model);
  return draft;
}

/**
 * Flat, searchable single-list model picker.
 *
 * One navigation axis: ↑/↓ move the cursor (PgUp/PgDn page), typing fuzzy-filters
 * across every provider (provider name included), and ←/→ toggle the thinking
 * draft for models that support it. There are no provider tabs — filtering by
 * typing a provider name replaces them. See docs/tui-design.md.
 */
export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  /** Live model set; replaced by updateModels when a background refresh lands. */
  private models: Record<string, ModelAlias>;
  /** Per-model thinking-effort override set by ←/→; absent → the default. */
  private readonly thinkingOverrides = new Map<string, string>();
  /** The dialog skeleton owning the chrome (divider/title/hint/warning/
   * search box) and its row math. */
  private readonly frame = new DialogFrame({ minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (search box, model rows,
   * thinking segments) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Armed inline delete confirmation (alias), provider-manager style. */
  private confirmDelete: string | undefined;
  /**
   * Hovered interactive element: a zone id — a model row's item index
   * (number) or a thinking segment's `thinking:<effort>` key; null when the
   * pointer is elsewhere.
   */
  private readonly hover = new HoverState<HitZoneId>();

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    this.models = opts.models;
    const choices = this.buildChoices();
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  /** Model rows plus the synthetic add-custom CTA when the host opted in. */
  private buildChoices(): ModelChoice[] {
    const choices = [...createModelChoices(this.models)];
    if (this.opts.onAddCustom !== undefined) {
      const name = t('dialogs.model.addCustom');
      choices.push({
        alias: ADD_CUSTOM_MODEL_ALIAS,
        model: ADD_CUSTOM_SENTINEL_MODEL,
        name,
        provider: '',
        label: name,
      });
    }
    return choices;
  }

  /**
   * Live-replaces the model set (a background provider refresh landed) while
   * preserving the query, the cursor (it follows the selected alias),
   * thinking-effort overrides, and an armed delete confirmation whose alias
   * survived. Rows for vanished aliases disappear; new aliases append in
   * config order.
   */
  updateModels(models: Record<string, ModelAlias>): void {
    this.models = models;
    // Map iterators tolerate deletion during iteration, so no snapshot copy.
    for (const alias of this.thinkingOverrides.keys()) {
      if (models[alias] === undefined) this.thinkingOverrides.delete(alias);
    }
    if (this.confirmDelete !== undefined && models[this.confirmDelete] === undefined) {
      this.confirmDelete = undefined;
    }
    this.list.updateItems(this.buildChoices(), (choice) => choice.alias);
    this.invalidate();
  }

  /**
   * Thinking effort for a model: an explicit ←/→ override when set, otherwise
   * the live effort for the active model, otherwise the model's default effort
   * (effort-capable) or 'on' (other thinking-capable models).
   */
  private draftFor(choice: ModelChoice): string {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) return this.opts.currentThinkingEffort;
    // The subagent default's draft seeds from its persisted effort, so ←/→ +
    // Alt+A round-trips the per-scope effort instead of the main model's.
    const subagent = this.opts.subagent?.current();
    if (subagent?.effort !== undefined && choice.alias === subagent.alias) {
      return subagent.effort;
    }
    const efforts = effortsOf(choice.model);
    if (efforts.length > 0) {
      // A model with support_efforts but no default_effort defaults to the
      // middle entry of its supported efforts.
      const def = choice.model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)];
      if (def !== undefined && efforts.includes(def)) return def;
      return efforts[0]!;
    }
    return thinkingAvailability(choice.model) !== 'unsupported' ? 'on' : 'off';
  }

  /** Draft coerced onto the model's segment list so rendering/selection never
   * reference a effort the model cannot actually select. */
  private effectiveEffort(choice: ModelChoice): string {
    const draft = this.draftFor(choice);
    const segments = segmentsFor(choice.model);
    return segments.includes(draft) ? draft : segments[0]!;
  }

  handleInput(data: string): void {
    // Legacy ESC-prefixed Alt bytes → CSI-u when Kitty is active (see
    // utils/legacy-meta-key) so Alt+S/E/D work standalone too — the tabbed
    // wrapper normalizes before forwarding, and the transform is idempotent.
    const normalized = normalizeLegacyMetaKey(data);
    if (this.confirmDelete !== undefined) {
      this.handleConfirmDeleteInput(normalized);
      return;
    }

    if (matchesKey(normalized, Key.escape)) {
      this.frame.handleEscape(this.list, this.opts.onCancel);
      return;
    }

    // ↑/↓, PgUp/PgDn, Home/End, and — when searchable — typing + Backspace.
    if (this.list.handleKey(normalized)) {
      return;
    }

    // Left/Right move the active thinking effort within the model's segments.
    if (matchesKey(normalized, Key.left) || matchesKey(normalized, Key.right)) {
      const selected = this.selectedChoice();
      if (selected !== undefined) {
        const segments = segmentsFor(selected.model);
        if (segments.length > 1) {
          const current = this.effectiveEffort(selected);
          const idx = segments.indexOf(current);
          // The two-segment case is the legacy boolean On/Off control: both
          // arrows flip it. With more segments (efforts), ←/→ step.
          let next: number;
          if (segments.length === 2) {
            next = idx === 0 ? 1 : 0;
          } else {
            const delta = matchesKey(normalized, Key.left) ? -1 : 1;
            next = Math.max(0, Math.min(segments.length - 1, idx + delta));
          }
          if (next !== idx) {
            this.thinkingOverrides.set(selected.alias, segments[next]!);
          }
        }
      }
      return;
    }

    if (matchesKey(normalized, Key.enter)) {
      this.activateSelected();
      return;
    }

    if (matchesKey(normalized, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const selected = this.selectedChoice();
      if (selected === undefined || selected.alias === ADD_CUSTOM_MODEL_ALIAS) return;
      this.opts.onSessionOnlySelect({
        alias: selected.alias,
        thinking: commitEffort(selected, this.effectiveEffort(selected)),
      });
      return;
    }

    // Subagent scope: Alt+A assigns the highlighted row (with its draft
    // effort) as the subagent default; on the row that already holds it the
    // key toggles back to "subagents follow the main model".
    const subagent = this.opts.subagent;
    if (subagent !== undefined && matchesKey(normalized, Key.alt('a'))) {
      const selected = this.selectedChoice();
      if (selected === undefined || selected.alias === ADD_CUSTOM_MODEL_ALIAS) return;
      if (selected.alias === subagent.current()?.alias) {
        subagent.onAssign(undefined);
        return;
      }
      subagent.onAssign({
        alias: selected.alias,
        thinking: commitEffort(selected, this.effectiveEffort(selected)),
      });
      return;
    }

    // Custom-model manage: Alt+E edits, Alt+D arms the inline delete confirm;
    // managed rows route to the guard callback (bare letters would land in
    // the fuzzy search, hence the Alt modifier).
    const manage = this.opts.manage;
    if (manage !== undefined && (matchesKey(normalized, Key.alt('e')) || matchesKey(normalized, Key.alt('d')))) {
      const selected = this.selectedChoice();
      if (selected === undefined || selected.alias === ADD_CUSTOM_MODEL_ALIAS) return;
      if (!manage.isCustom(selected.alias)) {
        manage.onGuard(selected.alias);
        return;
      }
      if (matchesKey(normalized, Key.alt('e'))) {
        manage.onEdit(selected.alias);
        return;
      }
      this.confirmDelete = selected.alias;
      this.invalidate();
    }
  }

  private handleConfirmDeleteInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.confirmDelete = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      const alias = this.confirmDelete;
      this.confirmDelete = undefined;
      this.invalidate();
      if (alias !== undefined) this.opts.manage?.onDelete(alias);
    }
    // Any other key while in the confirm substate is ignored.
  }

  /** Enter / re-click activation of the cursor row: the add-custom CTA runs
   * its action, model rows commit the selection with the draft effort. */
  private activateSelected(): void {
    const selected = this.selectedChoice();
    if (selected === undefined) return;
    if (selected.alias === ADD_CUSTOM_MODEL_ALIAS) {
      this.opts.onAddCustom?.();
      return;
    }
    this.opts.onSelect({
      alias: selected.alias,
      thinking: commitEffort(selected, this.effectiveEffort(selected)),
    });
  }

  /** Mouse: the wheel moves the cursor one row per tick, clamped by
   * SearchableList exactly like ↑/↓. Press and hover targeting is declared as
   * hit zones (see renderContent); the TUI dispatches zone presses to
   * {@link onHitZone} and tracks the hovered zone via {@link setHoveredZone}.
   * This handler keeps the wheel behavior and routes presses/motion arriving
   * outside the zone dispatch (e.g. direct component-relative events) through
   * the same zones. Ignored while the delete confirmation is armed. */
  handleMouse(event: MouseEvent): void | boolean {
    if (this.confirmDelete !== undefined) return false;
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
   * model row moves the cursor onto it (a press on the already-selected row
   * confirms it — the Enter equivalent); a thinking-control segment applies
   * its effort to the selected model (the ←/→ equivalent). While the search
   * box is the selected option no row is active, so a row press only selects
   * the row (dropping the box), never confirms.
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      this.list.focusSearch();
      this.invalidate();
      return;
    }
    if (typeof id === 'string' && id.startsWith('thinking:')) {
      const selected = this.selectedChoice();
      if (selected === undefined) return false;
      const effort = id.slice('thinking:'.length);
      const segments = segmentsFor(selected.model);
      if (segments.length <= 1 || !segments.includes(effort)) return false;
      this.thinkingOverrides.set(selected.alias, effort);
      this.invalidate();
      return;
    }
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    if (hit === view.selectedIndex && !view.searchFocused) {
      this.activateSelected();
      return;
    }
    this.list.selectIndex(hit);
    this.invalidate();
  }

  /** Zone hover: the hovered model row / thinking segment underlines. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  /**
   * The current list view (query, page window, cursor) — exposed for the
   * tabbed variant, which embeds this selector's content region in its own
   * dialog frame.
   */
  view(): SearchableListView<ModelChoice> {
    return this.list.view();
  }

  /** Whether the inline delete confirmation is armed. While armed the dialog
   * ignores the mouse, so hosts embed it without hit zones. */
  get mouseSuppressed(): boolean {
    return this.confirmDelete !== undefined;
  }

  /**
   * Key-hint segments for the current view. The search box carries the query
   * affordance; the hint only surfaces the backspace shortcut once a query is
   * active, and swaps "/ search" for the Esc-exit while the box is focused.
   * Public for the tabbed variant, which renders this selector's header.
   */
  hintParts(view: SearchableListView<ModelChoice>): string[] {
    const searchable = this.opts.searchable === true;
    const parts: string[] = [];
    if (this.opts.providerSwitchHint) parts.push(t('dialogs.model.hint.toggleProvider'));
    parts.push(t('common.hint.navigate'));
    if (searchable && view.query.length > 0) parts.push(t('dialogs.hint.backspaceClear'));
    parts.push(t('common.hint.select'));
    if (this.opts.onSessionOnlySelect !== undefined) parts.push(t('dialogs.model.hint.sessionOnly'));
    if (this.opts.subagent !== undefined) parts.push(t('dialogs.model.hint.subagent'));
    if (this.opts.manage !== undefined) {
      parts.push(t('dialogs.model.hint.edit'), t('dialogs.model.hint.delete'));
    }
    if (searchable && view.searchFocused) {
      parts.push(t('common.hint.searchExit'));
    } else {
      if (searchable) parts.push(t('common.hint.searchFocus'));
      parts.push(t('common.hint.cancel'));
    }
    return parts;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const { lines, zones } = this.renderContent(width);
    const frameLines = this.frame.render(width, {
      title: this.opts.title ?? t('dialogs.model.title'),
      hintParts: this.hintParts(view),
      ...(this.opts.warning !== undefined
        ? { notice: { text: this.opts.warning, tone: 'warning' as const, wrap: 'ansi' as const } }
        : {}),
      ...(searchable
        ? { search: { query: view.query, focused: view.searchFocused, zone: !this.mouseSuppressed } }
        : {}),
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (everything between the search box and the closing
   * divider): the model rows, the scroll/match indicator, and the thinking
   * control — or the inline delete confirmation replacing it. Returns the
   * lines plus the content-relative hit zones (row 0 = first content line);
   * while the delete confirmation is armed the dialog ignores the mouse, so
   * no zones are declared. Public for the tabbed variant, which splices the
   * region into its own dialog frame.
   */
  renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const view = this.list.view();
    const totalCount = Object.keys(this.models).length;
    const suppressZones = this.mouseSuppressed;
    const lines: string[] = [];
    const zones: HitZone[] = [];

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', `   ${t('common.noMatches')}`));
    } else {
      // Column width for model names so the provider column lines up. Capped so
      // the provider + "← current" marker still fit on normal terminal widths.
      const nameCap = Math.max(8, Math.floor(width * 0.5));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const isAddRow = choice.alias === ADD_CUSTOM_MODEL_ALIAS;
        const isCurrent = !isAddRow && choice.alias === this.opts.currentValue;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        // The add row is an action/CTA: keep it in the brand color so it never
        // reads as a model entry, bold when selected (provider-manager style).
        line += (
          isSelected
            ? currentTheme.boldFg('primary', truncatedName)
            : isAddRow
              ? currentTheme.fg('primary', truncatedName)
              : currentTheme.fg('text', truncatedName)
        ) + namePad;
        if (choice.provider.length > 0) {
          line += '  ' + currentTheme.fg('textMuted', choice.provider);
        }
        // Custom (user-maintained) models are badged so the rows the manage
        // keys (Alt+E/Alt+D) act on are identifiable.
        if (!isAddRow && this.opts.manage?.isCustom(choice.alias) === true) {
          line += ' ' + currentTheme.fg('textMuted', t('dialogs.model.customBadge'));
        }
        if (isCurrent) {
          line += ' ' + currentTheme.fg('success', t('common.currentMark'));
        }
        // The subagent default is badged like the current mark; both may land
        // on one row when main and subagent scopes point at the same model.
        if (!isAddRow && choice.alias === this.opts.subagent?.current()?.alias) {
          line += ' ' + currentTheme.fg('primary', t('dialogs.model.subagentBadge'));
        }
        const row = lines.length;
        lines.push(underlineText(line, this.hover.isHovered(i)));
        if (!suppressZones) zones.push({ id: i, row, col: 1, width, height: 1 });
      }
    }

    // Scroll / match indicator.
    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', t('dialogs.model.more', { count: below })));
      }
    }

    lines.push('');
    if (this.confirmDelete !== undefined) {
      // Inline delete confirmation replaces the thinking control (the same
      // transient-substate pattern as the provider manager's [y/N]).
      lines.push(
        currentTheme.boldFg(
          'warning',
          ` ${t('dialogs.model.manage.confirmDelete', { alias: this.confirmDelete })} [y/N]`,
        ),
      );
      for (const impact of this.opts.manage?.deleteImpact?.(this.confirmDelete) ?? []) {
        lines.push(currentTheme.fg('warning', ` ${impact}`));
      }
    } else {
      const selected = this.selectedChoice();
      if (selected !== undefined && selected.alias !== ADD_CUSTOM_MODEL_ALIAS) {
        const canSwitch = segmentsFor(selected.model).length > 1;
        const thinkingHeader = canSwitch ? t('dialogs.model.thinking.switch') : t('dialogs.model.thinking');
        lines.push(currentTheme.fg('textMuted', thinkingHeader));
        const controlRow = lines.length;
        lines.push(this.renderThinkingControl(selected));
        if (!suppressZones) zones.push(...this.thinkingControlZones(selected, controlRow));
      }
    }
    lines.push('');
    return { lines, zones };
  }

  /**
   * Hit zones for the thinking control's cells at the content-relative
   * `row`: one zone per available cell (the greyed-out unavailable cells
   * get none, like the keyboard). A single-segment (locked) control's cell
   * hovers but does not apply clicks, mirroring the ←/→ guard.
   */
  private thinkingControlZones(choice: ModelChoice, row: number): HitZone[] {
    const layout = this.thinkingControlLayout(choice);
    const clickable = segmentsFor(choice.model).length > 1;
    const zones: HitZone[] = [];
    let col = 3; // the control line starts with two spaces
    for (const segment of layout.segments) {
      const width = visibleWidth(segment.text);
      if (segment.effort !== null) {
        zones.push({
          id: `thinking:${segment.effort}`,
          row,
          col,
          width,
          height: 1,
          semantics: { action: clickable },
        });
      }
      col += width + layout.gap;
    }
    return zones;
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private renderThinkingControl(choice: ModelChoice): string {
    const layout = this.thinkingControlLayout(choice);
    // The hovered segment (mouse) is underlined; hover keys are the zone ids
    // (`thinking:<effort>` — see thinkingControlZones).
    const rendered = layout.segments.map((seg) => {
      const styled = seg.active
        ? currentTheme.boldFg('primary', seg.text)
        : seg.effort === null
          ? currentTheme.fg('textMuted', seg.text)
          : currentTheme.fg('text', seg.text);
      return underlineText(
        styled,
        seg.effort !== null && this.hover.isHovered(`thinking:${seg.effort}`),
      );
    });
    return `  ${rendered.join(' '.repeat(layout.gap))}`;
  }

  /**
   * The thinking control as clickable cells: unstyled cell texts (padding
   * included — widths drive the zone layout) plus the effort each cell
   * applies (null = the greyed-out unavailable side, not clickable). Shared
   * by the renderer and the zone declaration.
   */
  private thinkingControlLayout(choice: ModelChoice): ThinkingControlLayout {
    // 'on'/'off' are UI-owned pseudo efforts; concrete efforts (Low/High/…)
    // come from the model config and stay as declared.
    const segmentLabel = (effort: string): string => {
      if (effort === 'on') return t('dialogs.model.thinking.on');
      if (effort === 'off') return t('dialogs.model.thinking.off');
      return effortLabel(effort);
    };
    const cell = (effort: string, active: boolean): ThinkingSegment => ({
      text: active ? `[ ${segmentLabel(effort)} ]` : `  ${segmentLabel(effort)}  `,
      effort,
      active,
    });
    const unavailable = (effort: string): ThinkingSegment => ({
      text: `  ${t('dialogs.model.thinking.unsupported', { label: segmentLabel(effort) })}  `,
      effort: null,
      active: false,
    });

    // Non-effort always-on / unsupported models keep the original On/Off layout
    // so the control never shifts while moving across legacy models.
    const efforts = effortsOf(choice.model);
    const availability = thinkingAvailability(choice.model);
    if (efforts.length === 0 && availability === 'always-on') {
      return { segments: [cell('on', true), unavailable('off')], gap: 1 };
    }
    if (efforts.length === 0 && availability === 'unsupported') {
      return { segments: [unavailable('on'), cell('off', true)], gap: 1 };
    }

    const segments = segmentsFor(choice.model);
    const active = this.effectiveEffort(choice);
    return { segments: segments.map((effort) => cell(effort, effort === active)), gap: 2 };
  }
}
