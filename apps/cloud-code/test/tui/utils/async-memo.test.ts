import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAsyncTtlMemo } from '#/tui/utils/async-memo';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAsyncTtlMemo', () => {
  it('shares one in-flight call between concurrent callers', async () => {
    const gate = deferred<number>();
    const fn = vi.fn(() => gate.promise);
    const memo = createAsyncTtlMemo(fn, 1_000);

    const a = memo();
    const b = memo();
    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve(42);
    await expect(a).resolves.toBe(42);
    await expect(b).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('serves fresh results from the cache and reloads after the TTL', async () => {
    vi.useFakeTimers();
    let value = 0;
    const fn = vi.fn(async () => ++value);
    const memo = createAsyncTtlMemo(fn, 1_000);

    await expect(memo()).resolves.toBe(1);
    await expect(memo()).resolves.toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    await expect(memo()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(memo()).resolves.toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keys entries by the key function', async () => {
    const fn = vi.fn(async (provider: string | undefined) => `usage:${provider ?? 'default'}`);
    const memo = createAsyncTtlMemo(fn, 60_000, { key: (provider) => provider ?? '' });

    await expect(memo('a')).resolves.toBe('usage:a');
    await expect(memo('b')).resolves.toBe('usage:b');
    await expect(memo('a')).resolves.toBe('usage:a');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts rejections so the next call retries', async () => {
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(7);
    const memo = createAsyncTtlMemo(fn, 60_000);

    await expect(memo()).rejects.toThrow('boom');
    await expect(memo()).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not cache results cacheWhen rejects (but still dedupes in-flight)', async () => {
    const gate = deferred<{ error?: string }>();
    const fn = vi.fn(() => gate.promise);
    const memo = createAsyncTtlMemo(fn, 60_000, { cacheWhen: (result) => result.error === undefined });

    const a = memo();
    const b = memo();
    gate.resolve({ error: 'nope' });
    await expect(a).resolves.toEqual({ error: 'nope' });
    await expect(b).resolves.toEqual({ error: 'nope' });
    expect(fn).toHaveBeenCalledTimes(1);

    await memo();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clear() drops every cached entry', async () => {
    let value = 0;
    const fn = vi.fn(async () => ++value);
    const memo = createAsyncTtlMemo(fn, 60_000);

    await expect(memo()).resolves.toBe(1);
    memo.clear();
    await expect(memo()).resolves.toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
