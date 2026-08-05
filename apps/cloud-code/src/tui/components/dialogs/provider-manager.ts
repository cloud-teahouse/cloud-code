/**
 * ProviderManagerComponent — pure-view CRUD UI for the `/provider` command.
 *
 * Single-column layout showing one row per "platform / source":
 *   - each Open Platform login (1 source = 1 provider)
 *   - each Custom Registry connection grouping by `{url, apiKey}`
 *     (1 source = N providers from the same api.json fetch)
 *   - any other configured provider (1 source = 1 provider)
 *   - a synthetic final `[ Add New Platform ]` action row
 * OAuth service providers (`managed:*` — Cloud Code OAuth, ChatGPT Codex) are
 * intentionally hidden — those accounts are managed through `/login` /
 * `/logout`, not here.
 *
 * Keyboard:
 *   - ↑ / ↓             move highlight
 *   - ← / → · PgUp/PgDn page
 *   - / or ↑ on the first row · click the box
 *                       select the search box; typing filters the rows
 *                       (fuzzy), Esc layers clear → unfocus → close
 *   - Enter             on a source row → `onViewModels(providerId)`;
 *                       on `[ Add New Platform ]` → `onAdd()`
 *   - Alt+A             add a model under a custom (standalone) provider →
 *                       `onAddModel(id)`; on a managed source →
 *                       `onAddModelGuard(label)`
 *   - Alt+E             edit a custom (standalone) provider → `onEditProvider(id)`;
 *                       on a managed source → `onEditGuard(label)` (only when
 *                       the callbacks are set)
 *   - Alt+D             delete with inline `[y/N]` confirmation (lists the
 *                         models the delete cascades to)
 *                         on a source row → `onDeleteSource(providerIds)`
 *                         on `[ Add New Platform ]` → ignored
 *   - Esc               `onClose()` (outside confirm, search box unselected)
 *
 * Alt+E / Alt+D are the keyboard contract's canonical manage keys (same as
 * the /model picker); the pre-contract bare E/D stay as silent aliases for
 * one release, and the hint line advertises only the Alt keys. While the
 * search box is selected, printable keys edit the query instead.
 *
 * The `[y/N]` confirmation is a transient substate handled in-component:
 * while armed, only `y` / `Y` / `n` / `N` / `Esc` are honored and the
 * prompt replaces the footer hint.
 *
 * Custom (standalone, user-maintained) providers carry a `[custom]` badge —
 * they are the rows Alt+E/Alt+A act on.
 *
 * The component is pure-view: every CRUD side effect is dispatched back
 * through callbacks. The host (`CloudCodeTui`) is responsible for performing
 * the harness / config mutations and then pushing a fresh snapshot via
 * `setOptions`.
 */

import type { ModelAlias, ProviderConfig } from '@cloud-code/sdk';
import {
  getOpenPlatformById,
  isOpenPlatformId,
  type CustomRegistrySource,
} from '@cloud-code/oauth';
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

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { isCustomProvider } from '#/tui/utils/custom-entries';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

import {
  DIALOG_SEARCH_ZONE,
  DialogFrame,
  inlineDialogMinSize,
} from './frame/dialog-frame';
import { providerServiceName } from './model-selector';

interface ConfirmState {
  readonly rowLabel: string;
  readonly providerIds: readonly string[];
  /** Model aliases the delete cascades to (across all `providerIds`). */
  readonly modelAliases: readonly string[];
}

export interface ProviderManagerOptions {
  /** All currently configured providers (`config.providers`). */
  readonly providers: Record<string, ProviderConfig>;
  /** All currently configured models (`config.models`) — delete impact. */
  readonly models?: Record<string, ModelAlias>;
  /** Provider id of the currently active model. */
  readonly activeProviderId?: string;
  readonly onAdd: () => void;
  /** Enter on a source row: open the model picker on that provider's tab. */
  readonly onViewModels?: (providerId: string) => void;
  /** Alt+A on a custom source row: chain into the add-model wizard. */
  readonly onAddModel?: (providerId: string) => void;
  /** Alt+A on a managed source row — the host shows the guard message. */
  readonly onAddModelGuard?: (label: string) => void;
  /** Delete all providers under a source (Open Platform / custom-registry
   *  fetch / standalone). Passed the full provider-id list so the host
   *  doesn't have to re-derive the source grouping. */
  readonly onDeleteSource: (providerIds: readonly string[]) => void;
  /** Edit a custom (standalone) provider — only fires for `[custom]` rows. */
  readonly onEditProvider?: (providerId: string) => void;
  /** Alt+E pressed on a managed source row — the host shows the guard message. */
  readonly onEditGuard?: (label: string) => void;
  readonly onClose: () => void;
}

/** Real (non-synthetic) source row. */
interface SourceRow {
  readonly kind: 'source';
  readonly id: string;
  readonly label: string;
  readonly providerIds: readonly string[];
  /** True when one of `providerIds` is the active provider. */
  readonly hasActive: boolean;
  /** Optional base URL extracted from the provider config. */
  readonly baseUrl?: string;
  /** True for a standalone, user-maintained provider (Alt+E can edit it). */
  readonly custom: boolean;
}

/** Synthetic `[ Add New Platform ]` action row pinned to the bottom. */
interface AddRow {
  readonly kind: 'add';
  readonly id: '__add__';
  readonly label: string;
}

type Row = SourceRow | AddRow;

const ADD_ROW_LABEL_KEY = 'dialogs.provider.addPlatform';
const PAGE_SIZE = 8;

// Narrows a `ProviderConfig` blob to a `CustomRegistrySource` payload.
// Kept local to the component: importing the host's copy would create a
// cyclic dependency on the component's container; duplicating ~15 lines is
// cheap.
function readCustomRegistrySource(provider: unknown): CustomRegistrySource | undefined {
  if (typeof provider !== 'object' || provider === null) return undefined;
  const source = (provider as { readonly source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source as {
    readonly kind?: unknown;
    readonly url?: unknown;
    readonly apiKey?: unknown;
  };
  if (candidate.kind !== 'apiJson') return undefined;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return undefined;
  if (typeof candidate.apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url: candidate.url, apiKey: candidate.apiKey };
}

/**
 * Pretty-print a URL for the source-row label. Strips the scheme and
 * truncates obvious api.json suffixes so the row stays narrow. Falls
 * back to the raw URL if parsing fails.
 */
function sourceUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/**
 * Group providers into source rows + append the synthetic add-row.
 * The grouping rules:
 *   - `managed:*` (OAuth service providers) → skipped (managed via /login).
 *   - Open Platform id (`isOpenPlatformId(id)`) → 1 source per provider,
 *     label = `OpenPlatformDefinition.name`.
 *   - `cfg.source.kind === 'apiJson'` → one source per `{url, apiKey}`
 *     pair, label = hostname + pathname.
 *   - Anything else → 1 source per provider, label = provider id.
 */
function buildRows(opts: ProviderManagerOptions): readonly Row[] {
  const sources: SourceRow[] = [];

  // Map from `${url}${apiKey}` → index into `sources`, so we can
  // append further providers into the same group.
  const customRegistryIndex = new Map<string, number>();

  for (const [id, cfg] of Object.entries(opts.providers)) {
    if (id.startsWith('managed:')) continue;

    const isActive = id === opts.activeProviderId;

    if (isOpenPlatformId(id)) {
      const platform = getOpenPlatformById(id);
      sources.push({
        kind: 'source',
        id: `open:${id}`,
        label: platform?.name ?? id,
        providerIds: [id],
        hasActive: isActive,
        custom: false,
      });
      continue;
    }

    const baseUrl =
      typeof cfg === 'object' && cfg !== null && 'baseUrl' in cfg && typeof cfg.baseUrl === 'string'
        ? cfg.baseUrl
        : undefined;

    const customSource = readCustomRegistrySource(cfg);
    if (customSource !== undefined) {
      const key = `${customSource.url}${customSource.apiKey}`;
      const existingIdx = customRegistryIndex.get(key);
      if (existingIdx !== undefined) {
        const existing = sources[existingIdx];
        if (existing !== undefined && existing.kind === 'source') {
          sources[existingIdx] = {
            kind: 'source',
            id: existing.id,
            label: existing.label,
            providerIds: [...existing.providerIds, id],
            hasActive: existing.hasActive || isActive,
            baseUrl: existing.baseUrl,
            custom: false,
          };
        }
        continue;
      }
      customRegistryIndex.set(key, sources.length);
      sources.push({
        kind: 'source',
        id: `custom:${key}`,
        label: sourceUrlLabel(customSource.url),
        providerIds: [id],
        hasActive: isActive,
        baseUrl,
        custom: false,
      });
      continue;
    }

    sources.push({
      kind: 'source',
      id: `provider:${id}`,
      // The two service-real-name exceptions (Kimi Code, ChatGPT Codex) label
      // by their proper service name; every other provider shows its id.
      label: providerServiceName(id) ?? id,
      providerIds: [id],
      hasActive: isActive,
      baseUrl,
      custom: isCustomProvider(id, cfg),
    });
  }

  return [...sources, { kind: 'add', id: '__add__', label: ADD_ROW_LABEL_KEY }];
}

function rowSearchText(row: Row): string {
  if (row.kind === 'add') return '';
  return `${row.label} ${row.providerIds.join(' ')} ${row.baseUrl ?? ''}`;
}

export class ProviderManagerComponent extends Container implements Focusable {
  focused = false;
  private opts: ProviderManagerOptions;
  private readonly list: SearchableList<Row>;
  private confirm: ConfirmState | undefined;
  /** The dialog skeleton owning the chrome (divider/title/hint) and its row
   * math. The hint goes in as raw segments, so the frame wraps it at
   * segment boundaries and applies the default muted styling. */
  private readonly frame = new DialogFrame({
    minSize: inlineDialogMinSize(),
  });
  /** Frame-relative hit zones of the last render (source + add rows) —
   * served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Hovered row index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState<HitZoneId>();

  constructor(opts: ProviderManagerOptions) {
    super();
    this.opts = opts;
    const rows = buildRows(opts);
    const activeIdx = opts.activeProviderId
      ? rows.findIndex(
          (row) => row.kind === 'source' && row.providerIds.includes(opts.activeProviderId ?? ''),
        )
      : -1;
    this.list = new SearchableList<Row>({
      items: rows,
      toSearchText: rowSearchText,
      pageSize: PAGE_SIZE,
      initialIndex: Math.max(activeIdx, 0),
      searchable: true,
    });
    this.confirm = undefined;
  }

  /**
   * Replace the props the component renders against. The selection follows
   * the previously selected row (by id) so deletions don't visually jump,
   * and any in-flight `[y/N]` substate is cleared because the underlying
   * target may have changed.
   */
  setOptions(next: ProviderManagerOptions): void {
    this.opts = next;
    this.confirm = undefined;
    this.list.updateItems(buildRows(next), (row) => row.id);
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.confirm !== undefined) {
      this.handleConfirmInput(data);
      return;
    }

    // Legacy ESC-prefixed Alt bytes → CSI-u when Kitty is active (see
    // utils/legacy-meta-key) so Alt+E/D arrive in every terminal.
    const normalized = normalizeLegacyMetaKey(data);

    if (matchesKey(normalized, Key.escape)) {
      // Searchable-dialog layering: clear the query → unselect the search
      // box → close.
      this.frame.handleEscape(this.list, this.opts.onClose);
      this.invalidate();
      return;
    }

    if (matchesKey(normalized, Key.enter)) {
      const selected = this.list.selected();
      if (selected?.kind === 'add') {
        this.opts.onAdd();
      } else if (selected?.kind === 'source' && selected.providerIds[0] !== undefined) {
        this.opts.onViewModels?.(selected.providerIds[0]);
      }
      return;
    }

    // Manage actions: Alt+D arms the inline delete confirm, Alt+E edits a
    // custom provider, Alt+A adds a model under it (the keyboard contract's
    // canonical Alt+letter manage keys, same as the /model picker). The
    // pre-contract bare E/D stay as silent aliases for one release. While
    // the search box is selected, printable keys edit the query instead.
    const searchFocused = this.list.view().searchFocused;
    const ch = printableChar(normalized);
    if (matchesKey(normalized, Key.alt('d')) || (!searchFocused && (ch === 'd' || ch === 'D'))) {
      this.armDeleteConfirm();
      return;
    }
    if (matchesKey(normalized, Key.alt('e')) || (!searchFocused && (ch === 'e' || ch === 'E'))) {
      this.fireEdit();
      return;
    }
    if (matchesKey(normalized, Key.alt('a'))) {
      this.fireAddModel();
      return;
    }

    if (this.list.handleKey(normalized)) this.invalidate();
  }

  private fireEdit(): void {
    const selected = this.list.selected();
    if (selected === undefined || selected.kind === 'add') return;
    if (selected.custom && selected.providerIds[0] !== undefined) {
      this.opts.onEditProvider?.(selected.providerIds[0]);
      return;
    }
    this.opts.onEditGuard?.(selected.label);
  }

  private fireAddModel(): void {
    const selected = this.list.selected();
    if (selected === undefined || selected.kind === 'add') return;
    if (selected.custom && selected.providerIds[0] !== undefined) {
      this.opts.onAddModel?.(selected.providerIds[0]);
      return;
    }
    this.opts.onAddModelGuard?.(selected.label);
  }

  /** Hover-to-scroll: the wheel moves the highlight one row per tick, clamped
   * like ↑/↓. Press and hover targeting is declared as hit zones (see
   * renderContent); the TUI dispatches zone presses to {@link onHitZone} and
   * tracks the hovered zone via {@link setHoveredZone}. This handler keeps the
   * wheel behavior and routes presses/motion arriving outside the zone
   * dispatch (e.g. direct component-relative events) through the same zones.
   * All mouse input is ignored while the delete confirmation is armed. */
  handleMouse(event: MouseEvent): void | boolean {
    if (this.confirm !== undefined) return false;
    if (event.type === 'wheel') {
      const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
      if (delta === 0) return false;
      const view = this.list.view();
      if (delta < 0) this.list.moveUp();
      else this.list.moveDown();
      if (this.list.view().selectedIndex === view.selectedIndex) return false;
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
   * row press moves the cursor onto it — a press on the already-highlighted
   * row fires its Enter action (view the provider's models / fire the add
   * row), the uniform re-click-confirms idiom.
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      this.list.focusSearch();
      this.invalidate();
      return;
    }
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    if (hit === view.selectedIndex && !view.searchFocused) {
      const selected = this.list.selected();
      if (selected?.kind === 'add') this.opts.onAdd();
      else if (selected?.kind === 'source' && selected.providerIds[0] !== undefined) {
        this.opts.onViewModels?.(selected.providerIds[0]);
      }
      return;
    }
    this.list.selectIndex(hit);
    this.invalidate();
  }

  /** Zone hover: the hovered row's label underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  private armDeleteConfirm(): void {
    const selected = this.list.selected();
    if (selected === undefined || selected.kind === 'add') return;
    const models = this.opts.models ?? {};
    const providerIds = new Set(selected.providerIds);
    this.confirm = {
      rowLabel: selected.label,
      providerIds: selected.providerIds,
      modelAliases: Object.entries(models)
        .filter(([, model]) => providerIds.has(model.provider))
        .map(([alias]) => alias),
    };
    this.invalidate();
  }

  private handleConfirmInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.confirm = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      const confirm = this.confirm;
      this.confirm = undefined;
      this.invalidate();
      if (confirm === undefined) return;
      this.opts.onDeleteSource(confirm.providerIds);
      return;
    }
    // Any other key while in the confirm substate is ignored.
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const view = this.list.view();
    const { lines, zones } = this.renderContent(width);
    // Header shape mirrors the model dialog (see model-selector.ts): a single
    // top border, the title, the keymap hint, then a blank line. No inner
    // border under the title.
    const hints = [t('common.hint.navigate')];
    if (view.page.pageCount > 1) hints.push(t('common.hint.page'));
    hints.push(t('dialogs.provider.hint.view'), t('common.hint.searchFocus'));
    if (this.opts.onEditProvider !== undefined) hints.push(t('dialogs.provider.hint.edit'));
    if (this.opts.onAddModel !== undefined) hints.push(t('dialogs.provider.hint.addModel'));
    hints.push(t('dialogs.provider.hint.delete'), t('common.hint.cancel'));

    const footer: string[] = [''];
    if (this.confirm !== undefined) {
      footer.push(...this.renderConfirmLines(width));
    } else if (view.page.pageCount > 1) {
      footer.push(
        currentTheme.fg(
          'textMuted',
          ` ${t('common.pageIndicator', { page: view.page.page + 1, total: view.page.pageCount })}`,
        ),
      );
    }

    const frameLines = this.frame.render(width, {
      title: t('dialogs.provider.title'),
      hintParts: hints,
      content: lines,
      footer,
      // While the delete confirm owns the dialog, the mouse is inert — so no
      // search zone is declared either (zone dispatch bypasses handleMouse).
      ...(this.confirm === undefined
        ? {
            search: {
              query: view.query,
              focused: view.searchFocused,
              placeholder: t('dialogs.provider.searchPlaceholder'),
            },
          }
        : {}),
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (between the hint's blank line and the footer): one
   * row per source plus the synthetic add row, each on a label row plus an
   * optional base-URL row (same math as renderRow). Returns the lines plus
   * the content-relative hit zones (row 0 = first content line); while the
   * delete confirmation is armed the dialog ignores the mouse, so no zones
   * are declared.
   */
  private renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const lines: string[] = [];
    const zones: HitZone[] = [];
    const view = this.list.view();
    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', t('dialogs.provider.empty')));
      return { lines, zones };
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const row = view.items[i];
      if (row === undefined) continue;
      const rowStart = lines.length;
      const rowLines = renderRow(row, { isSelected: i === view.selectedIndex, width });
      // Hover underline on the row's label line (mouse motion).
      if (this.hover.isHovered(i) && rowLines.length > 0) {
        rowLines[0] = underlineText(rowLines[0]!, true);
      }
      lines.push(...rowLines);
      if (this.confirm === undefined) {
        zones.push({ id: i, row: rowStart, col: 1, width, height: lines.length - rowStart });
      }
    }
    return { lines, zones };
  }

  private renderConfirmLines(width: number): string[] {
    const confirm = this.confirm;
    if (confirm === undefined) return [];
    const count = confirm.providerIds.length;
    const prompt =
      count === 1
        ? t('dialogs.provider.confirm.one', { label: confirm.rowLabel })
        : t('dialogs.provider.confirm.many', { label: confirm.rowLabel, count });
    const lines = [truncateToWidth(currentTheme.boldFg('warning', `  ${prompt} [y/N]`), width, '…')];
    // Deleting a provider cascades to its models (removeCloudCodeProvider) —
    // spell out the impact before the user confirms.
    const modelCount = confirm.modelAliases.length;
    if (modelCount > 0) {
      const shown = confirm.modelAliases.slice(0, 3).join(', ');
      const list =
        modelCount > 3
          ? t('dialogs.provider.confirm.modelListMore', { list: shown, count: modelCount - 3 })
          : shown;
      const impact =
        modelCount === 1
          ? t('dialogs.provider.confirm.models.one', { list })
          : t('dialogs.provider.confirm.models.other', { count: modelCount, list });
      lines.push(truncateToWidth(currentTheme.fg('warning', `  ${impact}`), width, '…'));
    }
    return lines;
  }
}


function renderRow(
  row: Row,
  ctx: { isSelected: boolean; width: number },
): string[] {
  const { isSelected, width } = ctx;
  const pointer = isSelected ? SELECT_POINTER : ' ';
  const pointerStyle = (text: string) =>
    isSelected ? currentTheme.fg('primary', text) : currentTheme.fg('textDim', text);
  // The synthetic "Add New Platform" row is an action/CTA: keep it in the brand
  // color so it never reads as disabled, and bold it when selected (matching
  // the other rows' selected treatment).
  const labelStyle = (text: string) =>
    isSelected
      ? currentTheme.boldFg('primary', text)
      : row.kind === 'add'
        ? currentTheme.fg('primary', text)
        : currentTheme.fg('text', text);

  // The active provider is flagged with a trailing "← current" (success),
  // matching the model selector's current-item marker — see docs/tui-design.md.
  const isActive = row.kind === 'source' && row.hasActive;
  const marker = isActive ? ` ${t('common.currentMark')}` : '';
  // Custom (standalone, user-maintained) providers get a badge so the rows
  // the Alt+E key can edit are identifiable.
  const badge = row.kind === 'source' && row.custom ? ` ${t('dialogs.provider.customBadge')}` : '';

  // The add-row stores its i18n key in `label`; resolve it at render time so
  // a locale hot-switch re-renders it in the new language.
  const rowLabel = row.kind === 'add' ? t('dialogs.provider.addPlatform') : row.label;

  // Reserve 2 leading spaces + 2 for the pointer + room for the markers.
  const labelWidth = Math.max(0, width - 4 - visibleWidth(marker) - visibleWidth(badge));
  const labelText = truncateToWidth(rowLabel, labelWidth, '…');
  let line = `  ${pointerStyle(`${pointer} `)}${labelStyle(labelText)}`;
  if (badge.length > 0) line += currentTheme.fg('textMuted', badge);
  if (isActive) line += currentTheme.fg('success', marker);

  const lines: string[] = [line];

  if (row.kind === 'source' && row.baseUrl !== undefined && row.baseUrl.length > 0) {
    const urlText = truncateToWidth(row.baseUrl, Math.max(0, width - 6), '…');
    lines.push(currentTheme.fg('textMuted', `      ${urlText}`));
  }

  return lines;
}
