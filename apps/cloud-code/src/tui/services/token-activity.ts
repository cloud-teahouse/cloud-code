/**
 * Token activity aggregation — scans local session wire logs
 * (`<dataDir>/sessions/**\/wire.jsonl`) for `usage.record` entries and folds
 * them into per-day token totals for the `/usage` heatmap, plus all-time
 * aggregate facts (`loadTokenActivityStats`) for the `/status` Stats tab.
 *
 * Why local: the ChatGPT token-activity backend endpoints sit behind a
 * Cloudflare challenge, so the 52-week chart is fed from the durable record
 * log every session already writes.
 *
 * Counting semantics:
 * - Every `usage.record` is one settled LLM request. Loop steps log scope
 *   `turn`, auxiliary calls (guardian / compaction / title) log scope
 *   `session`; the scopes never overlap the same request, so summing all
 *   records regardless of scope is exact — no double counting. Replay on
 *   resume does not re-log (AgentRecords gates `logRecord` on `restoring`).
 * - Tokens per record = inputOther + inputCacheRead + inputCacheCreation +
 *   output, i.e. the whole request footprint (same input-total convention as
 *   the session usage panel, plus output).
 * - Day buckets use the *local* timezone, matching the chart's local
 *   `YYYY-MM-DD` cells.
 *
 * Provider attribution: `usage.record` only carries `model`, so the provider
 * id is recovered from the same wire file's `llm.request` records
 * (model → provider map, latest wins). Records without a known provider
 * aggregate under `undefined` — always included in an unfiltered load, and
 * selectable via the filter predicate.
 *
 * Caching: per-file parses (contributions + per-model totals + record time
 * span) are cached keyed on (mtimeMs, size); an append, rewrite, or
 * truncation invalidates exactly that file. The directory walk itself is
 * cheap (bounded depth, stat-only). Cold-cache parses run in event-loop
 * slices (WIRE_PARSE_CHUNK_BYTES) through a small concurrency pool
 * (WIRE_PARSE_CONCURRENCY), and concurrent loads share one read+parse per
 * file revision, so opening /status never pins input behind a large session
 * history. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { getDataDir } from '#/utils/paths';

/** Provider bucket for the two managed accounts; anything else is 'other'. */
export type TokenActivityProviderKind = 'kimi' | 'chatgpt' | 'other';

export function classifyTokenActivityProvider(
  provider: string | undefined,
): TokenActivityProviderKind | undefined {
  if (provider === undefined) return undefined;
  const id = provider.toLowerCase();
  if (id.includes('kimi')) return 'kimi';
  if (id.includes('chatgpt') || id.includes('codex') || id.includes('openai')) return 'chatgpt';
  return 'other';
}

/** One usage.record's contribution, provider-resolved within its wire file. */
export interface TokenActivityContribution {
  /** Local `YYYY-MM-DD`. */
  readonly day: string;
  readonly tokens: number;
  readonly provider: string | undefined;
}

export type TokenActivityProviderFilter = (provider: string | undefined) => boolean;

export interface TokenActivityCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly contributions: readonly TokenActivityContribution[];
  /** Per-model token totals from `usage.record`s (drives the Stats tab's
   * favorite-model fact). Absent in hand-seeded cache entries (tests). */
  readonly modelTotals?: ReadonlyMap<string, number> | undefined;
  /** Min/max record timestamps in the file (session-span derivation). */
  readonly firstTimeMs?: number | undefined;
  readonly lastTimeMs?: number | undefined;
}

/** Map of absolute wire.jsonl path → parsed cache entry. */
export type TokenActivityCache = Map<string, TokenActivityCacheEntry>;

export interface LoadTokenActivityOptions {
  /** Defaults to `<dataDir>/sessions` (override in tests). */
  readonly sessionsDir?: string | undefined;
  /** Keep only contributions whose provider passes; default keeps all. */
  readonly provider?: TokenActivityProviderFilter | undefined;
  /** Shared cache; default is the process-wide singleton. */
  readonly cache?: TokenActivityCache | undefined;
}

export interface TokenActivityData {
  /** Active days only, ascending by date. */
  readonly buckets: ReadonlyArray<{ readonly date: string; readonly tokens: number }>;
  /** Distinct provider ids observed (before filtering), sorted. */
  readonly providers: readonly string[];
}

const defaultCache: TokenActivityCache = new Map();

/** Test hook: drop every cached parse (e.g. after deleting fixture files). */
export function clearTokenActivityCache(): void {
  defaultCache.clear();
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Same tolerance as `session/export/wire-scan.ts`: epoch ms, or seconds. */
function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

function localDayKey(timeMs: number): string {
  const date = new Date(timeMs);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parse one wire.jsonl into provider-resolved per-record contributions.
 * Corrupt lines (truncated tail, partial flush) are skipped, mirroring the
 * record reader's tolerance for a crash mid-flush.
 */
export function parseWireTokenActivity(content: string): TokenActivityContribution[] {
  return parseWireFile(content).contributions;
}

/** Full per-file parse: contributions + model totals + record time span. */
export interface ParsedWireFile {
  readonly contributions: TokenActivityContribution[];
  readonly modelTotals: ReadonlyMap<string, number>;
  readonly firstTimeMs?: number | undefined;
  readonly lastTimeMs?: number | undefined;
}

interface RawUsage {
  readonly day: string;
  readonly tokens: number;
  readonly model: string | undefined;
}

/** Mutable fold state shared by the sync and chunked per-file parses. */
interface WireParseState {
  readonly modelProviders: Map<string, string>;
  readonly raw: RawUsage[];
  firstTimeMs?: number | undefined;
  lastTimeMs?: number | undefined;
}

function newWireParseState(): WireParseState {
  return { modelProviders: new Map(), raw: [] };
}

function processWireLine(state: WireParseState, trimmed: string): void {
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof record !== 'object' || record === null) return;
  const { type, time, created_at: createdAt, model, provider, usage } = record as {
    type?: unknown;
    time?: unknown;
    created_at?: unknown;
    model?: unknown;
    provider?: unknown;
    usage?: unknown;
  };

  // Session span: every stamped record counts; the metadata record carries
  // `created_at` instead of `time` (it is written before the stamper runs).
  const recordTimeMs = normalizeTimestampMs(time ?? createdAt);
  if (recordTimeMs !== undefined) {
    state.firstTimeMs = Math.min(state.firstTimeMs ?? recordTimeMs, recordTimeMs);
    state.lastTimeMs = Math.max(state.lastTimeMs ?? recordTimeMs, recordTimeMs);
  }

  if (type === 'llm.request') {
    if (typeof model === 'string' && typeof provider === 'string') {
      state.modelProviders.set(model, provider);
    }
    return;
  }
  if (type !== 'usage.record') return;

  const timeMs = normalizeTimestampMs(time);
  if (timeMs === undefined) return;
  const u = (typeof usage === 'object' && usage !== null ? usage : {}) as Record<string, unknown>;
  const tokens =
    usageNumber(u['inputOther']) +
    usageNumber(u['inputCacheRead']) +
    usageNumber(u['inputCacheCreation']) +
    usageNumber(u['output']);
  if (tokens === 0) return;
  state.raw.push({
    day: localDayKey(timeMs),
    tokens,
    model: typeof model === 'string' ? model : undefined,
  });
}

function finalizeWireParse(state: WireParseState): ParsedWireFile {
  const modelTotals = new Map<string, number>();
  for (const entry of state.raw) {
    if (entry.model === undefined) continue;
    modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + entry.tokens);
  }

  return {
    contributions: state.raw.map((entry) => ({
      day: entry.day,
      tokens: entry.tokens,
      provider: entry.model === undefined ? undefined : state.modelProviders.get(entry.model),
    })),
    modelTotals,
    firstTimeMs: state.firstTimeMs,
    lastTimeMs: state.lastTimeMs,
  };
}

function parseWireFile(content: string): ParsedWireFile {
  const state = newWireParseState();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) processWireLine(state, trimmed);
  }
  return finalizeWireParse(state);
}

/**
 * Input bytes parsed per event-loop slice. A busy session's wire log runs to
 * tens of MB of JSONL — with fat LLM payload lines even a few thousand of
 * them take hundreds of ms to parse — so the budget is in bytes, not lines:
 * parsing a cold cache in one synchronous burst pins the event loop (input
 * and repaints starve — the /status dialog feels dead right after opening).
 */
export const WIRE_PARSE_CHUNK_BYTES = 256 * 1024;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Async counterpart of the sync parse: identical output, but breathes
 * between slices so a cold-cache aggregation never pins the event loop.
 */
export async function parseWireFileChunked(content: string): Promise<ParsedWireFile> {
  const state = newWireParseState();
  const lines = content.split('\n');
  let sliceBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    sliceBytes += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.length > 0) processWireLine(state, trimmed);
    if (sliceBytes >= WIRE_PARSE_CHUNK_BYTES && i + 1 < lines.length) {
      await yieldToEventLoop();
      sliceBytes = 0;
    }
  }
  return finalizeWireParse(state);
}

/** wire.jsonl lives at depth 3 (legacy session root) or 5 (`agents/<id>/`). */
const WIRE_FILE_NAME = 'wire.jsonl';
const MAX_WALK_DEPTH = 5;

async function findWireFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or missing directory — nothing to aggregate there
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path, depth + 1);
        } else if (entry.isFile() && entry.name === WIRE_FILE_NAME) {
          out.push(path);
        }
      }),
    );
  }
  await walk(root, 1);
  return out;
}

async function contributionsForFile(
  path: string,
  cache: TokenActivityCache,
): Promise<readonly TokenActivityContribution[]> {
  return (await parseForFile(path, cache)).contributions;
}

/**
 * Files parsed concurrently. A file's first parse slice runs inside its I/O
 * continuation, so an unbounded `Promise.all` over a large sessions dir
 * batches hundreds of continuations into a single event-loop phase — a
 * several-hundred-ms input/repaint stall even with sliced parses. A small
 * pool bounds the CPU any one phase can absorb.
 */
const WIRE_PARSE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * In-flight read+parse of one wire file revision, shared between concurrent
 * aggregations: /status fires the heatmap and the aggregate-stats loads
 * together, and without sharing each would read and parse every file on its
 * own. Keyed by the caller-observed (mtime, size) so a file rewritten
 * mid-flight is parsed per revision, never mixed.
 */
const inFlightWireParses = new Map<string, Promise<ParsedWireFile | null>>();

function readAndParseWireFile(
  path: string,
  mtimeMs: number,
  size: number,
): Promise<ParsedWireFile | null> {
  const key = `${path}:${String(mtimeMs)}:${String(size)}`;
  const existing = inFlightWireParses.get(key);
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<ParsedWireFile | null> => {
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      return null;
    }
    return parseWireFileChunked(content);
  })();
  inFlightWireParses.set(key, promise);
  const settled = (): void => {
    if (inFlightWireParses.get(key) === promise) inFlightWireParses.delete(key);
  };
  void promise.then(settled, settled);
  return promise;
}

async function parseForFile(
  path: string,
  cache: TokenActivityCache,
): Promise<TokenActivityCacheEntry> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { mtimeMs: 0, size: 0, contributions: [] };
  }
  const cached = cache.get(path);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached;
  }
  const parsed = await readAndParseWireFile(path, info.mtimeMs, info.size);
  if (parsed === null) {
    return { mtimeMs: 0, size: 0, contributions: [] };
  }
  const entry: TokenActivityCacheEntry = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    contributions: parsed.contributions,
    modelTotals: parsed.modelTotals,
    firstTimeMs: parsed.firstTimeMs,
    lastTimeMs: parsed.lastTimeMs,
  };
  cache.set(path, entry);
  return entry;
}

/** Aggregate all session wire logs under `sessionsDir` into daily buckets. */
export async function loadTokenActivity(
  options: LoadTokenActivityOptions = {},
): Promise<TokenActivityData> {
  const sessionsDir = options.sessionsDir ?? join(getDataDir(), 'sessions');
  const cache = options.cache ?? defaultCache;
  const keep = options.provider ?? ((): boolean => true);

  const files = await findWireFiles(sessionsDir);
  const perFile = await mapWithConcurrency(files, WIRE_PARSE_CONCURRENCY, (file) =>
    contributionsForFile(file, cache),
  );

  const providers = new Set<string>();
  const byDay = new Map<string, number>();
  for (const contributions of perFile) {
    for (const contribution of contributions) {
      if (contribution.provider !== undefined) providers.add(contribution.provider);
      if (!keep(contribution.provider)) continue;
      byDay.set(contribution.day, (byDay.get(contribution.day) ?? 0) + contribution.tokens);
    }
  }

  const buckets = [...byDay.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, tokens]) => ({ date, tokens }));
  return { buckets, providers: [...providers].toSorted() };
}

// ---------------------------------------------------------------------------
// Aggregate stats (Stats tab of /status)
// ---------------------------------------------------------------------------

export interface LoadTokenActivityStatsOptions {
  /** Defaults to `<dataDir>/sessions` (override in tests). */
  readonly sessionsDir?: string | undefined;
  /** Shared cache; default is the process-wide singleton. */
  readonly cache?: TokenActivityCache | undefined;
}

/**
 * All-time aggregate facts derived from the same wire walk that feeds the
 * heatmap. Every field is computed from local record data only — anything
 * not derivable stays undefined and the UI renders an explicit `—`.
 */
export interface TokenActivityStats {
  /** Sum of every usage.record's tokens, all sessions, all time. */
  readonly totalTokens: number;
  /** Days with at least one token recorded. */
  readonly activeDays: number;
  /** Day (local `YYYY-MM-DD`) with the highest token total. */
  readonly mostActiveDay?: { readonly date: string; readonly tokens: number } | undefined;
  /** Model with the highest all-time token total (usage.record attribution). */
  readonly favoriteModel?: { readonly model: string; readonly tokens: number } | undefined;
  /**
   * Distinct session directories containing a wire log — i.e. sessions with
   * at least one persisted record. Handles both layouts
   * (`<bucket>/<session>/wire.jsonl` and `<bucket>/<session>/agents/<id>/`).
   */
  readonly sessionCount: number;
  /**
   * Longest first-record → last-record span across sessions (wall-clock
   * activity span, not active-work time). Undefined when no session has two
   * differently-timed records.
   */
  readonly longestSessionMs?: number | undefined;
}

/**
 * Session identity for a wire file: its session directory. The
 * `agents/<id>/` layout nests agent wire logs inside the session dir.
 */
function sessionDirOf(sessionsDir: string, file: string): string {
  let dir = dirname(file);
  if (basename(dirname(dir)) === 'agents') {
    dir = dirname(dirname(dir));
  }
  return relative(sessionsDir, dir) || dir;
}

/** Aggregate all session wire logs under `sessionsDir` into all-time stats. */
export async function loadTokenActivityStats(
  options: LoadTokenActivityStatsOptions = {},
): Promise<TokenActivityStats> {
  const sessionsDir = options.sessionsDir ?? join(getDataDir(), 'sessions');
  const cache = options.cache ?? defaultCache;

  const files = await findWireFiles(sessionsDir);
  const perFile = await mapWithConcurrency(files, WIRE_PARSE_CONCURRENCY, async (file) => ({
    file,
    parsed: await parseForFile(file, cache),
  }));

  const byDay = new Map<string, number>();
  const byModel = new Map<string, number>();
  const sessionDirs = new Set<string>();
  const sessionSpans = new Map<string, { first: number; last: number }>();
  let totalTokens = 0;

  for (const { file, parsed } of perFile) {
    sessionDirs.add(sessionDirOf(sessionsDir, file));
    for (const contribution of parsed.contributions) {
      byDay.set(contribution.day, (byDay.get(contribution.day) ?? 0) + contribution.tokens);
      totalTokens += contribution.tokens;
    }
    for (const [model, tokens] of parsed.modelTotals ?? []) {
      byModel.set(model, (byModel.get(model) ?? 0) + tokens);
    }
    if (parsed.firstTimeMs !== undefined && parsed.lastTimeMs !== undefined) {
      const key = sessionDirOf(sessionsDir, file);
      const span = sessionSpans.get(key);
      sessionSpans.set(key, {
        first: Math.min(span?.first ?? parsed.firstTimeMs, parsed.firstTimeMs),
        last: Math.max(span?.last ?? parsed.lastTimeMs, parsed.lastTimeMs),
      });
    }
  }

  const topEntry = (
    entries: Iterable<readonly [string, number]>,
  ): { key: string; value: number } | undefined => {
    let best: { key: string; value: number } | undefined;
    for (const [key, value] of entries) {
      if (best === undefined || value > best.value || (value === best.value && key < best.key)) {
        best = { key, value };
      }
    }
    return best;
  };

  const peakDay = topEntry(byDay.entries());
  const topModel = topEntry(byModel.entries());

  let longestSessionMs: number | undefined;
  for (const { first, last } of sessionSpans.values()) {
    if (last <= first) continue;
    longestSessionMs = Math.max(longestSessionMs ?? 0, last - first);
  }

  return {
    totalTokens,
    activeDays: byDay.size,
    mostActiveDay: peakDay === undefined ? undefined : { date: peakDay.key, tokens: peakDay.value },
    favoriteModel:
      topModel === undefined ? undefined : { model: topModel.key, tokens: topModel.value },
    sessionCount: sessionDirs.size,
    longestSessionMs,
  };
}
