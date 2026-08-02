/**
 * MCP needs-auth cache — anti-avalanche guard ported from Claude Code's
 * `client.ts`.
 *
 * The failure mode: an OAuth token dies, and every connection attempt to
 * that server rediscovers the 401 the hard way — full OAuth discovery +
 * token refresh, per attempt, per process. A hundred concurrent calls all
 * refreshing at once is a token-endpoint denial-of-service ("认证雪崩").
 *
 * The cache records `{ serverName: { timestamp } }` in
 * `<brand home>/mcp-needs-auth-cache.json`. While an entry is younger than
 * {@link MCP_AUTH_CACHE_TTL_MS} (15 min), automatic connection attempts to
 * that server short-circuit straight to `needs-auth` without touching the
 * network; explicit user actions (`/mcp-config login` → `reconnect()`)
 * bypass the cache, and a successful connect clears the entry.
 *
 * Reads are memoized so N concurrent checks during a batched `connectAll`
 * share one file read; writes are serialized through a promise chain so
 * simultaneous 401s from several servers cannot interleave a
 * read-modify-write into a lost entry. Both are best-effort — a lost or
 * corrupt cache file only costs one extra 401 round-trip, which then
 * re-marks the entry (self-healing).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'pathe';

/** Upstream TTL: 15 minutes. */
export const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000;

export type McpAuthCacheData = Record<string, { timestamp: number }>;

export interface McpAuthCacheOptions {
  /** Cache file location, e.g. `<brand home>/mcp-needs-auth-cache.json`. */
  readonly path: string;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class McpAuthCache {
  private readonly path: string;
  private readonly now: () => number;
  private readPromise: Promise<McpAuthCacheData> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: McpAuthCacheOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
  }

  /** True when the server recorded an auth failure less than the TTL ago. */
  async isFresh(serverName: string): Promise<boolean> {
    const cache = await this.read();
    const entry = cache[serverName];
    if (entry === undefined) return false;
    return this.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS;
  }

  /** Record an auth failure. Awaitable; callers may fire-and-forget. */
  mark(serverName: string): Promise<void> {
    return this.enqueue(async () => {
      const cache = await this.read();
      cache[serverName] = { timestamp: this.now() };
      await this.persist(cache);
    });
  }

  /** Drop a server's entry after a successful (re)connect. */
  clear(serverName: string): Promise<void> {
    return this.enqueue(async () => {
      const cache = await this.read();
      if (!(serverName in cache)) return;
      delete cache[serverName];
      await this.persist(cache);
    });
  }

  private read(): Promise<McpAuthCacheData> {
    this.readPromise ??= readFile(this.path, 'utf-8')
      .then((text) => JSON.parse(text) as McpAuthCacheData)
      .catch(() => ({}));
    return this.readPromise;
  }

  private async persist(cache: McpAuthCacheData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(cache));
    // Invalidate the memo so the next read re-reads the file (picking up
    // other processes' entries too); the write chain serializes our own
    // writes, so a queued mutation re-reads with this entry present.
    this.readPromise = undefined;
  }

  /** Await every queued write (graceful-shutdown flush; test determinism). */
  pendingWrites(): Promise<void> {
    return this.writeChain;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task);
    this.writeChain = next.catch(() => {
      // Best-effort cache write — never let persistence failures surface.
    });
    return next.catch(() => {});
  }
}
