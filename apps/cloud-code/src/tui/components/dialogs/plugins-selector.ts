import {
  Container,
  Input,
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
import type { PluginSummary } from '@cloud-code/sdk';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { formatPluginSourceLabel, localizedTrustLabel, pluginTrustLabel } from '#/tui/utils/plugin-source-label';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { wrapHintText } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList, type SearchableListView } from '#/tui/utils/searchable-list';
import { computeUpdateStatus, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { DIALOG_SEARCH_ZONE, DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';
import {
  displayStatus,
  ELLIPSIS,
  mutedHintLine,
  statusStyle,
  wrapOverviewDescription,
} from './plugins-shared';

// Hardcoded Web Bridge promotion: a built-in entry that always leads the
// Official tab, even when the marketplace catalog is unavailable. Selecting it
// opens the install page in the browser rather than installing from a source,
// because Web Bridge is a browser extension + daemon, not a plugin package.
const WEB_BRIDGE_URL = 'https://www.kimi.com/features/webbridge#local-agent';
const WEB_BRIDGE_ENTRY: PluginMarketplaceEntry = {
  id: 'kimi-webbridge',
  displayName: 'Kimi WebBridge',
  source: WEB_BRIDGE_URL,
  tier: 'official',
  homepage: WEB_BRIDGE_URL,
  description: 'plugins.webbridge.description',
};

// Only the hardcoded pinned row should open the WebBridge install page. Match
// by reference (not id) so a catalog entry on another tab that happens to
// reuse the same id still installs normally instead of being hijacked.
function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY;
}

function overviewPluginDescription(plugin: PluginSummary): string {
  const state =
    plugin.state === 'ok' ? '' : ` · ${t('plugins.overview.state', { state: plugin.state })}`;
  const skills = t(
    plugin.skillCount === 1 ? 'plugins.overview.skills.one' : 'plugins.overview.skills.other',
    { count: plugin.skillCount },
  );
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · MCP ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount}`
      : '';
  const diagnostics = plugin.hasErrors ? ` · ${t('plugins.overview.diagnostics')}` : '';
  const source = ` · ${formatPluginSourceLabel(plugin)}`;
  const trust = ` · ${localizedTrustLabel(pluginTrustLabel(plugin))}`;
  return `id ${plugin.id} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`;
}

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== 'ok') return plugin.state;
  return plugin.enabled ? 'enabled' : 'disabled';
}

// "update" is a warning (actionable); "installed" is success; "available"
// (install / open in browser) is the available action.
type MarketplaceStatusTone = 'update' | 'installed' | 'available';

function marketplaceStatusStyle(
  tone: MarketplaceStatusTone,
  colors: ColorPalette,
): (text: string) => string {
  if (tone === 'update') return chalk.hex(colors.warning);
  if (tone === 'installed') return chalk.hex(colors.success);
  return chalk.hex(colors.primary);
}

/** Rounded single-line URL input box (DESIGN §9), shared by the marketplace
 * Custom tab and the unified plugins panel. */
function renderUrlInputBox(
  input: Input,
  focused: boolean,
  width: number,
  colors: ColorPalette,
): string[] {
  input.focused = focused;
  const border = (s: string): string => chalk.hex(colors.border)(s);
  const boxWidth = Math.max(24, width - 2);
  const innerWidth = Math.max(10, boxWidth - 4);
  const inputLine = input.render(innerWidth)[0] ?? '';
  const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
  return [
    ' ' + border('╭' + '─'.repeat(boxWidth - 2) + '╮'),
    ' ' + border('│') + '  ' + inputLine + ' '.repeat(rightPad) + border('│'),
    ' ' + border('╰' + '─'.repeat(boxWidth - 2) + '╯'),
  ];
}

// ===========================================================================
// Unified /plugins panel: Installed / Official / Third-party / Custom tabs.
// ===========================================================================

export type PluginsPanelTabId = 'installed' | 'official' | 'third-party' | 'custom';

export type PluginsPanelSelection =
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'details'; readonly id: string }
  | { readonly kind: 'reload' }
  | { readonly kind: 'install'; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'install-source'; readonly source: string }
  | { readonly kind: 'open-url'; readonly url: string; readonly label: string };

export interface PluginsPanelOptions {
  readonly installed: readonly PluginSummary[];
  readonly installedIds: ReadonlySet<string>;
  readonly initialTab?: PluginsPanelTabId;
  readonly selectedId?: string;
  readonly pluginHint?: { readonly id: string; readonly text: string };
  readonly onSelect: (selection: PluginsPanelSelection) => void;
  readonly onCancel: () => void;
  /** Called the first time the Official or Third-party tab needs its catalog.
   * The host fetches the marketplace and calls setMarketplace / setMarketplaceError. */
  readonly onRequestMarketplace?: () => void;
}

type MarketState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly entries: readonly PluginMarketplaceEntry[]; readonly source: string };

const PLUGINS_PANEL_TABS: readonly { id: PluginsPanelTabId; label: string }[] = [
  { id: 'installed', label: 'plugins.tab.installed' },
  { id: 'official', label: 'plugins.tab.official' },
  { id: 'third-party', label: 'plugins.tab.thirdParty' },
  { id: 'custom', label: 'plugins.tab.custom' },
];

/** Text a marketplace entry is fuzzy-matched against (label + stable id). */
function marketplaceSearchText(entry: PluginMarketplaceEntry): string {
  return `${entry.displayName} ${entry.id}`;
}

export class PluginsPanelComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginsPanelOptions;
  private readonly customInput = new Input();
  private activeTabIndex: number;
  /**
   * Per-tab searchable lists (Installed / Official / Third-party): each keeps
   * its own query, search focus, and cursor across tab switches — the
   * tabbed-model-selector pattern of one list per tab. The Official tab's
   * list includes the pinned Web Bridge entry as item 0. The Custom tab is a
   * URL input, not a list, so it has no search box.
   */
  private readonly installedList: SearchableList<PluginSummary>;
  private readonly officialList: SearchableList<PluginMarketplaceEntry>;
  private readonly thirdPartyList: SearchableList<PluginMarketplaceEntry>;
  private market: MarketState = { status: 'idle' };
  private installing: string | undefined;
  /** The dialog skeleton owning the chrome (divider/title/hint/tab strip/
   * search box) and its row math. The hint is flush-left in this dialog;
   * it is pre-wrapped (segment boundaries) and pre-styled by the dialog, so
   * the frame leaves the lines untouched. */
  private readonly frame = new DialogFrame({
    hintIndent: '',
    minSize: inlineDialogMinSize(),
    formatHintLine: (line) => line,
  });
  /** Frame-relative hit zones of the last render (tab cells + the search box
   * + the active tab's list rows) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /**
   * Hovered interactive element (mouse motion), namespaced like the zone ids:
   * `tab:N` (the tab strip) and `row:N` (a list row in the active tab). Null
   * elsewhere.
   */
  private readonly hover = new HoverState<HitZoneId>();
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(opts: PluginsPanelOptions) {
    super();
    this.opts = opts;
    this.activeTabIndex = Math.max(
      0,
      PLUGINS_PANEL_TABS.findIndex((tab) => tab.id === (opts.initialTab ?? 'installed')),
    );
    // selectedId pre-selects a row on the Installed tab only; on every other
    // initial tab the cursor starts at the first row, as before.
    const initialInstalledIndex =
      opts.selectedId !== undefined && this.activeTab.id === 'installed'
        ? Math.max(0, opts.installed.findIndex((p) => p.id === opts.selectedId))
        : 0;
    this.installedList = new SearchableList({
      items: opts.installed,
      toSearchText: (plugin) => `${plugin.displayName} ${plugin.id}`,
      initialIndex: initialInstalledIndex,
      searchable: true,
    });
    // The catalog lands asynchronously (setMarketplace); until then the
    // Official list holds just the pinned Web Bridge entry, which renders —
    // and stays actionable — through the loading and error states.
    this.officialList = new SearchableList({
      items: this.officialEntries,
      toSearchText: marketplaceSearchText,
      searchable: true,
    });
    this.thirdPartyList = new SearchableList({
      items: [],
      toSearchText: marketplaceSearchText,
      searchable: true,
    });
    this.customInput.onSubmit = (value) => {
      const source = value.trim();
      if (source.length > 0) this.opts.onSelect({ kind: 'install-source', source });
    };
  }

  marketplaceStatus(): MarketState['status'] {
    return this.market.status;
  }

  setMarketplaceLoading(): void {
    this.market = { status: 'loading' };
    this.refreshMarketplaceLists();
  }

  setMarketplace(entries: readonly PluginMarketplaceEntry[], source: string): void {
    this.market = { status: 'loaded', entries, source };
    this.refreshMarketplaceLists();
  }

  setMarketplaceError(message: string): void {
    this.market = { status: 'error', message };
    this.refreshMarketplaceLists();
  }

  setInstalling(label: string): void {
    this.installing = label;
    this.invalidate();
  }

  clearInstalling(): void {
    this.installing = undefined;
    this.invalidate();
  }

  private get activeTab(): (typeof PLUGINS_PANEL_TABS)[number] {
    return PLUGINS_PANEL_TABS[this.activeTabIndex]!;
  }

  /** The active tab's list; the Custom tab (a URL input, not a list) has none. */
  private get activeList():
    | SearchableList<PluginSummary>
    | SearchableList<PluginMarketplaceEntry>
    | undefined {
    switch (this.activeTab.id) {
      case 'installed':
        return this.installedList;
      case 'official':
        return this.officialList;
      case 'third-party':
        return this.thirdPartyList;
      case 'custom':
        return undefined;
    }
  }

  /** The active marketplace tab's list (Official or Third-party only). */
  private get activeMarketList(): SearchableList<PluginMarketplaceEntry> {
    return this.activeTab.id === 'official' ? this.officialList : this.thirdPartyList;
  }

  /**
   * Re-seeds the two marketplace lists after the catalog state changed
   * (loading / loaded / error). Queries and search focus survive; the cursor
   * follows the previously selected entry by id (see updateItems).
   */
  private refreshMarketplaceLists(): void {
    this.officialList.updateItems(this.officialEntries, (entry) => entry.id);
    this.thirdPartyList.updateItems(this.thirdPartyEntries, (entry) => entry.id);
  }

  private get marketplaceEntries(): readonly PluginMarketplaceEntry[] {
    if (this.market.status !== 'loaded') return [];
    const { installedIds } = this.opts;
    return this.market.entries.toSorted(
      (a, b) => Number(installedIds.has(b.id)) - Number(installedIds.has(a.id)),
    );
  }

  private get installedVersions(): ReadonlyMap<string, string | undefined> {
    return new Map(this.opts.installed.map((plugin) => [plugin.id, plugin.version]));
  }

  private get officialEntries(): readonly PluginMarketplaceEntry[] {
    // The hardcoded Web Bridge entry always leads the Official tab, even when
    // the catalog is loading or unreachable. Dedupe by id so a catalog that
    // also lists it does not render a second row.
    return [WEB_BRIDGE_ENTRY, ...this.officialCatalogEntries];
  }

  private get officialCatalogEntries(): readonly PluginMarketplaceEntry[] {
    // Dedupe by id (not reference): if the official catalog also lists
    // kimi-webbridge, the pinned row already represents it, so suppress the
    // catalog copy to avoid a duplicate row on the Official tab.
    return this.marketplaceEntries.filter(
      (entry) => entry.tier === 'official' && entry.id !== WEB_BRIDGE_ENTRY.id,
    );
  }

  private get thirdPartyEntries(): readonly PluginMarketplaceEntry[] {
    // Anything not explicitly marked official lands here: `curated` entries plus
    // entries that omit `tier` (custom marketplaces often do). Without this,
    // untiered entries would be invisible in both marketplace tabs.
    return this.marketplaceEntries.filter((entry) => entry.tier !== 'official');
  }

  private requestMarketplaceIfNeeded(): void {
    // The Installed tab also needs the catalog to render update badges; only the
    // Custom tab (manual URL entry) can skip the fetch entirely.
    if (this.market.status === 'idle' && this.activeTab.id !== 'custom') {
      this.market = { status: 'loading' };
      this.refreshMarketplaceLists();
      this.opts.onRequestMarketplace?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // Searchable tabs layer Esc (clear query → unfocus the box → close);
      // the Custom tab is a text input, where Esc cancels flat (keyboard
      // contract, input-dialog family).
      switch (this.activeTab.id) {
        case 'installed':
          this.frame.handleEscape(this.installedList, this.opts.onCancel);
          return;
        case 'official':
          this.frame.handleEscape(this.officialList, this.opts.onCancel);
          return;
        case 'third-party':
          this.frame.handleEscape(this.thirdPartyList, this.opts.onCancel);
          return;
        case 'custom':
          this.opts.onCancel();
          return;
      }
    }
    // Tab switches preserve each tab's query and cursor (one list per tab).
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex = (this.activeTabIndex + 1) % PLUGINS_PANEL_TABS.length;
      this.requestMarketplaceIfNeeded();
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + PLUGINS_PANEL_TABS.length) % PLUGINS_PANEL_TABS.length;
      this.requestMarketplaceIfNeeded();
      return;
    }
    switch (this.activeTab.id) {
      case 'installed':
        this.handleInstalledInput(data);
        return;
      case 'official':
      case 'third-party':
        this.handleMarketplaceInput(data);
        return;
      case 'custom':
        this.customInput.handleInput(data);
        return;
    }
  }

  private handleInstalledInput(data: string): void {
    // Legacy ESC-prefixed Alt bytes → CSI-u when Kitty is active (see
    // utils/legacy-meta-key) so the Alt manage keys arrive in every terminal.
    const normalized = normalizeLegacyMetaKey(data);
    const list = this.installedList;
    // Enter always activates the highlighted row, even mid-search (the
    // search-dialog family leaves Enter to the component).
    if (matchesKey(normalized, Key.enter)) {
      const plugin = list.selected();
      if (plugin !== undefined) this.activateInstalled(plugin);
      return;
    }
    // The canonical row actions are Alt+letter (the keyboard contract's
    // manage-key rule, same as the /model picker): they are never query
    // characters, so they fire even while the search box is focused. The
    // pre-contract bare letters stay as silent aliases for one release, but
    // only with the box unfocused — focused, they are query text.
    const altPlugin = list.selected();
    if (matchesKey(normalized, Key.alt('d'))) {
      if (altPlugin !== undefined) this.opts.onSelect({ kind: 'remove', id: altPlugin.id });
      return;
    }
    if (matchesKey(normalized, Key.alt('m'))) {
      if (altPlugin !== undefined) this.opts.onSelect({ kind: 'mcp', id: altPlugin.id });
      return;
    }
    if (matchesKey(normalized, Key.alt('r'))) {
      this.opts.onSelect({ kind: 'reload' });
      return;
    }
    if (matchesKey(normalized, Key.alt('i'))) {
      if (altPlugin !== undefined) this.opts.onSelect({ kind: 'details', id: altPlugin.id });
      return;
    }
    // Once the search box is the selected option every other key is
    // list/search input: arrows never move the list highlight (↓ drops back
    // onto the first row), printable characters (Space included) edit the
    // query. The row actions below keep their bare letters only while the
    // box is unselected (the experiments-selector Space precedent).
    if (list.view().searchFocused) {
      list.handleKey(normalized);
      return;
    }
    const plugin = list.selected();
    const ch = printableChar(normalized);
    // Decode Space for terminals that send printable keys via Kitty/CSI-u
    // sequences (e.g. VS Code's integrated terminal); `matchesKey(Key.space)`
    // alone misses those and the toggle silently stops working.
    if (matchesKey(normalized, Key.space) || ch === ' ') {
      if (plugin !== undefined) {
        this.opts.onSelect({ kind: 'toggle', id: plugin.id, enabled: !plugin.enabled });
      }
      return;
    }
    if (ch === 'd' || ch === 'D') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'remove', id: plugin.id });
      return;
    }
    if (ch === 'm' || ch === 'M') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'mcp', id: plugin.id });
      return;
    }
    if (ch === 'r' || ch === 'R') {
      this.opts.onSelect({ kind: 'reload' });
      return;
    }
    if (ch === 'i' || ch === 'I') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'details', id: plugin.id });
      return;
    }
    // ↑/↓, PgUp/PgDn, Home/End, `/` (focus the box), Backspace (trim query).
    list.handleKey(normalized);
  }

  /** Enter on an Installed-tab row: install the available update when there
   * is one, otherwise open the plugin's details. */
  private activateInstalled(plugin: PluginSummary): void {
    const update = this.installedUpdateStatus(plugin);
    if (update !== undefined) {
      this.opts.onSelect({ kind: 'install', entry: update.entry });
    } else {
      this.opts.onSelect({ kind: 'details', id: plugin.id });
    }
  }

  private handleMarketplaceInput(data: string): void {
    const list = this.activeMarketList;
    if (matchesKey(data, Key.enter)) {
      const entry = list.selected();
      if (entry !== undefined) this.activateMarketplace(entry);
      return;
    }
    // ↑/↓, PgUp/PgDn, Home/End, and the search focus/typing keys; while the
    // box is unfocused printable characters stay inert (no type-to-search).
    list.handleKey(data);
  }

  /** Enter on a marketplace row: the pinned Web Bridge entry opens its URL;
   * every other entry installs. */
  private activateMarketplace(entry: PluginMarketplaceEntry): void {
    if (isPinnedWebBridgeEntry(entry)) {
      this.opts.onSelect({ kind: 'open-url', url: WEB_BRIDGE_URL, label: entry.displayName });
      return;
    }
    this.opts.onSelect({ kind: 'install', entry });
  }

  /**
   * Mouse: the wheel moves the highlighted row within the active tab's list,
   * clamped by SearchableList exactly like ↑/↓ (the Custom tab is a text
   * input — no list, ignored there). Press and hover targeting is declared as
   * hit zones (tab cells + the search box + list rows — see renderContent);
   * the TUI dispatches zone presses to {@link onHitZone} and tracks the
   * hovered zone via {@link setHoveredZone}. This handler keeps the wheel
   * behavior and routes presses/motion arriving outside the zone dispatch
   * (e.g. direct component-relative events) through the same zones.
   * All mouse input is ignored while an install is in progress.
   */
  handleMouse(event: MouseEvent): void | boolean {
    if (this.installing !== undefined) return false;
    if (event.type === 'wheel') {
      const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
      if (delta === 0) return false;
      const list = this.activeList;
      if (list === undefined || list.view().items.length === 0) return false;
      if (delta < 0) list.moveUp();
      else list.moveDown();
      this.invalidate();
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

  /**
   * Zone press: the search box selects it (the mouse counterpart of `/`); a
   * tab cell switches tabs; a list row highlights it — a press on the
   * already-highlighted row activates it (Enter equivalent — see
   * utils/mouse-hover for the uniform click semantics), except while the
   * search box is the selected option, when a row press only highlights.
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      const list = this.activeList;
      if (list === undefined) return false;
      list.focusSearch();
      this.invalidate();
      return;
    }
    if (typeof id === 'string' && id.startsWith('tab:')) {
      const idx = Number(id.slice('tab:'.length));
      if (
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= PLUGINS_PANEL_TABS.length ||
        idx === this.activeTabIndex
      ) {
        return false;
      }
      this.activeTabIndex = idx;
      this.hover.update(null);
      this.requestMarketplaceIfNeeded();
      this.invalidate();
      return;
    }
    if (typeof id === 'string' && id.startsWith('row:')) {
      const list = this.activeList;
      if (list === undefined) return false;
      const hit = Number(id.slice('row:'.length));
      const view = list.view();
      if (!Number.isInteger(hit) || hit < 0 || hit >= view.items.length) return false;
      // While the search box is the selected option no row is active: a row
      // press only highlights the row (dropping the box), never activates.
      if (hit === view.selectedIndex && !view.searchFocused) {
        this.activateRow(hit);
        return;
      }
      list.selectIndex(hit);
      this.invalidate();
      return;
    }
    return false;
  }

  /** Zone hover: the hovered tab / list row underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  /** Re-click activation of the highlighted row (Enter per active tab). The
   * index is into the active list's filtered view (zone ids are view indexes). */
  private activateRow(index: number): void {
    switch (this.activeTab.id) {
      case 'installed': {
        const plugin = this.installedList.view().items[index];
        if (plugin !== undefined) this.activateInstalled(plugin);
        return;
      }
      case 'official':
      case 'third-party': {
        const entry = this.activeMarketList.view().items[index];
        if (entry !== undefined) this.activateMarketplace(entry);
        return;
      }
      case 'custom':
        return;
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.customInput.invalidate();
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    if (this.installing !== undefined) {
      this.frameZones = [];
      return this.renderInstalling(width);
    }
    const tab = this.activeTab.id;
    // The search box appears on the three list tabs; the Custom tab (a URL
    // input) has no list to filter and renders without it.
    let hint: string;
    let search: { query: string; focused: boolean } | undefined;
    switch (tab) {
      case 'installed': {
        const view = this.installedList.view();
        hint = this.installedHint(view);
        search = { query: view.query, focused: view.searchFocused };
        break;
      }
      case 'official':
      case 'third-party': {
        const view = this.activeMarketList.view();
        hint = t('plugins.panel.hint.marketplace', { search: this.searchHintSegment(view) });
        search = { query: view.query, focused: view.searchFocused };
        break;
      }
      default:
        hint = t('plugins.panel.hint.custom');
    }
    const { lines, zones } = this.renderContent(width);
    // Layout: divider, title, hint, blank, tab strip, blank, search box (list
    // tabs), then the active tab's content region — the frame owns the
    // composition and the row math.
    const frameLines = this.frame.render(width, {
      title: t('plugins.panel.title'),
      // Wrap the raw hint at segment boundaries before styling, so narrow
      // widths drop no key (the legacy single clamped line silently cut the
      // tail segments). Each wrapped line fits, so the frame's own pass is a
      // no-op and the lines arrive pre-styled via the identity formatHintLine.
      hintLines: wrapHintText(hint, width).map((line) =>
        mutedHintLine(line, currentTheme.palette),
      ),
      tabStrip: {
        labels: PLUGINS_PANEL_TABS.map((panelTab) => resolveDescription(panelTab.label)),
        activeIndex: this.activeTabIndex,
        hoverIndex: this.hoverKeyIndex('tab:'),
      },
      ...(search !== undefined ? { search } : {}),
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  /**
   * The trailing hint segment every searchable tab shares: the focused search
   * box swaps the cancel segment for the Esc-exit; the unfocused box
   * advertises the `/` focus key (the search-dialog family idiom).
   */
  private searchHintSegment(view: SearchableListView<unknown>): string {
    return view.searchFocused
      ? t('common.hint.searchExit')
      : `${t('common.hint.searchFocus')} · ${t('common.hint.cancel')}`;
  }

  /** Numeric suffix of the current hover key within one namespace. */
  private hoverKeyIndex(prefix: string): number | null {
    const key = this.hover.index;
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    const idx = Number(key.slice(prefix.length));
    return Number.isInteger(idx) ? idx : null;
  }

  /**
   * The content region (everything between the tab strip and the closing
   * divider): the active tab's rows. Returns the lines plus the
   * content-relative hit zones (row 0 = first content line): one `row:N` zone
   * per list row, spanning its label and description rows.
   */
  private renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const tab = this.activeTab.id;
    const lines: string[] = [];
    const ranges: { top: number; height: number; index: number }[] = [];
    if (tab === 'installed') this.renderInstalled(lines, ranges, width);
    else if (tab === 'official' || tab === 'third-party') {
      this.renderMarketplaceTab(lines, ranges, width);
    } else this.renderCustom(lines, width);

    // Hover underline: the hovered row's label line (mouse motion).
    const hoveredRow = this.hoverKeyIndex('row:');
    if (hoveredRow !== null) {
      const range = ranges.find((r) => r.index === hoveredRow);
      const labelLine = range === undefined ? undefined : lines[range.top];
      if (range !== undefined && labelLine !== undefined) {
        lines[range.top] = underlineText(labelLine, true);
      }
    }

    const zones = ranges.map((range) => ({
      id: `row:${String(range.index)}`,
      row: range.top,
      col: 1,
      width,
      height: range.height,
    }));
    return { lines, zones };
  }

  private renderInstalled(
    lines: string[],
    ranges: { top: number; height: number; index: number }[],
    width: number,
  ): void {
    const view = this.installedList.view();
    const colors = currentTheme.palette;
    if (view.items.length === 0) {
      // A filter that matches nothing reads differently from a genuinely
      // empty install set.
      lines.push(
        chalk.hex(colors.textMuted)(
          view.query.length > 0 ? `   ${t('common.noMatches')}` : t('plugins.installed.empty'),
        ),
      );
    } else {
      for (let i = 0; i < view.items.length; i++) {
        const top = lines.length;
        lines.push(...this.renderInstalledRow(view.items[i]!, i === view.selectedIndex, width));
        ranges.push({ top, height: lines.length - top, index: i });
      }
    }
    lines.push('');
    // The count describes the full installed set, not the filter's matches.
    lines.push(mutedHintLine(t('plugins.installed.count', { count: this.opts.installed.length }), colors));
  }

  private installedHint(view: SearchableListView<PluginSummary>): string {
    const plugin = this.installedList.selected();
    const hasUpdate = plugin !== undefined && this.installedUpdateStatus(plugin) !== undefined;
    const enter = hasUpdate
      ? t('plugins.panel.hint.enterUpdate')
      : t('plugins.panel.hint.enterDetails');
    // Alt+I opens the same details page as Enter whenever no update is
    // pending, so it is only advertised while Enter installs the update —
    // showing both "Enter details · Alt+I details" reads as two different
    // actions for one key path.
    const altDetails = hasUpdate ? ` · ${t('plugins.panel.hint.altDetails')}` : '';
    return t('plugins.panel.hint.installed', {
      enter,
      altDetails,
      search: this.searchHintSegment(view),
    });
  }

  private installedUpdateStatus(
    plugin: PluginSummary,
  ): { entry: PluginMarketplaceEntry; local: string; latest: string } | undefined {
    if (this.market.status !== 'loaded') return undefined;
    const entry = this.market.entries.find((e) => e.id === plugin.id);
    if (entry === undefined) return undefined;
    const status = computeUpdateStatus(entry.version, plugin.version, true);
    return status.kind === 'update' ? { entry, local: status.local, latest: status.latest } : undefined;
  }

  private renderInstalledRow(plugin: PluginSummary, selected: boolean, width: number): string[] {
    const colors = currentTheme.palette;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const status = pluginStatus(plugin);
    const update = this.installedUpdateStatus(plugin);
    let line = prefix + labelStyle(plugin.displayName);
    if (status !== undefined) {
      line += '  ' + statusStyle({ kind: 'plugin', value: '', label: '', description: '', status }, colors)(displayStatus(status));
    }
    if (update !== undefined) {
      const badge = t('plugins.marketplace.status.update', {
        local: update.local,
        latest: update.latest,
      });
      line += '  ' + marketplaceStatusStyle('update', colors)(badge);
    }
    if (this.opts.pluginHint?.id === plugin.id) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.pluginHint.text);
    }
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(overviewPluginDescription(plugin), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  /**
   * A marketplace tab (Official / Third-party): the active list's filtered
   * rows, then the catalog status — loading / error lines, or the footer
   * counts and source. Rows render first so the Official tab's pinned Web
   * Bridge entry (list item 0) stays visible and actionable while the
   * catalog loads or errs. Counts cover the catalog matches, excluding the
   * pinned entry, which is built into the TUI rather than fetched.
   */
  private renderMarketplaceTab(
    lines: string[],
    ranges: { top: number; height: number; index: number }[],
    width: number,
  ): void {
    const view = this.activeMarketList.view();
    const colors = currentTheme.palette;
    for (let i = 0; i < view.items.length; i++) {
      const top = lines.length;
      lines.push(...this.renderMarketplaceRow(view.items[i]!, i === view.selectedIndex, width));
      ranges.push({ top, height: lines.length - top, index: i });
    }
    if (this.market.status === 'loading' || this.market.status === 'idle') {
      lines.push(chalk.hex(colors.textMuted)(t('plugins.marketplace.loading')));
      return;
    }
    if (this.market.status === 'error') {
      lines.push(
        chalk.hex(colors.warning)(
          t('plugins.marketplace.unavailable', { message: this.market.message }),
        ),
      );
      lines.push(mutedHintLine(t('plugins.marketplace.unavailableHint'), colors));
      return;
    }
    const catalogMatches = view.items.filter((entry) => !isPinnedWebBridgeEntry(entry));
    if (view.items.length === 0) {
      // A filter that matches nothing reads differently from a genuinely
      // empty catalog.
      lines.push(
        chalk.hex(colors.textMuted)(
          view.query.length > 0 ? `   ${t('common.noMatches')}` : t('plugins.marketplace.empty'),
        ),
      );
    } else if (view.query.length === 0 && catalogMatches.length === 0) {
      // Official tab with an empty catalog: only the pinned row remains, and
      // the empty notice still applies to the catalog itself.
      lines.push(chalk.hex(colors.textMuted)(t('plugins.marketplace.empty')));
    }
    const installedCount = catalogMatches.filter((e) => this.opts.installedIds.has(e.id)).length;
    lines.push('');
    lines.push(
      mutedHintLine(
        t('plugins.marketplace.count', {
          installed: installedCount,
          available: catalogMatches.length - installedCount,
        }),
        colors,
      ),
    );
    lines.push(mutedHintLine(t('plugins.marketplace.source', { source: this.market.source }), colors));
  }

  private renderMarketplaceRow(entry: PluginMarketplaceEntry, selected: boolean, width: number): string[] {
    const colors = currentTheme.palette;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const status = isPinnedWebBridgeEntry(entry)
      ? { text: t('plugins.marketplace.status.openInBrowser'), tone: 'available' as const }
      : marketplaceEntryStatus(entry, this.installedVersions);
    const line =
      prefix +
      labelStyle(entry.displayName) +
      '  ' +
      marketplaceStatusStyle(status.tone, colors)(status.text);
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(marketplaceEntryDescription(entry), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderCustom(lines: string[], width: number): void {
    const colors = currentTheme.palette;
    lines.push(mutedHintLine(t('plugins.custom.prompt'), colors));
    lines.push('');
    lines.push(...renderUrlInputBox(this.customInput, this.focused, width, colors));
  }

  private renderInstalling(width: number): string[] {
    const colors = currentTheme.palette;
    const lines = [
      chalk.hex(colors.border)('─'.repeat(width)),
      chalk.hex(colors.border).bold(t('plugins.panel.title')),
      '',
      chalk.hex(colors.textMuted)(t('plugins.installing', { label: this.installing ?? '' })),
      '',
      chalk.hex(colors.border)('─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  const tier = marketplaceTierLabel(entry.tier);
  const description =
    entry.description !== undefined ? resolveDescription(entry.description) : tier;
  const version = entry.version !== undefined ? ` · v${entry.version}` : '';
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : '';
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : '';
  // Origin badge for merged catalogs: entries from a registered custom
  // marketplace carry its name so they stay identifiable on the Third-party
  // tab (the `@name` shape echoes the `plugin@marketplace` install syntax).
  const marketplaceSuffix = entry.marketplace !== undefined ? ` · @${entry.marketplace}` : '';
  return `${description} · id ${entry.id}${version}${tierSuffix}${keywords}${marketplaceSuffix}`;
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return t('plugins.tier.official');
  if (tier === 'curated') return t('plugins.tier.curated');
  return t('plugins.tier.other');
}

function installStatus(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined
    ? t('plugins.marketplace.status.install')
    : t('plugins.marketplace.status.installVersion', { version: entry.version });
}

function marketplaceEntryStatus(
  entry: PluginMarketplaceEntry,
  installed: ReadonlyMap<string, string | undefined>,
): { text: string; tone: MarketplaceStatusTone } {
  const status = computeUpdateStatus(entry.version, installed.get(entry.id), installed.has(entry.id));
  switch (status.kind) {
    case 'update':
      return {
        text: t('plugins.marketplace.status.update', {
          local: status.local,
          latest: status.latest,
        }),
        tone: 'update',
      };
    case 'up-to-date':
      return {
        text:
          status.version === undefined
            ? t('plugins.marketplace.status.installed')
            : t('plugins.marketplace.status.installedVersion', { version: status.version }),
        tone: 'installed',
      };
    case 'not-installed':
      return { text: installStatus(entry), tone: 'available' };
  }
}


// Re-exports: the MCP selector and the remove / install-trust confirm pickers
// live in plugins-mcp.ts (split out for the 800-line soft cap); the public
// import surface stays here so existing importers are unaffected.
export {
  MarketplaceRemoveConfirmComponent,
  MarketplaceTrustConfirmComponent,
  PluginInstallTrustConfirmComponent,
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  type MarketplaceRemoveConfirmOptions,
  type MarketplaceRemoveConfirmResult,
  type MarketplaceTrustConfirmOptions,
  type MarketplaceTrustConfirmResult,
  type PluginInstallTrustConfirmOptions,
  type PluginInstallTrustConfirmResult,
  type PluginMcpSelection,
  type PluginMcpSelectorOptions,
  type PluginRemoveConfirmOptions,
  type PluginRemoveConfirmResult,
} from './plugins-mcp';
