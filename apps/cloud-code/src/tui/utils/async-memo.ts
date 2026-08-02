/**
 * Short-TTL async memoization for expensive reads behind interactive panels
 * (e.g. `/status` re-opens). One in-flight call per key is shared between
 * concurrent callers (no double-fetch), and resolved values stay fresh for
 * `ttlMs` counted from settle time. Rejections — and results the caller
 * marks uncacheable — are evicted once settled so the next call retries.
 */

export interface AsyncTtlMemo<A extends readonly unknown[], R> {
  (...args: A): Promise<R>;
  /** Drop every cached entry (test hook / explicit invalidation). */
  clear(): void;
}

export interface AsyncTtlMemoOptions<A extends readonly unknown[], R> {
  /** Cache key for the arguments; defaults to a single shared bucket. */
  readonly key?: (...args: A) => string;
  /** Return false for results that must not be cached (e.g. error payloads). */
  readonly cacheWhen?: (result: R) => boolean;
}

interface MemoEntry<R> {
  readonly promise: Promise<R>;
  /** Infinity while in flight; the expiry timestamp once settled. */
  freshUntil: number;
}

export function createAsyncTtlMemo<A extends readonly unknown[], R>(
  fn: (...args: A) => Promise<R>,
  ttlMs: number,
  options: AsyncTtlMemoOptions<A, R> = {},
): AsyncTtlMemo<A, R> {
  const keyFn = options.key ?? ((): string => '');
  const cacheWhen = options.cacheWhen ?? ((): boolean => true);
  const entries = new Map<string, MemoEntry<R>>();

  const memoized = (...args: A): Promise<R> => {
    const key = keyFn(...args);
    const hit = entries.get(key);
    if (hit !== undefined && hit.freshUntil > Date.now()) return hit.promise;

    const entry: MemoEntry<R> = { promise: fn(...args), freshUntil: Number.POSITIVE_INFINITY };
    entries.set(key, entry);
    void entry.promise.then(
      (result) => {
        if (entries.get(key) !== entry) return;
        if (cacheWhen(result)) {
          entry.freshUntil = Date.now() + ttlMs;
        } else {
          entries.delete(key);
        }
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return entry.promise;
  };
  memoized.clear = (): void => {
    entries.clear();
  };
  return memoized;
}
