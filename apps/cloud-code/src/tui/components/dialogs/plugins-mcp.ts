/**
 * Plugin MCP server selector + the remove / install-trust confirmation
 * pickers for the /plugins flows. Split out of plugins-selector.ts (which
 * keeps the unified panel) to stay under the 800-line soft cap; shared
 * rendering helpers live in plugins-shared.ts.
 */

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
import type { PluginInfo, PluginMcpServerInfo } from '@cloud-code/sdk';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';

import { ChoicePickerComponent } from './choice-picker';
import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';
import {
  displayStatus,
  ELLIPSIS,
  mutedHintLine,
  sectionLabel,
  statusStyle,
  wrapOverviewDescription,
  type PluginsOverviewItem,
} from './plugins-shared';

const MCP_SERVER_PREFIX = 'mcp:';

const REMOVE_CONFIRM_CANCEL = 'cancel';
const REMOVE_CONFIRM_REMOVE = 'remove';
const INSTALL_TRUST_EXIT = 'exit';
const INSTALL_TRUST_TRUST = 'trust';

export type PluginMcpSelection =
  | { readonly kind: 'toggle'; readonly pluginId: string; readonly server: string; readonly enabled: boolean }
  | { readonly kind: 'back'; readonly pluginId: string };

export interface PluginMcpSelectorOptions {
  readonly info: PluginInfo;
  readonly selectedServer?: string;
  readonly serverHint?: {
    readonly server: string;
    readonly text: string;
  };
  readonly onSelect: (selection: PluginMcpSelection) => void;
  readonly onCancel: () => void;
}

export class PluginMcpSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginMcpSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;
  /** The dialog skeleton owning the chrome (divider/title/hint) and its row
   * math. The hint is flush-left in this dialog; it is pre-wrapped
   * (segment boundaries) and pre-styled by the dialog, so the frame leaves
   * the lines untouched. */
  private readonly frame = new DialogFrame({
    hintIndent: '',
    minSize: inlineDialogMinSize(),
    formatHintLine: (line) => line,
  });
  /** Frame-relative hit zones of the last render (server + action rows) —
   * served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Hovered item index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState<HitZoneId>();
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(opts: PluginMcpSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildMcpItems(opts.info);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${MCP_SERVER_PREFIX}${opts.selectedServer}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || printableChar(data) === ' ') {
      this.activateSelected();
    }
  }

  /** Mouse: the wheel moves the highlighted row, clamped like ↑/↓. Press and
   * hover targeting is declared as hit zones (see renderContent); the TUI
   * dispatches zone presses to {@link onHitZone} and tracks the hovered zone
   * via {@link setHoveredZone}. This handler keeps the wheel behavior and
   * routes presses/motion arriving outside the zone dispatch (e.g. direct
   * component-relative events) through the same zones. */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type === 'wheel') {
      const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
      if (delta === 0 || this.items.length === 0) return false;
      const next = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
      if (next === this.selectedIndex) return false;
      this.selectedIndex = next;
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

  /** Zone press: activate the hit row like Enter/Space (server rows toggle,
   * the Back row fires — activation IS the row action here) and move the
   * highlight onto it. */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const hit = typeof id === 'number' ? id : null;
    if (hit === null || hit < 0 || hit >= this.items.length) return false;
    this.selectedIndex = hit;
    this.activateSelected();
  }

  /** Zone hover: the hovered row's label underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  /** Enter/Space on the highlighted row (shared by keys and clicks). */
  private activateSelected(): void {
    const chosen = this.items[this.selectedIndex];
    if (chosen === undefined) return;
    if (chosen.value === 'back') {
      this.opts.onSelect({ kind: 'back', pluginId: this.opts.info.id });
      return;
    }
    const serverName = mcpItemServerName(chosen);
    if (serverName === undefined) return;
    const server = this.opts.info.mcpServers.find((item) => item.name === serverName);
    if (server === undefined) return;
    this.opts.onSelect({
      kind: 'toggle',
      pluginId: this.opts.info.id,
      server: server.name,
      enabled: !server.enabled,
    });
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const { info } = this.opts;
    const { lines, zones } = this.renderContent(width);
    const frameLines = this.frame.render(width, {
      title: t('plugins.mcp.title', { name: info.displayName }),
      // Wrapped raw at segment boundaries before styling (see the plugins
      // panel): narrow widths wrap the hint instead of clipping its tail.
      hintLines: wrapHintText(t('plugins.mcp.hint'), width).map((line) =>
        mutedHintLine(line, currentTheme.palette),
      ),
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  /**
   * The content region (everything between the hint's blank line and the
   * closing divider): the servers section label, the server items (or the
   * empty notice — not interactive), a blank, the actions section label, the
   * action items, and a trailing blank. Returns the lines plus the
   * content-relative hit zones (row 0 = first content line): one zone per
   * item, spanning its label and description rows.
   */
  private renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const { info } = this.opts;
    const colors = currentTheme.palette;
    const serverItems = this.items.filter((item) => item.kind === 'plugin');
    const actionItems = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      sectionLabel(
        t('plugins.mcp.section', {
          enabled: info.enabledMcpServerCount,
          total: info.mcpServerCount,
        }),
        colors,
      ),
    ];
    const zones: HitZone[] = [];

    if (serverItems.length === 0) {
      lines.push(chalk.hex(colors.textMuted)(t('plugins.mcp.empty')));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        const rowStart = lines.length;
        lines.push(...this.renderItem(serverItems[i]!, i, width));
        zones.push({ id: i, row: rowStart, col: 1, width, height: lines.length - rowStart });
      }
    }

    lines.push('');
    lines.push(sectionLabel(t('plugins.mcp.actions'), colors));
    for (let i = 0; i < actionItems.length; i++) {
      const rowStart = lines.length;
      lines.push(...this.renderItem(actionItems[i]!, serverItems.length + i, width));
      zones.push({
        id: serverItems.length + i,
        row: rowStart,
        col: 1,
        width,
        height: lines.length - rowStart,
      });
    }

    lines.push('');
    return { lines, zones };
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item, colors)(displayStatus(item.status));
    }
    const serverName = mcpItemServerName(item);
    if (serverName !== undefined && this.opts.serverHint?.server === serverName) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.serverHint.text);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [underlineText(line, this.hover.isHovered(index))];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return lines;
  }
}

export type PluginRemoveConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginRemoveConfirmOptions {
  readonly id: string;
  readonly displayName: string;
  readonly onDone: (result: PluginRemoveConfirmResult) => void;
}

export class PluginRemoveConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginRemoveConfirmOptions) {
    super({
      title: t('plugins.remove.title', { name: opts.displayName, id: opts.id }),
      hint: t('plugins.confirm.hint'),
      formatHint: mutedHintLine,
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: t('plugins.remove.cancel.label'),
          description: t('plugins.remove.cancel.description'),
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: t('plugins.remove.remove.label'),
          tone: 'danger',
          description: t('plugins.remove.remove.description'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === REMOVE_CONFIRM_REMOVE ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

export type PluginInstallTrustConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginInstallTrustConfirmOptions {
  /** Plugin display name or source, shown in the title for identification. */
  readonly label: string;
  readonly onDone: (result: PluginInstallTrustConfirmResult) => void;
}

/**
 * Confirmation shown before installing a third-party (unofficial) plugin.
 * Defaults to "Exit" so the user must explicitly switch to "Trust and install"
 * to proceed with a plugin that Kimi has not reviewed.
 */
export class PluginInstallTrustConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginInstallTrustConfirmOptions) {
    super({
      title: t('plugins.trust.title', { label: opts.label }),
      hint: t('plugins.confirm.hint'),
      formatHint: mutedHintLine,
      notice: t('plugins.trust.notice'),
      noticeTone: 'warning',
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: t('plugins.trust.exit.label'),
          description: t('plugins.trust.exit.description'),
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: t('plugins.trust.trust.label'),
          tone: 'danger',
          description: t('plugins.trust.trust.description'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === INSTALL_TRUST_TRUST ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

export type MarketplaceTrustConfirmResult = PluginInstallTrustConfirmResult;

export interface MarketplaceTrustConfirmOptions {
  /** Marketplace source, shown in the title for identification. */
  readonly label: string;
  readonly onDone: (result: MarketplaceTrustConfirmResult) => void;
}

/**
 * Confirmation shown before registering a third-party marketplace — same
 * trust precedent as third-party plugin installs: the catalog is fetched
 * (and git sources cloned) only after the user opts in.
 */
export class MarketplaceTrustConfirmComponent extends ChoicePickerComponent {
  constructor(opts: MarketplaceTrustConfirmOptions) {
    super({
      title: t('plugins.marketplaceTrust.title', { label: opts.label }),
      hint: t('plugins.confirm.hint'),
      formatHint: mutedHintLine,
      notice: t('plugins.marketplaceTrust.notice'),
      noticeTone: 'warning',
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: t('plugins.marketplaceTrust.exit.label'),
          description: t('plugins.marketplaceTrust.exit.description'),
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: t('plugins.marketplaceTrust.trust.label'),
          tone: 'danger',
          description: t('plugins.marketplaceTrust.trust.description'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === INSTALL_TRUST_TRUST ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

export type MarketplaceRemoveConfirmResult = PluginRemoveConfirmResult;

export interface MarketplaceRemoveConfirmOptions {
  readonly name: string;
  /**
   * Display names of installed plugins traced back to this marketplace, or
   * undefined when the catalog could not be loaded to check. Removing the
   * marketplace never uninstalls them — the notice says so either way.
   */
  readonly affectedPlugins?: readonly string[];
  readonly onDone: (result: MarketplaceRemoveConfirmResult) => void;
}

/** Confirmation for `/plugins marketplace remove`: cancel-first, like the
 * plugin remove dialog, plus a notice listing what stays installed. */
export class MarketplaceRemoveConfirmComponent extends ChoicePickerComponent {
  constructor(opts: MarketplaceRemoveConfirmOptions) {
    super({
      title: t('plugins.marketplaceRemove.title', { name: opts.name }),
      hint: t('plugins.confirm.hint'),
      formatHint: mutedHintLine,
      notice:
        opts.affectedPlugins === undefined
          ? t('plugins.marketplaceRemove.affectedUnknown')
          : opts.affectedPlugins.length === 0
            ? t('plugins.marketplaceRemove.affectedNone')
            : t('plugins.marketplaceRemove.affected', {
                plugins: opts.affectedPlugins.join(', '),
              }),
      noticeTone: 'warning',
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: t('plugins.marketplaceRemove.cancel.label'),
          description: t('plugins.marketplaceRemove.cancel.description'),
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: t('plugins.marketplaceRemove.remove.label'),
          tone: 'danger',
          description: t('plugins.marketplaceRemove.remove.description'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === REMOVE_CONFIRM_REMOVE ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => ({
    value: `${MCP_SERVER_PREFIX}${server.name}`,
    kind: 'plugin',
    label: server.name,
    status: server.enabled ? 'enabled' : 'disabled',
    description: mcpServerDescription(server),
  }));
  items.push({
    value: 'back',
    kind: 'action',
    label: t('plugins.mcp.back.label'),
    description: t('plugins.mcp.back.description'),
  });
  return items;
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled
    ? t('plugins.mcp.action.disable')
    : t('plugins.mcp.action.enable');
  if (server.transport === 'http' || server.transport === 'sse') {
    return `${action} · ${server.transport.toUpperCase()} · ${server.url ?? server.runtimeName}`;
  }
  const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  const command = `${server.command ?? ''}${args}`.trim();
  const cwd = server.cwd === undefined ? '' : ` · cwd ${server.cwd}`;
  return `${action} · stdio · ${command || server.runtimeName}${cwd}`;
}

function mcpItemServerName(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}
