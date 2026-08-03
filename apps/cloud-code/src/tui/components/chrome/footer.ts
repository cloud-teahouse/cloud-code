/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: context: N% (tokens/max) · in X · cache Y (Z%) · out W
 *           (breakdown only once per-turn usage is known; cache segment
 *           only when the provider reports cache activity)
 *
 * Mouse: the model / cwd / context segments declare hit zones (press +
 * hover) dispatched to {@link FooterActions} — model opens the model picker,
 * cwd copies the full path, context opens /status; pointer motion underlines
 * the hovered segment. Zones only exist once the host wires actions via
 * {@link FooterComponent.setActions}.
 */

import type { Component, HitZone, HitZoneId, MouseEvent } from '@cloud-code/pi-tui';
import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { effectiveModelAlias, isFastTierSupported, type TokenUsage } from '@cloud-code/sdk';

import { ALL_TIPS, type ToolbarTip } from '#/tui/constant/tips';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { getActiveLocale, resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import {
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import { shimmerText } from '#/tui/utils/shimmer';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

const DEFAULT_STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'cwd', 'git'] as const;

const MAX_CWD_SEGMENTS = 3;
// While a goal is active the footer ticks at the shimmer cadence (the wave
// advances per tick); the elapsed clock display still buckets to seconds in
// the render signature, so sub-second ticks only repaint the badge row.
const GOAL_TIMER_INTERVAL_MS = 100;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic and computed once at module load. Exported for
 * unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(ALL_TIPS);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  // Tip constants hold i18n keys; resolve to the active locale here.
  const currentText = resolveDescription(current.text);
  if (n === 1 || current.solo) return { primary: currentText, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: currentText, pair: null };
  return { primary: currentText, pair: currentText + TIP_SEPARATOR + resolveDescription(next.text) };
}

/**
 * Footer goal badge, e.g. `[goal ● active · 4m · 7 turns]`. Only shown for a
 * live (active/paused) goal; terminal/no goal -> no badge. Turn count is a raw
 * count unless an explicit turn budget is set, in which case it shows used/limit.
 * While the goal is active the label text shimmers (the status dot is a glyph
 * and stays solid); paused/blocked badges render statically.
 */
function formatGoalBadge(
  goal: AppState['goal'],
  colors: ColorPalette,
  wallClockMs?: number,
  shimmerFrame?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
  // Show the badge for every persisted, resumable status. `complete` clears the
  // goal, so it never reaches here; only the unset case returns null.
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked') {
    return null;
  }
  const dotColor =
    goal.status === 'active'
      ? colors.primary
      : goal.status === 'blocked'
        ? colors.warning
        : colors.textMuted;
  const turns =
    goal.budget.turnBudget !== null
      ? t('footer.goal.turnsBudget', { used: goal.turnsUsed, budget: goal.budget.turnBudget })
      : goal.turnsUsed === 1
        ? t('footer.goal.turns.one', { count: goal.turnsUsed })
        : t('footer.goal.turns.other', { count: goal.turnsUsed });
  const statusKey =
    goal.status === 'active'
      ? ('footer.goal.status.active' as const)
      : goal.status === 'blocked'
        ? ('footer.goal.status.blocked' as const)
        : ('footer.goal.status.paused' as const);
  const label = t('footer.goal.badge', {
    status: t(statusKey),
    elapsed: formatBadgeElapsed(wallClockMs ?? goal.wallClockMs),
    turns,
  });
  return (
    chalk.hex(colors.textMuted)('[' + t('footer.goal.badgePrefix') + ' ') +
    chalk.hex(dotColor)('●') +
    (shimmerFrame !== undefined
      ? shimmerText(` ${label}`, shimmerFrame) + chalk.hex(colors.textMuted)(']')
      : chalk.hex(colors.textMuted)(` ${label}]`))
  );
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/**
 * Whether the current model may run on the fast tier — the same gate `/fast`
 * applies (sdk `isFastTierSupported`): official Codex backend (chatgpt.com)
 * plus a catalog-declared 'priority' service tier. Fast-tier display/request
 * must never leak onto Kimi models or third-party OpenAI-compatible
 * endpoints, even though they share the `openai_responses` provider type.
 */
function isCurrentModelFastCapable(state: AppState): boolean {
  const model = state.availableModels[state.model];
  if (model === undefined) return false;
  const provider = state.availableProviders[model.provider];
  return isFastTierSupported(effectiveModelAlias(model), provider);
}

function modelDisplayName(state: AppState): string {

  const model = state.availableModels[state.model];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

/**
 * Footer context readout. Percent comes from the exact token counts when
 * both are known (the ratio can lag a step behind); otherwise it falls
 * back to the precomputed ratio. Counts use the shared 1024-based
 * formatter. When per-turn usage is available, the in/cache/out breakdown
 * of the current (or last) turn is appended.
 */
function formatContextStatus(
  usage: number,
  tokens?: number,
  maxTokens?: number,
  turnUsage?: TokenUsage | null,
  recentFirstTokenLatencies?: readonly number[],
): string {
  const base =
    maxTokens !== undefined && maxTokens > 0 && tokens !== undefined
      ? t('footer.context.withTokens', {
          percent: String(usagePercent(tokens, maxTokens)),
          tokens: formatTokenCount(tokens),
          maxTokens: formatTokenCount(maxTokens),
        })
      : t('footer.context.percentOnly', { percent: usagePercentFromRatio(usage) });
  // Every segment renders by default with 0 placeholders — transient "not yet
  // reported" states never blank the context area out.
  const breakdown = formatTurnUsageBreakdown(turnUsage);
  const segments = [base, breakdown];
  segments.push(
    t('footer.context.firstToken', { time: averageFirstTokenLatency(recentFirstTokenLatencies) }),
  );
  return segments.join(' · ');
}

/** Average of the recent first-token latencies, formatted compactly; '0s' when nothing reported yet. */
function averageFirstTokenLatency(durations: readonly number[] | undefined): string {
  if (durations === undefined || durations.length === 0) return '0s';
  const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  if (avgMs >= 60_000) {
    const minutes = Math.floor(avgMs / 60_000);
    const seconds = Math.round((avgMs % 60_000) / 1000);
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  if (avgMs >= 10_000) return `${Math.round(avgMs / 1000)}s`;
  return `${(avgMs / 1000).toFixed(1)}s`;
}

/**
 * `in X · cache Y (Z%) · out W` for the turn's accumulated usage — always
 * rendered (zeros before the first usage report). The cache segment shows its
 * read hit rate over all input tokens.
 */
function formatTurnUsageBreakdown(turnUsage: TokenUsage | null | undefined): string {
  const usage = turnUsage ?? {
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    output: 0,
  };
  const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  const segments = [t('footer.tokens.in', { tokens: formatTokenCount(input) })];
  const hitRate = input > 0 ? Math.round((usage.inputCacheRead / input) * 100) : 0;
  segments.push(
    t('footer.tokens.cache', {
      tokens: formatTokenCount(usage.inputCacheRead),
      percent: hitRate,
    }),
  );
  segments.push(t('footer.tokens.out', { tokens: formatTokenCount(usage.output) }));
  return segments.join(' · ');
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

// Palette objects are replaced wholesale on theme switch, so a WeakMap id is
// a cheap way to include "which palette" in the footer render signature.
const paletteIds = new WeakMap<ColorPalette, number>();
let nextPaletteId = 1;
function paletteId(palette: ColorPalette): number {
  let id = paletteIds.get(palette);
  if (id === undefined) {
    id = nextPaletteId++;
    paletteIds.set(palette, id);
  }
  return id;
}

/**
 * Click actions for the footer's actionable segments. Wired by the host at
 * mount time; every entry routes the same way the typed slash command (or
 * /copy) would, so mouse and keyboard stay equivalent.
 */
export interface FooterActions {
  /** Model segment (line 1): open the model picker (`/model`). */
  readonly openModelPicker?: () => void;
  /** cwd segment (line 1): copy the full working directory path. */
  readonly copyWorkDir?: () => void;
  /** Context/usage segment (line 2): open the status dialog (`/status`). */
  readonly openStatus?: () => void;
}

/** Hit-zone ids the footer dispatches to FooterActions. */
export type FooterZoneId = 'model' | 'cwd' | 'context';

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private actions: FooterActions | undefined;
  /**
   * Hit zones of the last render (component frame: row 0/1 = the two footer
   * lines, col 1-based). Render by-product, same inputs as the rendered
   * lines — the render-cache signature covers every one of them, so a cache
   * hit leaves the zones valid.
   */
  private lastZones: HitZone[] = [];
  /** Hovered segment id (mouse motion, central zone dispatch); null when the
   * pointer is elsewhere. Part of the render-cache signature. */
  private readonly hover = new HoverState<FooterZoneId>();
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  /** Shimmer wave position for the active-goal badge; advanced by the goal
   * timer, which runs only while the goal is active. */
  private goalShimmerFrame = 0;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;
  private statusLineSignatureCache:
    | {
        input: AppState['statusLine'];
        items: readonly string[] | null | undefined;
        itemsLength: number;
        command: string | null | undefined;
        value: string;
      }
    | undefined;
  /**
   * Render signature parts are compared before joining, so unchanged footer
   * inputs avoid rebuilding the signature string on every frame.
   */
  private renderSignaturePartsCache:
    | { parts: readonly (string | number)[]; value: string }
    | undefined;
  /**
   * Render output cache keyed by a signature of every input the two footer
   * lines depend on (state fields, git snapshot, tip rotation index, goal
   * clock second, palette, locale, width). Recomputing only on change keeps
   * per-frame streaming renders from re-joining/chalking identical lines.
   */
  private renderCache: { signature: string; lines: string[] } | undefined;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
    this.state = state;
  }

  /**
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  /**
   * Wire the click actions for the model/cwd/context segments. Until called,
   * the footer declares no hit zones and every press falls through to the
   * default handling, exactly as before.
   */
  setActions(actions: FooterActions): void {
    this.actions = actions;
    // Zones are a render by-product; a signature cache hit would skip their
    // computation, so force one uncached pass.
    this.renderCache = undefined;
  }

  /**
   * Zones of the actionable segments, cached by render(). Press + hover:
   * pointer motion over a segment is tracked centrally and the segment
   * renders underlined; with no mouse in use the hover state stays null and
   * renders stay byte-identical.
   */
  hitZones(): Iterable<HitZone> {
    return this.lastZones;
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const actions = this.actions;
    if (actions === undefined) return false;
    switch (id as FooterZoneId) {
      case 'model':
        actions.openModelPicker?.();
        return;
      case 'cwd':
        actions.copyWorkDir?.();
        return;
      case 'context':
        actions.openStatus?.();
        return;
    }
    return false;
  }

  /**
   * Zone hover (central dispatch): records the hovered segment so render()
   * underlines it. The changed flag is the TUI's repaint signal; the hover
   * id is part of the render-cache signature, so a repaint picks up the
   * underline without touching the cached no-hover lines.
   */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    return this.hover.update(typeof id === 'string' ? (id as FooterZoneId) : null);
  }

  invalidate(): void {}

  private statusLineRunner: StatusLineCommandRunner | null = null;

  private syncStatusLineRunner(state: AppState): void {
    const command = state.statusLine?.command ?? null;
    if (command === null) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = null;
      return;
    }
    if (this.statusLineRunner?.command !== command) {
      // A reload can swap one command for another; the old runner would
      // otherwise keep executing the previous script until restart.
      this.statusLineRunner?.dispose();
      this.statusLineRunner = new StatusLineCommandRunner(command, this.onRefresh);
    }
  }

  private statusLinePayload(): StatusLinePayload {
    const state = this.state;
    return {
      model: modelDisplayName(state),
      cwd: state.workDir,
      gitBranch: this.gitCache.getStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
    };
  }

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;
    const git = this.gitCache.getStatus();

    // The rainbow dance animates the model label per frame; bypass the cache
    // while it runs so the animation keeps flowing.
    const signature = isRainbowDancing() ? undefined : this.buildRenderSignature(width, git);
    if (signature !== undefined && this.renderCache?.signature === signature) {
      return this.renderCache.lines;
    }

    // ── Line 1: slots composed per status_line.items, or a user command ──
    let customLine: string | null = null;
    if (this.statusLineRunner !== null) {
      this.statusLineRunner.maybeRefresh(this.statusLinePayload());
      customLine = this.statusLineRunner.current();
    }

    const left: string[] = [];
    // Indices of the clickable segments within `left` (-1 = not rendered),
    // for zone column math after the join.
    let modelLeftIndex = -1;
    let cwdLeftIndex = -1;
    let modelSegment: string | undefined;
    let cwdSegment: string | undefined;
    const modes: string[] = [];
    if (state.permissionMode === 'auto') modes.push(chalk.hex(colors.warning).bold('auto'));
    if (state.permissionMode === 'yolo') modes.push(chalk.hex(colors.warning).bold('yolo'));
    if (state.planMode) modes.push(chalk.hex(colors.primary).bold('plan'));
    if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold('swarm'));
    if (state.coordinatorMode) modes.push(chalk.hex(colors.success).bold(t('footer.mode.coordinator')));
    // Vim editing mode badge (tui.toml editor.vim_mode). NORMAL stands out,
    // INSERT stays muted since it is the default typing mode.
    if (state.vimMode === 'NORMAL') modes.push(chalk.hex(colors.accent).bold(t('footer.vimMode.normal')));
    else if (state.vimMode === 'INSERT') modes.push(chalk.hex(colors.textMuted)(t('footer.vimMode.insert')));

    const goalBadge = formatGoalBadge(
      state.goal,
      colors,
      this.goalWallClockMs(state.goal),
      state.goal?.status === 'active' ? this.goalShimmerFrame : undefined,
    );

    const model = modelDisplayName(state);
    if (model) {
      const effort = state.thinkingEffort;
      const rawCurrentModel = state.availableModels[state.model];
      const currentModel = rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
      // Only effort-capable models (those declaring support_efforts) show the
      // concrete effort; legacy boolean models keep the plain "thinking" suffix.
      const hasEfforts = (currentModel?.supportEfforts?.length ?? 0) > 0;
      const thinkingLabel =
        effort !== 'off'
          ? hasEfforts && effort !== 'on'
            ? t('footer.thinkingEffortSuffix', { effort })
            : t('footer.thinkingSuffix')
          : '';
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel = chalk.hex(colors.text)(modelLabel);
      // Fast-tier marker, same as codex history_cell/session.rs: magenta `fast`
      // trailing the model name — but only when the current model passes the
      // model-level fast gate (official Codex backend + catalog-declared
      // 'priority' service tier). The setting persists across model switches,
      // yet the marker (and the request param) must not leak onto Kimi models
      // or third-party OpenAI-compatible endpoints.
      const fastCapable = isCurrentModelFastCapable(state);
      if (state.serviceTier === 'priority' && fastCapable) {
        renderedModelLabel += ` ${chalk.hex(colors.fastTier)('fast')}`;
      }
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      modelSegment = renderedModelLabel;
    }

    // Background-task badges sit immediately before cwd. `bash-*` tasks
    // (shell processes) and `agent-*` tasks (background subagents) get
    // separate badges so the user can distinguish them at a glance.
    const taskSegments: string[] = [];
    if (this.backgroundBashTaskCount > 0) {
      taskSegments.push(
        chalk.hex(colors.primary)(
          this.backgroundBashTaskCount === 1
            ? t('footer.tasksRunning.one', { count: this.backgroundBashTaskCount })
            : t('footer.tasksRunning.other', { count: this.backgroundBashTaskCount }),
        ),
      );
    }
    if (this.backgroundAgentCount > 0) {
      taskSegments.push(
        chalk.hex(colors.primary)(
          this.backgroundAgentCount === 1
            ? t('footer.agentsRunning.one', { count: this.backgroundAgentCount })
            : t('footer.agentsRunning.other', { count: this.backgroundAgentCount }),
        ),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) {
      cwdSegment = chalk.hex(colors.textDim)(cwd);
    }

    const { primary: tipPrimary, pair: tipPair } = tipsForIndex(currentTipIndex());
    if (customLine === null) {
      const slots: Record<string, readonly string[]> = {
        mode: modes.length > 0 ? [modes.join(' ')] : [],
        goal: goalBadge !== null ? [goalBadge] : [],
        model: modelSegment !== undefined ? [modelSegment] : [],
        tasks: taskSegments,
        cwd: cwdSegment !== undefined ? [cwdSegment] : [],
        git: git !== null ? [formatFooterGitBadge(git, colors)] : [],
        tips: tipPrimary ? [chalk.hex(colors.textMuted)(tipPrimary)] : [],
      };
      const configured = state.statusLine?.items ?? null;
      const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
      for (const slot of order) {
        const pieces = slots[slot];
        if (pieces === undefined || pieces.length === 0) continue;
        if (slot === 'model') modelLeftIndex = left.length;
        else if (slot === 'cwd') cwdLeftIndex = left.length;
        left.push(...pieces);
      }
    }

    // Hover affordance: underline the hovered clickable segment only — the
    // two-cell join gaps and the rest of the bar stay plain.
    if (modelLeftIndex >= 0 && this.hover.isHovered('model')) {
      left[modelLeftIndex] = underlineText(left[modelLeftIndex]!, true);
    }
    if (cwdLeftIndex >= 0 && this.hover.isHovered('cwd')) {
      left[cwdLeftIndex] = underlineText(left[cwdLeftIndex]!, true);
    }

    const leftLine = left.join('  ');
    const leftWidth = visibleWidth(leftLine);

    // Rotating hint tips stay on the right unless 'tips' was given an inline
    // slot in items (rendered above at its configured position), or the user
    // dropped 'tips' from items.
    const configuredItems = state.statusLine?.items ?? null;
    const tipsInline = configuredItems?.includes('tips') === true;
    const showTips = !tipsInline && (configuredItems === null || configuredItems.includes('tips'));
    const gap = 2;
    const remaining = Math.max(0, width - leftWidth - gap);
    let tipText = '';
    if (showTips) {
      if (tipPair && visibleWidth(tipPair) <= remaining) {
        tipText = tipPair;
      } else if (tipPrimary && visibleWidth(tipPrimary) <= remaining) {
        tipText = tipPrimary;
      }
    }

    let line1: string;
    if (customLine !== null) {
      // status_line.command: the first stdout line takes over line 1.
      line1 = chalk.hex(colors.text)(customLine);
    } else if (tipText) {
      const pad = width - leftWidth - visibleWidth(tipText);
      line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(tipText);
    } else if (leftWidth <= width) {
      line1 = leftLine;
    } else {
      line1 = truncateToWidth(leftLine, width, '…');
    }

    // ── Line 2: transient hint (bottom-left) + context (right) ──
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
      state.turnUsage,
      state.recentFirstTokenLatencies,
    );
    const contextWidth = visibleWidth(contextText);
    const renderedContext = underlineText(
      chalk.hex(colors.text)(contextText),
      this.hover.isHovered('context'),
    );
    let line2: string;
    if (this.transientHint) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 = chalk.hex(colors.warning).bold(shownHint) + ' '.repeat(pad) + renderedContext;
    } else {
      const leftPad = Math.max(0, width - contextWidth);
      line2 = ' '.repeat(leftPad) + renderedContext;
    }

    const lines = [truncateToWidth(line1, width), truncateToWidth(line2, width)];
    this.lastZones = this.buildZones(width, left, modelLeftIndex, cwdLeftIndex, leftWidth, contextWidth);
    if (signature !== undefined) {
      this.renderCache = { signature, lines };
    }
    return lines;
  }

  /**
   * Zones for the rendered segments, in the footer's own frame (row 0/1 =
   * the two lines, col 1-based). Line-1 zones are skipped when the segment
   * row overflowed and got truncated — clickable geometry must never point
   * at cells that scrolled off. The context segment is right-aligned, so its
   * zone anchors to the row's end. Everything derives from the same inputs
   * the render signature covers.
   */
  private buildZones(
    width: number,
    left: readonly string[],
    modelLeftIndex: number,
    cwdLeftIndex: number,
    leftWidth: number,
    contextWidth: number,
  ): HitZone[] {
    if (this.actions === undefined) return [];
    const zones: HitZone[] = [];
    if (leftWidth <= width) {
      // Segments join with a two-cell gap; walk to the segment's start col.
      const startCol = (index: number): number => {
        let col = 1;
        for (let i = 0; i < index; i++) col += visibleWidth(left[i] ?? '') + 2;
        return col;
      };
      if (modelLeftIndex >= 0) {
        zones.push({
          id: 'model',
          row: 0,
          col: startCol(modelLeftIndex),
          width: visibleWidth(left[modelLeftIndex] ?? ''),
          height: 1,
        });
      }
      if (cwdLeftIndex >= 0) {
        zones.push({
          id: 'cwd',
          row: 0,
          col: startCol(cwdLeftIndex),
          width: visibleWidth(left[cwdLeftIndex] ?? ''),
          height: 1,
        });
      }
    }
    if (contextWidth > 0 && contextWidth <= width) {
      zones.push({
        id: 'context',
        row: 1,
        col: width - contextWidth + 1,
        width: contextWidth,
        height: 1,
      });
    }
    return zones;
  }

  /**
   * Everything the two footer lines can change on, flattened into one string.
   * Cheap to build (no chalk, no joins of styled segments) relative to a full
   * re-render. Time-derived inputs are bucketed to the granularity actually
   * displayed: the rotating tip index (10s) and the goal badge's elapsed
   * seconds.
   */
  private buildRenderSignature(width: number, git: GitStatus | null): string {
    const state = this.state;
    const goal = state.goal;
    const goalClock = this.goalWallClockMs(goal);
    const parts: (string | number)[] = [
      width,
      paletteId(currentTheme.palette),
      getActiveLocale(),
      state.permissionMode,
      state.planMode ? 1 : 0,
      state.swarmMode ? 1 : 0,
      state.coordinatorMode ? 1 : 0,
      state.vimMode ?? '',
      state.model,
      modelDisplayName(state),
      state.thinkingEffort,
      state.serviceTier ?? '',
      // The fast marker depends on the model's catalog serviceTiers, which a
      // background provider refresh can change under an unchanged alias.
      isCurrentModelFastCapable(state) ? 1 : 0,
      state.workDir,
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
      averageFirstTokenLatency(state.recentFirstTokenLatencies),
      this.backgroundBashTaskCount,
      this.backgroundAgentCount,
      this.transientHint ?? '',
      // Hover repaints only the underline of one segment; it must still bust
      // the cache or the affordance never appears.
      this.hover.index ?? '',
      this.statusLineSignature(),
      this.statusLineRunner?.current() ?? '',
      currentTipIndex(),
      goalSnapshotKey(goal) ?? '',
      goalClock === undefined ? '' : Math.round(goalClock / 1000),
      // The badge shimmers while the goal is active; the frame must bust the
      // cache or the wave never repaints. Static states omit it entirely.
      goal?.status === 'active' ? this.goalShimmerFrame : '',
    ];
    const turnUsage = state.turnUsage;
    parts.push(
      turnUsage === null || turnUsage === undefined
        ? ''
        : `${String(turnUsage.inputOther)},${String(turnUsage.inputCacheRead)},${String(turnUsage.inputCacheCreation)},${String(turnUsage.output)}`,
    );
    if (git === null) {
      parts.push('');
    } else {
      parts.push(
        git.branch,
        git.dirty ? 1 : 0,
        git.ahead,
        git.behind,
        git.diffAdded,
        git.diffDeleted,
        git.pullRequest?.number ?? '',
      );
    }

    const cached = this.renderSignaturePartsCache;
    if (cached !== undefined && cached.parts.length === parts.length) {
      let unchanged = true;
      for (let index = 0; index < parts.length; index += 1) {
        if (parts[index] !== cached.parts[index]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return cached.value;
    }

    const value = parts.join('');
    this.renderSignaturePartsCache = { parts, value };
    return value;
  }

  private statusLineSignature(): string {
    const statusLine = this.state.statusLine;
    const items = statusLine?.items;
    const itemsLength = items?.length ?? -1;
    const command = statusLine?.command;
    const cached = this.statusLineSignatureCache;
    if (
      cached !== undefined &&
      cached.input === statusLine &&
      cached.items === items &&
      cached.itemsLength === itemsLength &&
      cached.command === command
    ) {
      return cached.value;
    }

    const value = JSON.stringify(statusLine ?? null) ?? 'null';
    this.statusLineSignatureCache = {
      input: statusLine,
      items,
      itemsLength,
      command,
      value,
    };
    return value;
  }

  private syncGoalClock(goal: AppState['goal']): void {
    const key = goalSnapshotKey(goal);
    if (key === this.goalSnapshotKey) return;
    this.goalSnapshotKey = key;
    this.goalObservedAtMs = Date.now();
  }

  private syncGoalTimer(goal: AppState['goal']): void {
    if (goal?.status === 'active') {
      if (this.goalTimer !== null) return;
      this.goalTimer = setInterval(() => {
        this.goalShimmerFrame += 1;
        this.onRefresh();
      }, GOAL_TIMER_INTERVAL_MS);
      this.goalTimer.unref?.();
      return;
    }

    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  dispose(): void {
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  private goalWallClockMs(goal: AppState['goal']): number | undefined {
    if (goal === null || goal === undefined) return undefined;
    if (goal.status !== 'active') return goal.wallClockMs;
    return goal.wallClockMs + Math.max(0, Date.now() - this.goalObservedAtMs);
  }
}

function goalSnapshotKey(goal: AppState['goal']): string | null {
  if (goal === null || goal === undefined) return null;
  return [
    goal.goalId,
    goal.status,
    goal.terminalReason ?? '',
    String(goal.turnsUsed),
    String(goal.tokensUsed),
    String(goal.wallClockMs),
    String(goal.budget.tokenBudget),
    String(goal.budget.turnBudget),
    String(goal.budget.wallClockBudgetMs),
  ].join('\u0000');
}
