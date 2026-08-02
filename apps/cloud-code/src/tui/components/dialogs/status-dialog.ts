/**
 * StatusDialogComponent — the `/status` tabbed dialog (Status | Kimi Code |
 * ChatGPT | Stats), modeled on `PluginsPanelComponent`: divider frame, hint
 * line, shared `renderTabStrip`, Tab/Shift-Tab cycling, Esc to close.
 *
 * Tab bodies are the pure line builders from `components/messages/` (rebuilt
 * on every render, so theme/locale hot-switches repaint without explicit
 * invalidation):
 *   • Status   — `buildStatusTabLines` (global session facts + context bar)
 *   • Kimi Code — `buildKimiAccountTabLines` (account, plan/wallet, usage)
 *   • ChatGPT  — `buildChatGptAccountTabLines` (codex-card account + limits)
 *   • Stats    — `buildStatsTabLines` (activity chart + aggregates)
 *
 * The Stats tab owns an extra range switch: `d`/`w`/`c` jumps to
 * daily/weekly/cumulative, `r` cycles, and clicking the range word in the
 * selector line switches too (codex `/usage [daily|weekly|cumulative]`
 * parity); hovering a range word paints the `hoverBackground` background
 * (the shared word-affordance hover idiom).
 *
 * The ChatGPT tab owns the reset-credit redeem flow (when a controller is
 * wired and the usage read reports resets): `r` or clicking the count line
 * arms an inline `[y/N]` confirm (provider-manager idiom — y confirms,
 * n/Esc disarms, other keys swallowed), `y` consumes one credit, and the
 * outcome lands as a notice line under the count (success also refreshes
 * the tab's usage data via the controller).
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';
import type {
  CodexResetCredit,
  ConsumeCodexResetCreditResult,
} from '@cloud-code/oauth';
import chalk from 'chalk';

import {
  buildStatusTabLines,
  type StatusTabOptions,
} from '#/tui/components/messages/status-panel';
import {
  buildStatsTabLines,
  statsRangeWordSpans,
} from '#/tui/components/messages/stats-panel';
import {
  buildChatGptAccountTabLines,
  buildKimiAccountTabLines,
  selectRedeemableCredits,
  type ChatGptAccountTabOptions,
  type ChatGptRedeemNotice,
  type ChatGptRedeemView,
  type ChatGptTabLayout,
  type KimiAccountTabOptions,
} from '#/tui/components/messages/usage-panel';
import type {
  TokenActivityBucket,
  TokenActivityView,
} from '#/tui/components/messages/token-activity-chart';
import { resolveDescription, t } from '#/tui/i18n';
import type { TokenActivityStats } from '#/tui/services/token-activity';
import { currentTheme } from '#/tui/theme';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { wrapHintText } from '#/tui/utils/hint';
import { HoverState } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { renderTabStrip, tabStripHitZones } from '#/tui/utils/tab-strip';

export type StatusDialogTab = 'status' | 'kimi' | 'chatgpt' | 'stats';

const STATUS_DIALOG_TABS: readonly { id: StatusDialogTab; label: string }[] = [
  { id: 'status', label: 'panels.status.tab.status' },
  { id: 'kimi', label: 'panels.status.tab.kimi' },
  { id: 'chatgpt', label: 'panels.status.tab.chatgpt' },
  { id: 'stats', label: 'panels.status.tab.stats' },
];

const RANGE_ORDER: readonly TokenActivityView[] = ['daily', 'weekly', 'cumulative'];

export interface StatusDialogStatsData {
  /** undefined → the wire-log walk is still running (loading placeholder). */
  readonly buckets?: readonly TokenActivityBucket[] | undefined;
  /** undefined → the aggregate stats are still loading (placeholder). */
  readonly stats?: TokenActivityStats | undefined;
}

/**
 * Async endpoints of the ChatGPT reset-credit redeem flow, wired by the
 * command layer (info.ts). The dialog owns the armed-confirm state machine;
 * the controller owns the network and the post-success usage refresh.
 */
export interface StatusDialogRedeemController {
  /** List-endpoint read feeding the confirm detail lines (throws → bare confirm). */
  readonly preview: () => Promise<readonly CodexResetCredit[]>;
  /**
   * Consume one credit. The idempotency key is minted by the caller per
   * invocation, so each confirmed attempt carries its own redeem_request_id.
   */
  readonly consume: (creditId: string | undefined) => Promise<ConsumeCodexResetCreditResult>;
  /** Repaint hook for the async state transitions. */
  readonly requestRender: () => void;
  /** Bust the cached usage read and refetch so the tab repaints fresh quota. */
  readonly refreshUsage: () => void;
}

export interface StatusDialogOptions {
  readonly initialTab?: StatusDialogTab | undefined;
  readonly status: StatusTabOptions;
  readonly kimi: KimiAccountTabOptions;
  readonly chatgpt: ChatGptAccountTabOptions;
  readonly stats: StatusDialogStatsData;
  /** Present → the ChatGPT tab offers the reset-credit redeem action. */
  readonly redeemResetCredit?: StatusDialogRedeemController | undefined;
  readonly onCancel: () => void;
}

/** Partial per-section data delivered as async loads resolve (see update). */
export interface StatusDialogUpdate {
  readonly status?: Partial<StatusTabOptions>;
  readonly kimi?: Partial<KimiAccountTabOptions>;
  readonly chatgpt?: Partial<ChatGptAccountTabOptions>;
  readonly stats?: Partial<StatusDialogStatsData>;
}

export class StatusDialogComponent extends Container implements Focusable {
  focused = false;

  private opts: StatusDialogOptions;
  private activeTabIndex: number;
  private statsRangeIndex = 0;
  /** Hovered tab index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** Hovered Stats range-selector word; null when the pointer is elsewhere. */
  private readonly rangeHover = new HoverState();
  /** Hovered ChatGPT redeem action row; null when the pointer is elsewhere. */
  private readonly redeemHover = new HoverState();
  /**
   * Armed redeem attempt (loading → confirm → busy); undefined = idle. The
   * `attempt` counter invalidates async settles from superseded attempts.
   */
  private redeem:
    | {
        phase: 'loading' | 'confirm' | 'busy';
        attempt: number;
        /** available_count captured at arm time (the confirm text's N). */
        count: number;
        /** List-endpoint credits; undefined → bare confirm (redeem directly). */
        credits?: readonly CodexResetCredit[] | undefined;
      }
    | undefined;
  private redeemAttempt = 0;
  /** Outcome feedback of the last attempt, shown under the count line. */
  private redeemNotice: ChatGptRedeemNotice | undefined;
  /** Component-relative hit zones of the last render (the tab cells plus,
   * while visible, the Stats range words) — served from hitZones(). */
  private frameZones: HitZone[] = [];

  /** Component-relative row of the Stats range selector (first body line). */
  private static readonly RANGE_ROW = 6;

  /** Hit-zone id of the ChatGPT reset-credit redeem action row. */
  private static readonly REDEEM_ZONE_ID = 'redeem';

  constructor(opts: StatusDialogOptions) {
    super();
    this.opts = opts;
    this.activeTabIndex = Math.max(
      0,
      STATUS_DIALOG_TABS.findIndex((tab) => tab.id === (opts.initialTab ?? 'status')),
    );
  }

  private get activeTab(): (typeof STATUS_DIALOG_TABS)[number] {
    return STATUS_DIALOG_TABS[this.activeTabIndex]!;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // Esc layering: an armed redeem confirm/loading peels first, a second
      // Esc closes. During the busy consume Esc closes outright — the attempt
      // still lands, and the memo bust keeps the next open fresh.
      if (this.redeem !== undefined && this.redeem.phase !== 'busy') {
        this.cancelRedeem();
        return;
      }
      this.opts.onCancel();
      return;
    }
    // An armed redeem attempt swallows every other key (Tab included) except
    // its own y/n — the provider-manager armed-confirm idiom.
    if (this.redeem !== undefined) {
      this.handleRedeemInput(data);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex = (this.activeTabIndex + 1) % STATUS_DIALOG_TABS.length;
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + STATUS_DIALOG_TABS.length) % STATUS_DIALOG_TABS.length;
      return;
    }
    if (this.activeTab.id === 'chatgpt') {
      const ch = printableChar(data);
      if ((ch === 'r' || ch === 'R') && this.redeemOffered()) this.armRedeem();
      return;
    }
    if (this.activeTab.id !== 'stats') return;
    const ch = printableChar(data);
    if (ch === 'd' || ch === 'D') {
      this.statsRangeIndex = 0;
    } else if (ch === 'w' || ch === 'W') {
      this.statsRangeIndex = 1;
    } else if (ch === 'c' || ch === 'C') {
      this.statsRangeIndex = 2;
    } else if (ch === 'r' || ch === 'R') {
      this.statsRangeIndex = (this.statsRangeIndex + 1) % RANGE_ORDER.length;
    }
  }

  // -------------------------------------------------------------------------
  // ChatGPT reset-credit redeem flow (armed inline [y/N] confirm)
  // -------------------------------------------------------------------------

  /** The action is offered with fresh data reporting resets and a wired controller. */
  private redeemOffered(): boolean {
    if (this.opts.redeemResetCredit === undefined) return false;
    if (this.opts.chatgpt.account?.state !== 'logged-in') return false;
    const count = this.opts.chatgpt.codexUsage?.resetCreditsAvailable;
    return count !== null && count !== undefined && count > 0;
  }

  /** r / click on the action row: fetch the credit list for the confirm text. */
  private armRedeem(): void {
    const controller = this.opts.redeemResetCredit;
    const count = this.opts.chatgpt.codexUsage?.resetCreditsAvailable;
    if (controller === undefined || count === null || count === undefined || count <= 0) return;
    const attempt = ++this.redeemAttempt;
    this.redeem = { phase: 'loading', attempt, count };
    this.redeemNotice = undefined;
    this.redeemHover.update(null);
    this.invalidate();
    const settle = (credits: readonly CodexResetCredit[] | undefined): void => {
      if (this.redeem?.attempt !== attempt) return;
      // A list-endpoint failure degrades to a bare confirm that redeems
      // without a credit_id (the backend picks the credit).
      this.redeem = { phase: 'confirm', attempt, count, credits };
      this.invalidate();
      controller.requestRender();
    };
    void controller.preview().then(settle, () => {
      settle(undefined);
    });
  }

  private cancelRedeem(): void {
    this.redeem = undefined;
    // Invalidate the async settle of the cancelled attempt.
    this.redeemAttempt += 1;
    this.invalidate();
  }

  private handleRedeemInput(data: string): void {
    const redeem = this.redeem;
    if (redeem === undefined || redeem.phase !== 'confirm') return;
    const ch = printableChar(data);
    if (ch === 'n' || ch === 'N') {
      this.cancelRedeem();
      return;
    }
    if (ch === 'y' || ch === 'Y') {
      void this.confirmRedeem();
    }
    // Any other key while armed is ignored.
  }

  /** y: consume the earliest-expiring available credit (codex's picker order). */
  private async confirmRedeem(): Promise<void> {
    const controller = this.opts.redeemResetCredit;
    const redeem = this.redeem;
    if (controller === undefined || redeem === undefined || redeem.phase !== 'confirm') return;
    const attempt = redeem.attempt;
    const creditId = selectRedeemableCredits(redeem.credits ?? [])[0]?.id;
    this.redeem = { phase: 'busy', attempt, count: redeem.count };
    this.invalidate();
    controller.requestRender();
    const finish = (notice: ChatGptRedeemNotice, refresh: boolean): void => {
      if (this.redeem?.attempt !== attempt) return;
      this.redeem = undefined;
      this.redeemNotice = notice;
      if (refresh) controller.refreshUsage();
      this.invalidate();
      controller.requestRender();
    };
    try {
      const result = await controller.consume(creditId);
      switch (result.code) {
        case 'reset':
        case 'already_redeemed':
          finish({ tone: 'success', text: t('panels.usage.codex.redeemSuccess') }, true);
          break;
        case 'nothing_to_reset':
          finish({ tone: 'muted', text: t('panels.usage.codex.redeemNothingToReset') }, false);
          break;
        case 'no_credit':
          // The count is stale — refresh so the action row disappears.
          finish({ tone: 'muted', text: t('panels.usage.codex.redeemNoCredit') }, true);
          break;
        default:
          finish(
            {
              tone: 'error',
              text: t('panels.usage.codex.redeemFailed', {
                error: result.rawCode ?? 'unknown',
              }),
            },
            false,
          );
      }
    } catch (error) {
      finish(
        {
          tone: 'error',
          text: t('panels.usage.codex.redeemFailed', { error: formatErrorMessage(error) }),
        },
        false,
      );
    }
  }

  /** Mouse is fully zone-dispatched: the tab cells (`tab:<index>`) and the
   * Stats range words (`range:<index>`, declared only while the selector is
   * visible) are hit zones — the TUI routes presses to {@link onHitZone} and
   * tracks the hovered zone via {@link setHoveredZone}. There is no raw
   * `handleMouse` fallback: motion is delivered to zone-aware components
   * exclusively through `setHoveredZone`, which is exactly why the range
   * words had to become real zones (a previous raw-path hover never fired in
   * the TUI — only in direct unit-test calls). The tab bodies are otherwise
   * read-only, so outside-zone presses and wheel events are no-ops. */

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zone press: a `tab:<index>` cell switches to that tab; a `range:<index>`
   * word switches the Stats chart range; the `redeem` action row arms the
   * ChatGPT reset-credit confirm (the `r` key's mouse equivalent). A press on
   * the active tab/range is a no-op. */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (typeof id !== 'string') return false;
    if (id === StatusDialogComponent.REDEEM_ZONE_ID) {
      if (!this.redeemOffered()) return false;
      this.armRedeem();
      return;
    }
    if (id.startsWith('tab:')) {
      const idx = Number(id.slice('tab:'.length));
      if (!Number.isInteger(idx) || idx < 0 || idx >= STATUS_DIALOG_TABS.length) return false;
      if (idx === this.activeTabIndex) return false;
      // Leaving the ChatGPT tab mid-attempt cancels the armed confirm.
      this.cancelRedeem();
      this.activeTabIndex = idx;
      this.hover.update(null);
      this.rangeHover.update(null);
      this.invalidate();
      return;
    }
    if (id.startsWith('range:')) {
      const idx = Number(id.slice('range:'.length));
      if (!Number.isInteger(idx) || idx < 0 || idx >= RANGE_ORDER.length) return false;
      if (idx === this.statsRangeIndex) return false;
      this.statsRangeIndex = idx;
      this.invalidate();
      return;
    }
    return false;
  }

  /** Zone hover: the hovered tab cell underlines, the hovered range word or
   * redeem action row paints its affordance; null clears all. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const tab = typeof id === 'string' && id.startsWith('tab:') ? Number(id.slice(4)) : null;
    const range = typeof id === 'string' && id.startsWith('range:') ? Number(id.slice(6)) : null;
    const redeem = id === StatusDialogComponent.REDEEM_ZONE_ID ? 0 : null;
    const tabChanged = this.hover.update(tab);
    const rangeChanged = this.rangeHover.update(range);
    const redeemChanged = this.redeemHover.update(redeem);
    if (tabChanged || rangeChanged || redeemChanged) this.invalidate();
    return tabChanged || rangeChanged || redeemChanged ? undefined : false;
  }

  /**
   * The range selector line only renders once resolved stats report activity
   * (loading/empty states replace it) — mirror the builder's gating so clicks
   * on those placeholder rows do nothing.
   */
  private rangeSelectorVisible(): boolean {
    if (this.activeTab.id !== 'stats') return false;
    const stats = this.opts.stats.stats;
    return stats !== undefined && stats.activeDays > 0;
  }

  /**
   * Merges newly resolved section data into the captured snapshot and
   * repaints. Only the data changes — the active tab, stats range, and hover
   * state are untouched, so the repaint never steals focus or resets the
   * user's place.
   */
  update(patch: StatusDialogUpdate): void {
    this.opts = {
      ...this.opts,
      status: { ...this.opts.status, ...patch.status },
      kimi: { ...this.opts.kimi, ...patch.kimi },
      chatgpt: { ...this.opts.chatgpt, ...patch.chatgpt },
      stats: { ...this.opts.stats, ...patch.stats },
    };
    this.invalidate();
  }

  /**
   * The ChatGPT tab's redeem display state, rebuilt per render like the rest
   * of the body. undefined when no controller is wired — the tab then renders
   * its plain read-only count line.
   */
  private redeemView(): ChatGptRedeemView | undefined {
    if (this.opts.redeemResetCredit === undefined) return undefined;
    const redeem = this.redeem;
    if (redeem !== undefined) {
      return {
        offered: true,
        phase: redeem.phase,
        count: redeem.count,
        credits: redeem.credits,
      };
    }
    return {
      offered: this.redeemOffered(),
      phase: 'idle',
      count: this.opts.chatgpt.codexUsage?.resetCreditsAvailable ?? 0,
      notice: this.redeemNotice,
      hovered: this.redeemHover.index !== null,
    };
  }

  override render(width: number): string[] {
    const colors = currentTheme.palette;
    const tab = this.activeTab.id;
    const hint = tab === 'stats' ? t('panels.status.hint.stats') : t('panels.status.hint');
    const labels = STATUS_DIALOG_TABS.map((panelTab) => resolveDescription(panelTab.label));
    const lines: string[] = [
      chalk.hex(colors.border)('─'.repeat(width)),
      chalk.hex(colors.border).bold(t('panels.status.dialogTitle')),
      // Wrap the key hint at segment boundaries so narrow widths keep every
      // advertised key (the stats-tab hint is the long one).
      ...wrapHintText(hint, width).map((line) => chalk.hex(colors.textMuted)(line)),
      '',
    ];
    const stripRow = lines.length;
    lines.push(
      renderTabStrip({
        labels,
        activeIndex: this.activeTabIndex,
        width,
        colors,
        hoverIndex: this.hover.index,
      }),
      '',
    );
    // Namespace the tab ids so they can never collide with row-level ids.
    this.frameZones = tabStripHitZones({
      labels,
      activeIndex: this.activeTabIndex,
      width,
      row: stripRow,
    }).map((zone) => ({ ...zone, id: `tab:${String(zone.id)}` }));
    // The Stats range words are zones too (one per word, from the same
    // layout math stats-panel renders with) — declared only while the
    // selector is actually on screen.
    if (this.rangeSelectorVisible()) {
      this.frameZones.push(
        ...statsRangeWordSpans().map((span, index) => ({
          id: `range:${String(index)}`,
          row: StatusDialogComponent.RANGE_ROW,
          col: span.col,
          width: span.width,
          height: 1,
        })),
      );
    }

    if (tab === 'status') {
      lines.push(...buildStatusTabLines(this.opts.status));
    } else if (tab === 'kimi') {
      lines.push(...buildKimiAccountTabLines(this.opts.kimi));
    } else if (tab === 'chatgpt') {
      const layout: ChatGptTabLayout = { redeemRow: null };
      lines.push(
        ...buildChatGptAccountTabLines(
          { ...this.opts.chatgpt, redeem: this.redeemView() },
          layout,
        ),
      );
      // The redeem action row is a hit zone while idle (r's mouse
      // equivalent); armed phases declare no zone — the confirm is
      // keyboard-only, mirroring the provider-manager delete confirm.
      if (layout.redeemRow !== null) {
        this.frameZones.push({
          id: StatusDialogComponent.REDEEM_ZONE_ID,
          row: StatusDialogComponent.RANGE_ROW + layout.redeemRow,
          col: 0,
          width,
          height: 1,
        });
      }
    } else {
      lines.push(
        ...buildStatsTabLines({
          buckets: this.opts.stats.buckets,
          stats: this.opts.stats.stats,
          view: RANGE_ORDER[this.statsRangeIndex] ?? 'daily',
          width: Math.max(8, width - 2),
          hoverRangeIndex: this.rangeHover.index,
        }),
      );
    }

    lines.push(chalk.hex(colors.border)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, '…'));
  }
}
