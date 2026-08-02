/**
 * Per-account tab line builders for the `/status` dialog (Kimi Code and
 * ChatGPT tabs), plus the bordered `UsagePanelComponent` box used by
 * command-triggered panels (/mcp, /plugins).
 *
 * Both account tabs follow the codex /status card grammar
 * (codex-rs/tui/src/status/card.rs): `Label:` rows aligned to one value
 * column, `[████░░]` bars filled by the *remaining* quota with `NN% left`
 * text, and dimmed reset hints. The Kimi tab adds managed plan/wallet blocks;
 * the ChatGPT tab mirrors the codex card (Account/Plan rows, 5h + weekly
 * window rows, credits, capture age). ChatGPT quota data is the fresh
 * `/wham/usage` read when it lands (the same fetch codex's /status
 * performs); the `x-codex-*` response-header snapshot — with its stale
 * marker — remains the fallback when the endpoint read fails or is still in
 * flight.
 *
 * Session usage is split per account by attributing each `byModel` key to a
 * provider through `availableModels` (alias keys and resolved model ids both
 * resolve); models served by neither managed account are named in an honest
 * muted note instead of being silently dropped or guessed at.
 */

import type { Component } from '@cloud-code/pi-tui';
import { visibleWidth } from '@cloud-code/pi-tui';
import {
  CHATGPT_CODEX_PROVIDER_NAME,
  CLOUD_CODE_PROVIDER_NAME,
  formatDuration,
  type CodexPlanUsage,
  type CodexResetCredit,
} from '@cloud-code/oauth';
import type {
  ModelAlias,
  RateLimitSnapshot,
  SessionUsage,
  TokenUsage,
} from '@cloud-code/sdk';

import {
  formatCreditBalance,
  isRateLimitStale,
  rateLimitCapturedMinutes,
  rateLimitPercentLeft,
  rateLimitWindowKind,
  renderRateLimitBar,
  resetTimestampParts,
} from '#/utils/usage/rate-limit';
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import {
  columnWidth,
  padStartVisible,
  renderBox,
  renderRow,
  type RowCell,
} from '#/tui/components/primitives';
import { getActiveLocale, t } from '#/tui/i18n';
import { underlineText } from '#/tui/utils/mouse-hover';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;

type Colorize = (text: string) => string;

/** Login state of one managed account (kimi / ChatGPT Codex). */
export interface StatusTabAccount {
  readonly state: 'logged-in' | 'expired' | 'not-logged-in';
  /** ChatGPT only, from the stored id_token claims; kimi has none on file. */
  readonly email?: string | undefined;
  readonly planType?: string | undefined;
}

export interface ManagedUsageWindow {
  readonly duration: number;
  readonly unit: 'minute' | 'hour' | 'day' | 'week';
}

/** Structured managed plan-quota row (matches the OAuth layer's UsageRow). */
export interface ManagedUsageRow {
  readonly name?: string;
  readonly window?: ManagedUsageWindow;
  readonly used: number;
  readonly limit: number;
  readonly resetAt?: string;
}

export interface BoosterWalletInfo {
  readonly balanceCents: number;
  readonly totalCents: number;
  readonly monthlyChargeLimitEnabled: boolean;
  readonly monthlyChargeLimitCents: number;
  readonly monthlyUsedCents: number;
  readonly currency: string;
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null;
  readonly limits: readonly ManagedUsageRow[];
  readonly extraUsage?: BoosterWalletInfo | null;
}

/** Session-usage data shared by both account tabs (each slices its own side). */
interface AccountSessionUsageData {
  readonly sessionUsage?: SessionUsage | undefined;
  readonly sessionUsageError?: string | undefined;
  /** true while the session usage RPC is still in flight. */
  readonly sessionUsageLoading?: boolean | undefined;
  readonly availableModels: Record<string, ModelAlias>;
}

export interface KimiAccountTabOptions extends AccountSessionUsageData {
  /** undefined → the account snapshot is still loading (placeholder). */
  readonly account?: StatusTabAccount | undefined;
  readonly managedUsage?: ManagedUsageReport | undefined;
  readonly managedUsageError?: string | undefined;
  /** true while the managed usage endpoint call is still in flight. */
  readonly managedUsageLoading?: boolean | undefined;
}

export interface ChatGptAccountTabOptions extends AccountSessionUsageData {
  /** undefined → the account snapshot is still loading (placeholder). */
  readonly account?: StatusTabAccount | undefined;
  /**
   * Fresh plan usage from the `/wham/usage` endpoint read; takes precedence
   * over the header snapshot. null/undefined → render `rateLimit` instead.
   */
  readonly codexUsage?: CodexPlanUsage | null | undefined;
  /** true while the usage-endpoint read is still in flight. */
  readonly codexUsageLoading?: boolean | undefined;
  /**
   * Latest rate-limit snapshot from response headers; null when none
   * captured. The fallback quota source (kept with its stale marker) when
   * the endpoint read is unavailable.
   */
  readonly rateLimit?: RateLimitSnapshot | null | undefined;
  /**
   * Reset-credit redeem flow display state (status-dialog); undefined renders
   * the plain read-only count line.
   */
  readonly redeem?: ChatGptRedeemView | undefined;
  /** Wall clock for stale/reset/captured-at computation (test injection point). */
  readonly now?: number | undefined;
}

/** Outcome feedback of one redeem attempt, shown under the count line. */
export interface ChatGptRedeemNotice {
  readonly tone: 'success' | 'muted' | 'error';
  readonly text: string;
}

/** Display state of the reset-credit redeem flow on the ChatGPT tab. */
export interface ChatGptRedeemView {
  /** A redeem controller is wired — the idle count line gains the key hint. */
  readonly offered: boolean;
  readonly phase: 'idle' | 'loading' | 'confirm' | 'busy';
  /** Available count captured when the flow was armed (confirm line text). */
  readonly count: number;
  /** List-endpoint credits for the confirm detail lines; undefined = bare confirm. */
  readonly credits?: readonly CodexResetCredit[] | undefined;
  /** Outcome notice (idle phase only). */
  readonly notice?: ChatGptRedeemNotice | undefined;
  /** Mouse hover on the action row (underline affordance). */
  readonly hovered?: boolean | undefined;
}

/** Optional out-param of the ChatGPT tab builder: clickable-row geometry. */
export interface ChatGptTabLayout {
  /** Body-relative row of the redeem action line; null when it is not rendered. */
  redeemRow: number | null;
}

/** Session `byModel` split by serving provider. */
export interface SessionUsagePartition {
  readonly kimi: readonly (readonly [string, TokenUsage])[];
  readonly chatgpt: readonly (readonly [string, TokenUsage])[];
  /** Models served by neither managed account (BYOK or unresolvable). */
  readonly unattributed: readonly string[];
}

/**
 * Attribute each `byModel` key to a provider. Keys are resolved model ids at
 * record time (agent-core `UsageRecorder`), but alias keys resolve too — both
 * are looked up in `availableModels`.
 */
export function partitionSessionUsageByProvider(
  byModel: Record<string, TokenUsage>,
  availableModels: Record<string, ModelAlias>,
): SessionUsagePartition {
  const providerByModelKey = new Map<string, string>();
  for (const [alias, cfg] of Object.entries(availableModels)) {
    providerByModelKey.set(alias, cfg.provider);
    const resolved = cfg.model;
    if (typeof resolved === 'string' && resolved.length > 0 && !providerByModelKey.has(resolved)) {
      providerByModelKey.set(resolved, cfg.provider);
    }
  }
  const kimi: [string, TokenUsage][] = [];
  const chatgpt: [string, TokenUsage][] = [];
  const unattributed: string[] = [];
  for (const [model, usage] of Object.entries(byModel)) {
    const provider = providerByModelKey.get(model);
    if (provider === CLOUD_CODE_PROVIDER_NAME) kimi.push([model, usage]);
    else if (provider === CHATGPT_CODEX_PROVIDER_NAME) chatgpt.push([model, usage]);
    else unattributed.push(model);
  }
  return { kimi, chatgpt, unattributed };
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageInputTotal(usage: TokenUsage): number {
  return (
    usageNumber(usage.inputOther) +
    usageNumber(usage.inputCacheRead) +
    usageNumber(usage.inputCacheCreation)
  );
}

/** codex `title_case`: first character upper, remainder lower. */
function planTypeTitleCase(planType: string): string {
  const first = planType.charAt(0).toUpperCase();
  return first + planType.slice(1).toLowerCase();
}

/**
 * codex `Account: <email> (<plan>)`; a token without claims on file still
 * reports a bare 'Logged in' — never a fabricated identity.
 */
function formatAccountIdentity(account: StatusTabAccount): string {
  if (account.email === undefined) return t('panels.status.account.loggedIn');
  const plan = account.planType === undefined ? '' : ` (${planTypeTitleCase(account.planType)})`;
  return `${account.email}${plan}`;
}

/** Shared account-state gating for both account tabs. */
function accountGateLines(
  account: StatusTabAccount | undefined,
  loginPromptKey: 'panels.usage.loginPrompt.kimi' | 'panels.usage.loginPrompt.codex',
  muted: Colorize,
  errorStyle: Colorize,
): string[] | null {
  if (account === undefined) return [muted(`  ${t('common.loading')}`)];
  switch (account.state) {
    case 'expired':
      return [errorStyle(`  ${t('panels.status.account.expired')}`)];
    case 'not-logged-in':
      return [muted(`  ${t(loginPromptKey)}`)];
    case 'logged-in':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Session usage (per-provider slice)
// ---------------------------------------------------------------------------

function buildProviderSessionUsageLines(
  provider: 'kimi' | 'chatgpt',
  options: AccountSessionUsageData,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
): string[] {
  const lines: string[] = [accent(t('panels.usage.sessionUsage'))];
  if (options.sessionUsageLoading === true) {
    lines.push(muted(`  ${t('common.loading')}`));
    return lines;
  }
  if (options.sessionUsageError !== undefined) {
    lines.push(errorStyle(`  ${options.sessionUsageError}`));
    return lines;
  }
  const byModel = (options.sessionUsage as { readonly byModel?: Record<string, TokenUsage> } | undefined)
    ?.byModel;
  const partition = partitionSessionUsageByProvider(byModel ?? {}, options.availableModels);
  const entries = provider === 'kimi' ? partition.kimi : partition.chatgpt;
  if (entries.length === 0) {
    lines.push(
      muted(
        `  ${t('panels.usage.noSessionUsageFor', {
          label: provider === 'kimi' ? 'Kimi' : 'ChatGPT',
        })}`,
      ),
    );
  } else {
    let totalInput = 0;
    let totalOutput = 0;
    for (const [model, row] of entries) {
      const input = usageInputTotal(row);
      const output = usageNumber(row.output);
      totalInput += input;
      totalOutput += output;
      lines.push(
        renderRow(
          [
            { text: model, token: 'textDim' },
            {
              text: t('panels.usage.modelTokens', {
                input: value(formatTokenCount(input)),
                output: value(formatTokenCount(output)),
                total: value(formatTokenCount(input + output)),
              }),
            },
          ],
          { margin: 2 },
        ),
      );
    }
    if (entries.length > 1) {
      lines.push(
        renderRow(
          [
            { text: t('panels.usage.totalLabel'), token: 'textDim' },
            {
              text: t('panels.usage.modelTokens', {
                input: value(formatTokenCount(totalInput)),
                output: value(formatTokenCount(totalOutput)),
                total: value(formatTokenCount(totalInput + totalOutput)),
              }),
            },
          ],
          { margin: 2 },
        ),
      );
    }
  }
  if (partition.unattributed.length > 0) {
    lines.push(
      muted(
        `  ${t('panels.usage.sessionUnattributed', { models: partition.unattributed.join(', ') })}`,
      ),
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Kimi Code tab (managed plan quota + wallet)
// ---------------------------------------------------------------------------

/** Window size in hours for sort purposes; rows without a window sort last. */
function managedWindowHours(row: ManagedUsageRow): number {
  const window = row.window;
  if (window !== undefined) {
    if (window.unit === 'week') return 168;
    if (window.unit === 'day') return window.duration * 24;
    if (window.unit === 'hour') return window.duration;
    return window.duration / 60;
  }
  return Number.POSITIVE_INFINITY;
}

/** Localized label of a structured managed-usage row (`5h limit`, `Weekly limit`). */
function managedUsageRowLabel(row: ManagedUsageRow): string {
  const window = row.window;
  if (window !== undefined) {
    if (window.unit === 'week') return t('panels.usage.codex.window.weekly');
    const unit =
      window.unit === 'day'
        ? t('panels.usage.unit.day')
        : window.unit === 'hour'
          ? t('panels.usage.unit.hour')
          : t('panels.usage.unit.minute');
    return t('panels.usage.windowLimit', { count: String(window.duration), unit });
  }
  return row.name ?? 'Limit';
}

/** Localized reset hint derived from the row's ISO `resetAt`, if any. */
function managedUsageRowResetHint(row: ManagedUsageRow): string | undefined {
  const resetAt = row.resetAt;
  if (resetAt === undefined) return undefined;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return undefined;
  const diffSec = Math.floor((parsed - Date.now()) / 1000);
  if (diffSec <= 0) return t('panels.usage.resetNow');
  // Route through the English-hint localizer so duration parts localize too.
  return localizeResetHint(`resets in ${formatDuration(diffSec)}`);
}

/** Translate managed-usage reset hints (`resets in 14h 29m`, `resets at …`, `reset`). */
function localizeResetHint(hint: string): string {
  if (hint === 'reset') return t('panels.usage.resetNow');
  const at = /^resets at (.+)$/.exec(hint);
  if (at !== null) return t('panels.usage.resetsAt', { time: at[1]! });
  const within = /^resets in (.+)$/.exec(hint);
  if (within === null) return hint;
  const parts: string[] = [];
  for (const part of within[1]!.trim().split(/\s+/)) {
    const m = /^(\d+)([dhms])$/.exec(part);
    if (m === null) return hint;
    const unit =
      m[2] === 'd'
        ? t('panels.usage.unit.day')
        : m[2] === 'h'
          ? t('panels.usage.unit.hour')
          : m[2] === 'm'
            ? t('panels.usage.unit.minute')
            : t('panels.usage.unit.second');
    parts.push(`${m[1]!} ${unit}`);
  }
  return t('panels.usage.resetsIn', { duration: parts.join(' ') });
}

function severityColor(sev: 'ok' | 'warn' | 'danger'): 'success' | 'warning' | 'error' {
  return sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';
}

/**
 * Managed plan-quota rows in the codex window-row grammar: the bar is filled
 * by the remaining share and the text reads `NN% left`, matching the ChatGPT
 * tab. Shorter windows first (5h above weekly).
 */
function buildManagedUsageRows(usage: ManagedUsageReport): string[] {
  const { summary, limits } = usage;
  if (summary === null && limits.length === 0) {
    return [currentTheme.fg('textDim', `  ${t('panels.usage.noPlanUsage')}`)];
  }
  const rows: ManagedUsageRow[] = [];
  if (summary !== null) rows.push(summary);
  rows.push(...limits);
  const orderedRows = [...rows].sort((a, b) => managedWindowHours(a) - managedWindowHours(b));

  const remainingRatio = (r: ManagedUsageRow): number =>
    r.limit > 0 ? Math.max(0, Math.min(1 - r.used / r.limit, 1)) : 0;
  const formatPercentLeft = (r: ManagedUsageRow): string =>
    t('panels.usage.codex.percentLeft', { percent: Math.round(remainingRatio(r) * 100) });
  const labelWidth = columnWidth(
    orderedRows.map((r) => `${managedUsageRowLabel(r)}:`),
    10,
  );
  const pctWidth = columnWidth(orderedRows.map(formatPercentLeft));

  return orderedRows.map((row) => {
    const remaining = remainingRatio(row);
    const bar = renderProgressBar(remaining, 20);
    const barColored = currentTheme.fg(severityColor(ratioSeverity(1 - remaining)), bar);
    const cells: RowCell[] = [
      { text: `${managedUsageRowLabel(row)}:`, token: 'textDim', width: labelWidth },
      { text: barColored },
      { text: formatPercentLeft(row), token: 'text', width: pctWidth },
    ];
    const resetHint = managedUsageRowResetHint(row);
    if (resetHint !== undefined) cells.push({ text: resetHint, token: 'textDim' });
    return renderRow(cells, { margin: 2 });
  });
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥';
    case 'USD':
      return '$';
    default:
      return '';
  }
}

interface CurrencyParts {
  readonly symbol: string;
  readonly number: string;
}

function formatCurrencyParts(cents: number, currency: string): CurrencyParts {
  const symbol = currencySymbol(currency);
  const main = cents / 100;
  const formatted = main.toFixed(2);
  return symbol.length > 0
    ? { symbol, number: formatted }
    : { symbol: '', number: `${formatted} ${currency}` };
}

export function buildExtraUsageSection(
  extraUsage: BoosterWalletInfo | undefined | null,
  accent: Colorize,
): string[] {
  if (extraUsage === undefined || extraUsage === null) return [];

  const hasMonthlyLimit =
    extraUsage.monthlyChargeLimitEnabled && extraUsage.monthlyChargeLimitCents > 0;

  const balance = formatCurrencyParts(extraUsage.balanceCents, extraUsage.currency);
  const used = formatCurrencyParts(extraUsage.monthlyUsedCents, extraUsage.currency);
  const rows: Array<{ label: string; symbol: string; number: string }> = [];
  let barLine: string | null = null;

  if (hasMonthlyLimit) {
    const ratio = Math.max(
      0,
      Math.min(extraUsage.monthlyUsedCents / extraUsage.monthlyChargeLimitCents, 1),
    );
    const bar = renderProgressBar(ratio, 20);
    barLine = `  ${currentTheme.fg(severityColor(ratioSeverity(ratio)), bar)}`;
    const limit = formatCurrencyParts(extraUsage.monthlyChargeLimitCents, extraUsage.currency);
    rows.push({ label: t('panels.usage.usedThisMonth'), ...used });
    rows.push({ label: t('panels.usage.monthlyLimit'), ...limit });
    rows.push({ label: t('panels.usage.balance'), ...balance });
  } else {
    rows.push({ label: t('panels.usage.usedThisMonth'), ...used });
    rows.push({ label: t('panels.usage.monthlyLimit'), symbol: '', number: t('panels.usage.unlimited') });
    rows.push({ label: t('panels.usage.balance'), ...balance });
  }

  // `Used this month` is the longest label; size the column to the widest label
  // so the currency symbol starts in the same column on every row.
  const labelWidth = columnWidth(rows.map((r) => r.label));
  // Right-align the numeric part of currency rows against each other so the
  // decimal points line up (e.g. `¥ 50.00` / `¥200.00`). Text-only rows such as
  // `Unlimited` carry no currency symbol, so they must not widen the numeric
  // column — otherwise money values get padded with stray spaces.
  const numberWidth = Math.max(
    0,
    ...rows.filter((r) => r.symbol.length > 0).map((r) => visibleWidth(r.number)),
  );
  const row = (label: string, symbol: string, number: string): string => {
    const cell = symbol.length > 0 ? symbol + padStartVisible(number, numberWidth) : number;
    return renderRow(
      [
        { text: label, token: 'textDim', width: labelWidth },
        { text: cell, token: 'text' },
      ],
      { margin: 2 },
    );
  };

  const lines: string[] = [accent(t('panels.usage.extraUsageTitle'))];
  if (barLine !== null) lines.push(barLine);
  for (const r of rows) lines.push(row(r.label, r.symbol, r.number));

  return lines;
}

export function buildKimiAccountTabLines(options: KimiAccountTabOptions): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);

  const gated = accountGateLines(options.account, 'panels.usage.loginPrompt.kimi', muted, errorStyle);
  if (gated !== null) return gated;

  // Kimi tokens carry no account claims — the row reports the login state
  // only, never a fabricated email.
  const lines: string[] = [
    renderRow(
      [
        { text: `${t('panels.usage.account')}:`, token: 'textDim' },
        { text: t('panels.status.account.loggedIn'), token: 'text' },
      ],
      { margin: 2 },
    ),
  ];

  if (options.managedUsageLoading === true) {
    lines.push('', muted(`  ${t('common.loading')}`));
  } else if (options.managedUsageError !== undefined) {
    lines.push('', errorStyle(`  ${options.managedUsageError}`));
  } else if (options.managedUsage !== undefined) {
    lines.push('', ...buildManagedUsageRows(options.managedUsage));
  }

  const extraSection = buildExtraUsageSection(options.managedUsage?.extraUsage, accent);
  if (extraSection.length > 0) {
    lines.push('', ...extraSection);
  }

  lines.push('', ...buildProviderSessionUsageLines('kimi', options, accent, value, muted, errorStyle));
  return lines;
}

// ---------------------------------------------------------------------------
// ChatGPT tab (codex /status card grammar)
// ---------------------------------------------------------------------------

function codexWindowLabel(windowMinutes: number | null, isSecondary: boolean): string {
  switch (rateLimitWindowKind(windowMinutes)) {
    case '5h':
      return t('panels.usage.codex.window.5h');
    case 'daily':
      return t('panels.usage.codex.window.daily');
    case 'weekly':
      return t('panels.usage.codex.window.weekly');
    case 'monthly':
      return t('panels.usage.codex.window.monthly');
    case 'annual':
      return t('panels.usage.codex.window.annual');
    case 'other':
      return isSecondary
        ? t('panels.usage.codex.window.secondaryUsage')
        : t('panels.usage.codex.window.usage');
  }
}

function codexResetText(resetsAtSec: number, nowMs: number): string {
  const parts = resetTimestampParts(resetsAtSec, nowMs);
  if (parts.sameDay) {
    return t('panels.usage.codex.resetsToday', { time: parts.time });
  }
  // The calendar-day fragment is locale-shaped ("3 Aug" vs "8月3日"), so it is
  // composed here and passed as one {date} var — the placeholder-completeness
  // check requires identical var sets across locales.
  const date =
    getActiveLocale() === 'zh-CN'
      ? `${parts.month}月${parts.day}日`
      : `${parts.day} ${parts.monthName}`;
  return t('panels.usage.codex.resetsOnDay', { time: parts.time, date });
}

function codexCapturedText(snapshot: RateLimitSnapshot, nowMs: number): string {
  const minutes = rateLimitCapturedMinutes(snapshot.capturedAt, nowMs);
  const base =
    minutes < 1
      ? t('panels.usage.codex.capturedJustNow')
      : t('panels.usage.codex.captured', { minutes });
  return isRateLimitStale(snapshot.capturedAt, nowMs)
    ? `${base} (${t('panels.usage.codex.stale')})`
    : base;
}

interface CodexWindowRow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/**
 * Repack the fresh endpoint read into the header-snapshot display shape so
 * the card reuses one render path. The payload carries no `active-limit`
 * concept, so the Plan row renders the bare plan type for fresh data. An
 * all-empty payload yields null — an unrecognizable 200 must not
 * masquerade as a zeroed quota state (the header parser's contract).
 */
function snapshotFromCodexUsage(usage: CodexPlanUsage): RateLimitSnapshot | null {
  if (
    usage.planType === null &&
    usage.primary === null &&
    usage.secondary === null &&
    usage.credits === null
  ) {
    return null;
  }
  return {
    planType: usage.planType,
    activeLimit: null,
    primary: usage.primary,
    secondary: usage.secondary,
    credits: usage.credits,
    capturedAt: usage.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Reset-credit redeem flow (ChatGPT tab)
// ---------------------------------------------------------------------------

/**
 * The credits the redeem flow can consume: status `available`, soonest
 * expiry first (no-expiry last) — the same ordering codex's reset picker
 * applies, so the credit named in the confirm line is the one `y` redeems.
 */
export function selectRedeemableCredits(
  credits: readonly CodexResetCredit[],
): CodexResetCredit[] {
  return credits
    .filter((credit) => credit.status === 'available')
    .toSorted(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
    );
}

/** codex's picker fallbacks: untitled credits are a "Full reset". */
function redeemCreditTitle(credit: CodexResetCredit): string {
  return credit.title ?? t('panels.usage.codex.redeemDefaultTitle');
}

function redeemCreditDescription(credit: CodexResetCredit): string {
  return credit.description ?? t('panels.usage.codex.redeemDefaultDescription');
}

function redeemCreditExpiryText(credit: CodexResetCredit, nowMs: number): string {
  if (credit.expiresAt === null) return t('panels.usage.codex.redeemNoExpiry');
  const parts = resetTimestampParts(credit.expiresAt / 1000, nowMs);
  if (parts.sameDay) {
    return t('panels.usage.codex.redeemExpiryToday', { time: parts.time });
  }
  // Same locale-shaped calendar-day fragment as codexResetText.
  const date =
    getActiveLocale() === 'zh-CN'
      ? `${parts.month}月${parts.day}日`
      : `${parts.day} ${parts.monthName}`;
  return t('panels.usage.codex.redeemExpiryOnDay', { time: parts.time, date });
}

/**
 * The armed `[y/N]` confirm (provider-manager idiom): the warning prompt
 * first, then the credit the confirm will consume plus up to two other
 * available kinds when the list endpoint returned details.
 */
function buildRedeemConfirmLines(redeem: ChatGptRedeemView, nowMs: number): string[] {
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const lines = [
    currentTheme.boldFg(
      'warning',
      `  ${t('panels.usage.codex.redeemConfirm', { count: redeem.count })}`,
    ),
  ];
  const [chosen, ...rest] = selectRedeemableCredits(redeem.credits ?? []);
  if (chosen !== undefined) {
    lines.push(
      muted(
        `  ${t('panels.usage.codex.redeemWillUse', {
          title: redeemCreditTitle(chosen),
          description: redeemCreditDescription(chosen),
        })} (${redeemCreditExpiryText(chosen, nowMs)})`,
      ),
    );
    for (const extra of rest.slice(0, 2)) {
      lines.push(
        muted(
          `  ${t('panels.usage.codex.redeemAlsoAvailable', {
            title: redeemCreditTitle(extra),
          })} (${redeemCreditExpiryText(extra, nowMs)})`,
        ),
      );
    }
  }
  return lines;
}

export function buildChatGptAccountTabLines(
  options: ChatGptAccountTabOptions,
  layout?: ChatGptTabLayout,
): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);

  const gated = accountGateLines(options.account, 'panels.usage.loginPrompt.codex', muted, errorStyle);
  if (gated !== null) return gated;
  const account = options.account!;
  const nowMs = options.now ?? Date.now();
  const fresh = options.codexUsage ?? null;
  const freshSnapshot = fresh !== null ? snapshotFromCodexUsage(fresh) : null;
  const snapshot: RateLimitSnapshot | null = freshSnapshot ?? options.rateLimit ?? null;

  interface TextRow {
    readonly label: string;
    readonly text: string;
  }
  const textRows: TextRow[] = [];
  const windowRows: CodexWindowRow[] = [];

  textRows.push({ label: t('panels.usage.account'), text: formatAccountIdentity(account) });

  if (snapshot !== null) {
    if (snapshot.planType !== null) {
      const plan = planTypeTitleCase(snapshot.planType);
      textRows.push({
        label: t('panels.usage.codex.plan'),
        text: snapshot.activeLimit === null ? plan : `${plan} (${snapshot.activeLimit})`,
      });
    }
    if (snapshot.primary !== null) {
      windowRows.push({
        label: codexWindowLabel(snapshot.primary.windowMinutes, false),
        usedPercent: snapshot.primary.usedPercent,
        resetsAt: snapshot.primary.resetsAt,
      });
    }
    if (snapshot.secondary !== null) {
      windowRows.push({
        label: codexWindowLabel(snapshot.secondary.windowMinutes, true),
        usedPercent: snapshot.secondary.usedPercent,
        resetsAt: snapshot.secondary.resetsAt,
      });
    }
    const credits = snapshot.credits;
    if (credits !== null && (credits.unlimited || credits.hasCredits)) {
      const balance = credits.unlimited ? null : formatCreditBalance(credits.balance);
      textRows.push({
        label: t('panels.usage.codex.credits'),
        text: credits.unlimited
          ? t('panels.usage.unlimited')
          : balance === null
            ? t('panels.usage.codex.creditsAvailable')
            : t('panels.usage.codex.creditsBalance', { balance }),
      });
    }
  }

  // codex FieldFormatter: every label carries its colon and the value column
  // sits one pad past the widest label on the card.
  const labelWidth = columnWidth(
    [
      ...textRows.map((row) => `${row.label}:`),
      ...windowRows.map((row) => `${row.label}:`),
    ],
    1,
  );
  const labelCell = (label: string): RowCell => ({
    text: `${label}:`,
    token: 'textDim',
    width: labelWidth,
  });

  const lines: string[] = [];
  for (const row of textRows) {
    lines.push(renderRow([labelCell(row.label), { text: row.text, token: 'text' }], { margin: 2 }));
  }
  if (snapshot !== null) {
    for (const row of windowRows) {
      const ratioUsed = safeUsageRatio(row.usedPercent / 100);
      const bar = currentTheme.fg(
        severityColor(ratioSeverity(ratioUsed)),
        renderRateLimitBar(row.usedPercent),
      );
      const cells: RowCell[] = [
        labelCell(row.label),
        { text: bar },
        {
          text: t('panels.usage.codex.percentLeft', {
            percent: rateLimitPercentLeft(row.usedPercent),
          }),
          token: 'text',
        },
      ];
      if (row.resetsAt !== null) {
        cells.push({ text: codexResetText(row.resetsAt, nowMs), token: 'textDim' });
      }
      lines.push(renderRow(cells, { margin: 2 }));
    }
    lines.push(muted(`  ${codexCapturedText(snapshot, nowMs)}`));
  } else if (options.sessionUsageLoading === true || options.codexUsageLoading === true) {
    // Both quota sources are still in flight — hold the placeholder rather
    // than flashing 'no data'.
    lines.push(muted(`  ${t('common.loading')}`));
  } else {
    lines.push(muted(`  ${t('panels.usage.codex.noData')}`));
  }

  // The reset-credit count rides the usage-endpoint payload, so it only
  // renders with fresh data; without it the count is unknowable — point at
  // the web settings page instead (the same fallback codex's /status prints).
  // With a redeem controller wired, the count line doubles as the redeem
  // action row (key hint + hit zone) and is swapped for the armed/busy
  // confirm lines while a redeem attempt is in flight.
  const redeem = options.redeem;
  if (layout !== undefined) layout.redeemRow = null;
  if (redeem !== undefined && redeem.phase === 'loading') {
    lines.push(muted(`  ${t('panels.usage.codex.redeemChecking')}`));
  } else if (redeem !== undefined && redeem.phase === 'confirm') {
    lines.push(...buildRedeemConfirmLines(redeem, nowMs));
  } else if (redeem !== undefined && redeem.phase === 'busy') {
    lines.push(muted(`  ${t('panels.usage.codex.redeemBusy')}`));
  } else if (fresh !== null && fresh.resetCreditsAvailable !== null) {
    const interactive = redeem?.offered === true && fresh.resetCreditsAvailable > 0;
    const base =
      fresh.resetCreditsAvailable > 0
        ? t('panels.usage.codex.resetCreditsAvailable', { count: fresh.resetCreditsAvailable })
        : t('panels.usage.codex.resetCreditsNone');
    let line = muted(
      `  ${interactive ? `${base} · ${t('panels.usage.codex.redeemHint')}` : base}`,
    );
    if (interactive) {
      if (redeem?.hovered === true) line = underlineText(line, true);
      if (layout !== undefined) layout.redeemRow = lines.length;
    }
    lines.push(line);
  } else {
    lines.push(muted(`  ${t('panels.usage.codex.resetCreditsUnavailable')}`));
  }
  if (redeem?.notice !== undefined) {
    const style =
      redeem.notice.tone === 'success'
        ? (text: string) => currentTheme.fg('success', text)
        : redeem.notice.tone === 'error'
          ? errorStyle
          : muted;
    lines.push(style(`  ${redeem.notice.text}`));
  }

  lines.push(
    '',
    ...buildProviderSessionUsageLines('chatgpt', options, accent, value, muted, errorStyle),
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Bordered panel box (command-triggered panels: /mcp, /plugins)
// ---------------------------------------------------------------------------

export class UsagePanelComponent implements Component {
  /** Cached coloured lines; rebuilt from `buildLines` on every invalidate. */
  private lines: readonly string[];

  constructor(
    private readonly buildLines: () => readonly string[],
    private readonly borderToken: ColorToken,
    private readonly title?: string,
  ) {
    this.lines = buildLines();
  }

  invalidate(): void {
    // Report bodies embed palette colours, so a theme switch must re-run the
    // builder to repaint the cached lines (the data itself is captured).
    this.lines = this.buildLines();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    return renderBox(this.lines, {
      width: safeWidth,
      title: this.title ?? t('panels.usage.boxTitle'),
      token: this.borderToken,
      padding: SIDE_PADDING,
      margin: LEFT_MARGIN,
      // The historical content clip used the three-dot ellipsis; keep it so
      // existing panels render byte-identically.
      ellipsis: '...',
    });
  }
}
