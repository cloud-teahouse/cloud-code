import type { generate, Message, Tool } from '@cloud-code/kosong';

import { estimateTokens } from '../../../src/utils/tokens';

type GenerateFn = typeof generate;

/**
 * Per-request observation of the mock prefix cache: the raw request body is
 * retained inside the cache (account-level prefix store, never exposed), the
 * sample carries only the derived counters.
 */
export interface PrefixCacheRequestSample {
  readonly requestIndex: number;
  readonly totalBytes: number;
  readonly lcpBytes: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface MockPrefixCache {
  /**
   * Harness hook (`TestAgentOptions.wrapGenerate`): wraps the scripted
   * generate so responses stay scripted while the usage cache counters are
   * overridden with the simulated prefix-cache verdict.
   */
  readonly wrapGenerate: (inner: GenerateFn) => GenerateFn;
  readonly samples: readonly PrefixCacheRequestSample[];
}

/**
 * Mock automatic prefix cache with DeepSeek semantics: the cache is
 * account-level (every request body ever seen can serve a prefix, across
 * sessions) and byte-level (a hit is the longest common byte prefix between
 * the outgoing request body and any previously seen body — a mid-history
 * rewrite moves the divergence point instead of invalidating the whole
 * request).
 *
 * For each request the wrapper:
 *   1. serializes the exact wire shape the provider would see (system prompt,
 *      non-deferred tools, history) into a deterministic byte stream;
 *   2. computes the per-byte longest common prefix against every retained
 *      body and keeps the maximum;
 *   3. reports the reusable prefix's token estimate as `inputCacheRead` and
 *      the remaining suffix as `inputCacheCreation` (the same `estimateTokens`
 *      heuristic the compaction chain uses), zeroing `inputOther` because
 *      DeepSeek maps every input token to either hit or miss;
 *   4. retains the body, so a later request can hit a prefix cached by any
 *      earlier one.
 */
export function createMockPrefixCache(): MockPrefixCache {
  const retainedBodies: string[] = [];
  const samples: PrefixCacheRequestSample[] = [];

  const wrapGenerate = (inner: GenerateFn): GenerateFn => {
    const wrapped: GenerateFn = async (
      chat,
      systemPrompt,
      tools,
      history,
      callbacks,
      options,
    ) => {
      const body = serializeRequestBody(systemPrompt, tools, history);
      let lcpBytes = 0;
      for (const retained of retainedBodies) {
        lcpBytes = Math.max(lcpBytes, commonPrefixLength(body, retained));
      }
      retainedBodies.push(body);

      const inputCacheRead = estimateTokens(body.slice(0, lcpBytes));
      const inputCacheCreation = estimateTokens(body.slice(lcpBytes));
      samples.push({
        requestIndex: samples.length,
        totalBytes: body.length,
        lcpBytes,
        inputCacheRead,
        inputCacheCreation,
      });

      const result = await inner(chat, systemPrompt, tools, history, callbacks, options);
      if (result.usage === null) return result;
      return {
        ...result,
        usage: {
          ...result.usage,
          inputOther: 0,
          inputCacheRead,
          inputCacheCreation,
        },
      };
    };
    return wrapped;
  };

  return { wrapGenerate, samples };
}

/**
 * Deterministic request-body serialization for the LCP comparison. Mirrors
 * kosong generate(): deferred tools are stripped before the provider builds
 * the request, so they must not perturb the byte prefix here either.
 */
function serializeRequestBody(
  systemPrompt: string,
  tools: readonly Tool[],
  history: readonly Message[],
): string {
  const wireTools = tools
    .filter((tool) => tool.deferred !== true)
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  return JSON.stringify({ systemPrompt, tools: wireTools, messages: history });
}

/** Length of the longest common prefix, in string index units. */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.codePointAt(index) === b.codePointAt(index)) {
    index += 1;
  }
  return index;
}
