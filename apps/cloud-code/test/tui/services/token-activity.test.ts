import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyTokenActivityProvider,
  loadTokenActivity,
  loadTokenActivityStats,
  parseWireFileChunked,
  parseWireTokenActivity,
  WIRE_PARSE_CHUNK_BYTES,
  type TokenActivityCache,
} from '#/tui/services/token-activity';

/** Local-time epoch ms for a fixture day (buckets follow the local timezone). */
function at(day: string, hour = 12): number {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();
}

interface UsageLine {
  readonly model?: string;
  readonly provider?: string;
  readonly day: string;
  readonly inputOther?: number;
  readonly output?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
}

function wireLines(records: readonly UsageLine[]): string {
  const lines: string[] = [
    JSON.stringify({ type: 'metadata', protocol_version: '1', created_at: at('2026-07-01', 9) }),
  ];
  const seenProviders = new Set<string>();
  for (const record of records) {
    if (record.provider !== undefined && !seenProviders.has(record.provider)) {
      seenProviders.add(record.provider);
      lines.push(
        JSON.stringify({
          type: 'llm.request',
          kind: 'loop',
          provider: record.provider,
          model: record.model ?? 'unknown',
          time: at(record.day),
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: 'usage.record',
        model: record.model ?? 'unknown',
        usageScope: 'turn',
        usage: {
          inputOther: record.inputOther ?? 0,
          output: record.output ?? 0,
          inputCacheRead: record.inputCacheRead ?? 0,
          inputCacheCreation: record.inputCacheCreation ?? 0,
        },
        time: at(record.day),
      }),
    );
  }
  return lines.join('\n') + '\n';
}

let root: string;
let sessionsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'token-activity-'));
  sessionsDir = join(root, 'sessions');

  // Legacy depth-3 layout: <bucket>/<session>/wire.jsonl (Kimi session).
  const kimiDir = join(sessionsDir, 'bucket-a', 'sess-kimi');
  await mkdir(kimiDir, { recursive: true });
  await writeFile(
    join(kimiDir, 'wire.jsonl'),
    wireLines([
      // Two records the same day → summed (100+50+20+10) + (100+100) = 380.
      {
        model: 'kimi-k2',
        provider: 'managed:kimi-code',
        day: '2026-07-20',
        inputOther: 100,
        output: 50,
        inputCacheRead: 20,
        inputCacheCreation: 10,
      },
      { model: 'kimi-k2', day: '2026-07-20', inputOther: 100, output: 100 },
      { model: 'kimi-k2', day: '2026-07-22', output: 500 },
    ]),
  );

  // Depth-5 layout: <bucket>/<session>/agents/<agent>/wire.jsonl (GPT session),
  // sharing one day with the Kimi session to exercise cross-file merging.
  const gptDir = join(sessionsDir, 'bucket-b', 'sess-gpt', 'agents', 'main');
  await mkdir(gptDir, { recursive: true });
  await writeFile(
    join(gptDir, 'wire.jsonl'),
    wireLines([
      { model: 'gpt-5', provider: 'managed:chatgpt-codex', day: '2026-07-20', output: 1000 },
      { model: 'gpt-5', day: '2026-07-21', output: 2000 },
    ]),
  );

  // Session whose model has no llm.request record → provider undefined.
  const customDir = join(sessionsDir, 'bucket-b', 'sess-custom');
  await mkdir(customDir, { recursive: true });
  await writeFile(
    join(customDir, 'wire.jsonl'),
    `${JSON.stringify({
      type: 'usage.record',
      model: 'my-local-model',
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      time: at('2026-07-20'),
    })}\n{"type":"usage.record","model":`, // torn tail line must be skipped
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadTokenActivity', () => {
  it('merges every wire.jsonl into daily buckets', async () => {
    const { buckets, providers } = await loadTokenActivity({ sessionsDir });
    expect(buckets).toEqual([
      { date: '2026-07-20', tokens: 380 + 1000 + 15 },
      { date: '2026-07-21', tokens: 2000 },
      { date: '2026-07-22', tokens: 500 },
    ]);
    expect(providers).toEqual(['managed:chatgpt-codex', 'managed:kimi-code']);
  });

  it('filters by provider (Kimi / ChatGPT / unknown)', async () => {
    const kimi = await loadTokenActivity({
      sessionsDir,
      provider: (p) => classifyTokenActivityProvider(p) === 'kimi',
    });
    expect(kimi.buckets).toEqual([
      { date: '2026-07-20', tokens: 380 },
      { date: '2026-07-22', tokens: 500 },
    ]);

    const chatgpt = await loadTokenActivity({
      sessionsDir,
      provider: (p) => classifyTokenActivityProvider(p) === 'chatgpt',
    });
    expect(chatgpt.buckets).toEqual([
      { date: '2026-07-20', tokens: 1000 },
      { date: '2026-07-21', tokens: 2000 },
    ]);

    const unknown = await loadTokenActivity({
      sessionsDir,
      provider: (p) => p === undefined,
    });
    expect(unknown.buckets).toEqual([{ date: '2026-07-20', tokens: 15 }]);
  });

  it('returns no buckets for a missing sessions directory', async () => {
    const { buckets, providers } = await loadTokenActivity({
      sessionsDir: join(root, 'no-such-dir'),
    });
    expect(buckets).toEqual([]);
    expect(providers).toEqual([]);
  });

  it('serves repeat loads from the mtime+size cache', async () => {
    const cache: TokenActivityCache = new Map();
    const first = await loadTokenActivity({ sessionsDir, cache });
    expect(cache.size).toBe(3);

    // Seed a matching (mtimeMs, size) entry with sentinel contributions: a
    // cache hit must reuse the parse instead of reading the file.
    const kimiWire = join(sessionsDir, 'bucket-a', 'sess-kimi', 'wire.jsonl');
    const info = await stat(kimiWire);
    cache.set(kimiWire, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      contributions: [{ day: '1999-01-01', tokens: 42, provider: 'managed:kimi-code' }],
    });
    const second = await loadTokenActivity({ sessionsDir, cache });
    expect(second.buckets).toContainEqual({ date: '1999-01-01', tokens: 42 });
    expect(second.buckets).not.toContainEqual({ date: '2026-07-22', tokens: 500 });

    // A stale entry (mtime moved) is re-parsed from disk.
    const freshFirst = first.buckets;
    cache.set(kimiWire, {
      mtimeMs: info.mtimeMs - 1000,
      size: info.size,
      contributions: [{ day: '1999-01-01', tokens: 42, provider: 'managed:kimi-code' }],
    });
    const third = await loadTokenActivity({ sessionsDir, cache });
    expect(third.buckets).toEqual(freshFirst);
  });
});

describe('event-loop responsiveness', () => {
  it('yields to the event loop once per parse slice', async () => {
    // Regression for the /status input freeze: a cold-cache parse used to run
    // each file's whole JSON.parse loop in one macrotask, pinning the event
    // loop (input/repaints starved) right after the dialog opened. Feeding
    // the parser a string keeps I/O out of the measurement: every observed
    // event-loop turn is a parse-slice yield.
    const record = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2',
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      time: at('2026-07-20'),
      // Pad each line to ~1KB so the byte budget maps to a line count.
      pad: 'x'.repeat(860),
    });

    const countTurns = async (lineCount: number): Promise<number> => {
      const load = parseWireFileChunked(`${record}\n`.repeat(lineCount));
      let turns = 0;
      let done = false;
      const markDone = (): void => {
        done = true;
      };
      void load.then(markDone, markDone);
      while (!done) {
        turns += 1;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      const parsed = await load;
      expect(parsed.contributions).toHaveLength(lineCount);
      return turns;
    };

    const subSlice = await countTurns(10);
    // +1 line so the third slice boundary isn't the final line (the parser
    // skips a yield that would fire after the last line).
    const linesPerSlice = Math.ceil(WIRE_PARSE_CHUNK_BYTES / (record.length + 1));
    const threeSlices = await countTurns(linesPerSlice * 3 + 1);
    // A sub-slice parse never yields (single turn); three slices yield three
    // times. An unsliced whole-file parse would resolve in one turn too.
    expect(subSlice).toBeLessThanOrEqual(1);
    expect(threeSlices).toBeGreaterThanOrEqual(3);
  });

  it('serves concurrent loads from one shared read+parse per file', async () => {
    // /status fires the heatmap and aggregate-stats loads together; with
    // separate cold caches they must still share the underlying file parse.
    const cacheA: TokenActivityCache = new Map();
    const cacheB: TokenActivityCache = new Map();
    const [activity, stats] = await Promise.all([
      loadTokenActivity({ sessionsDir, cache: cacheA }),
      loadTokenActivityStats({ sessionsDir, cache: cacheB }),
    ]);
    expect(activity.buckets).toEqual([
      { date: '2026-07-20', tokens: 380 + 1000 + 15 },
      { date: '2026-07-21', tokens: 2000 },
      { date: '2026-07-22', tokens: 500 },
    ]);
    expect(stats.totalTokens).toBe(3895);
    expect(cacheA.size).toBe(3);
    expect(cacheB.size).toBe(3);
  });
});

describe('parseWireTokenActivity', () => {
  it('sums all four usage fields and resolves providers per model', () => {
    const contributions = parseWireTokenActivity(
      wireLines([
        {
          model: 'kimi-k2',
          provider: 'managed:kimi-code',
          day: '2026-07-20',
          inputOther: 1,
          output: 2,
          inputCacheRead: 4,
          inputCacheCreation: 8,
        },
      ]),
    );
    expect(contributions).toEqual([
      { day: '2026-07-20', tokens: 15, provider: 'managed:kimi-code' },
    ]);
  });

  it('accepts seconds-epoch timestamps and skips zero-usage records', () => {
    const seconds = Math.floor(at('2026-07-20') / 1000);
    const content = [
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-k2',
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        time: seconds,
      }),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-k2',
        usage: { inputOther: 7, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        time: seconds,
      }),
    ].join('\n');
    expect(parseWireTokenActivity(content)).toEqual([
      { day: '2026-07-20', tokens: 7, provider: undefined },
    ]);
  });

  it('tolerates torn lines and records without a usage payload', () => {
    const content = [
      '{"type":"usage.record","model":"a","usage":{"output":5},"time":',
      JSON.stringify({ type: 'usage.record', model: 'a', time: at('2026-07-20') }),
      JSON.stringify({ type: 'usage.record', model: 'a', usage: 'nope', time: at('2026-07-20') }),
      JSON.stringify({
        type: 'usage.record',
        model: 'a',
        usage: { output: 5 },
        time: at('2026-07-20'),
      }),
    ].join('\n');
    expect(parseWireTokenActivity(content)).toEqual([
      { day: '2026-07-20', tokens: 5, provider: undefined },
    ]);
  });
});

describe('loadTokenActivityStats', () => {
  it('aggregates all-time facts across sessions and layouts', async () => {
    const stats = await loadTokenActivityStats({ sessionsDir });
    expect(stats.totalTokens).toBe(380 + 500 + 1000 + 2000 + 15);
    expect(stats.activeDays).toBe(3);
    expect(stats.mostActiveDay).toEqual({ date: '2026-07-21', tokens: 2000 });
    // gpt-5 (3000) out-sums kimi-k2 (880) and my-local-model (15).
    expect(stats.favoriteModel).toEqual({ model: 'gpt-5', tokens: 3000 });
    // Three distinct session dirs; the agents/main layout is not double-counted.
    expect(stats.sessionCount).toBe(3);
    // sess-kimi spans metadata.created_at (07-01 09:00) → last record (07-22 12:00).
    expect(stats.longestSessionMs).toBe(at('2026-07-22') - at('2026-07-01', 9));
  });

  it('returns zeros and undefined facts for a missing sessions directory', async () => {
    const stats = await loadTokenActivityStats({ sessionsDir: join(root, 'no-such-dir') });
    expect(stats).toEqual({
      totalTokens: 0,
      activeDays: 0,
      mostActiveDay: undefined,
      favoriteModel: undefined,
      sessionCount: 0,
      longestSessionMs: undefined,
    });
  });

  it('leaves longestSessionMs undefined when no session has two timed records', async () => {
    const singleRoot = await mkdtemp(join(tmpdir(), 'token-activity-single-'));
    try {
      const dir = join(singleRoot, 'sessions');
      for (const session of ['sess-one', 'sess-two']) {
        await mkdir(join(dir, 'bucket', session), { recursive: true });
        await writeFile(
          join(dir, 'bucket', session, 'wire.jsonl'),
          `${JSON.stringify({
            type: 'usage.record',
            model: 'm',
            usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
            time: at('2026-07-20'),
          })}\n`,
        );
      }
      const stats = await loadTokenActivityStats({ sessionsDir: dir });
      expect(stats.sessionCount).toBe(2);
      expect(stats.longestSessionMs).toBeUndefined();
    } finally {
      await rm(singleRoot, { recursive: true, force: true });
    }
  });

  it('shares the parse cache with loadTokenActivity', async () => {
    const cache: TokenActivityCache = new Map();
    await loadTokenActivity({ sessionsDir, cache });
    expect(cache.size).toBe(3);
    // Stats must hit the same entries (no re-parse, no growth).
    const stats = await loadTokenActivityStats({ sessionsDir, cache });
    expect(cache.size).toBe(3);
    expect(stats.totalTokens).toBe(3895);

    // A hand-seeded entry without stats fields degrades gracefully.
    const kimiWire = join(sessionsDir, 'bucket-a', 'sess-kimi', 'wire.jsonl');
    const info = await stat(kimiWire);
    cache.set(kimiWire, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      contributions: [{ day: '1999-01-01', tokens: 42, provider: 'managed:kimi-code' }],
    });
    const degraded = await loadTokenActivityStats({ sessionsDir, cache });
    expect(degraded.totalTokens).toBe(42 + 3000 + 15);
    expect(degraded.sessionCount).toBe(3);
  });
});

describe('classifyTokenActivityProvider', () => {
  it('maps provider ids to the two managed accounts', () => {
    expect(classifyTokenActivityProvider('managed:kimi-code')).toBe('kimi');
    expect(classifyTokenActivityProvider('managed:chatgpt-codex')).toBe('chatgpt');
    expect(classifyTokenActivityProvider('openai-compatible')).toBe('chatgpt');
    expect(classifyTokenActivityProvider('my-anthropic')).toBe('other');
    expect(classifyTokenActivityProvider(undefined)).toBeUndefined();
  });
});
