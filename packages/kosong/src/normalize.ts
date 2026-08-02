/**
 * Defensive wire layer: the last message-validity guarantee before a request
 * leaves the client.
 *
 * This is a pure, host-agnostic complement to the agent-core projector —
 * the two are layered defenses, not duplicate implementations:
 *
 *   - The projector understands history *semantics* (projection levels,
 *     in-flight trailing exchanges, anomaly reporting) and keeps agent-core
 *     histories structurally healthy.
 *   - {@link normalizeMessagesForWire} knows nothing about history; it only
 *     guarantees message-*internal* wire legality (parseable tool-call
 *     arguments, non-empty tool names) plus a simplified pairing fallback
 *     (orphan results dropped, unanswered calls closed) for hosts that have
 *     no projector — direct kosong consumers, imported external histories,
 *     sessions resumed from records written by older versions.
 *
 * Blind spot this closes: the Anthropic and Google GenAI converters
 * `JSON.parse` tool-call arguments and hard-throw `ChatProviderError` on
 * invalid JSON — and on valid JSON that is not an object (they require a
 * JSON object) — before the request is dispatched, so the error is not an
 * `APIStatusError` and bypasses every retry/fallback chain, wedging the
 * session permanently.
 *
 * Cost discipline: a healthy history takes the fast path and is returned as
 * the SAME array reference (zero copy), preserving reference equality for
 * downstream shallow-copy chains and identity caches. Repairs are
 * copy-on-write — the caller's array and message objects are never mutated —
 * and their products (closed argument strings, placeholder names, synthesized
 * results) go to the wire only; they are never written back into history.
 */

import { createToolMessage, type Message, type ToolCall } from './message';

/**
 * Repair kinds reported through {@link NormalizeOptions.onRepair}.
 *
 * - `arguments_closed`: truncated tool-call arguments JSON was closed
 *   best-effort (unterminated string, dangling `,`/`:` , unclosed brackets).
 * - `arguments_fallback_empty`: arguments were unrecoverable and replaced
 *   with `{}`.
 * - `arguments_fallback_non_object`: arguments were valid JSON but not an
 *   object (the provider converters require a JSON object) and were replaced
 *   with `{}`.
 * - `empty_tool_name`: an empty tool-call name was backfilled with a
 *   deterministic placeholder ({@link UNKNOWN_TOOL_NAME}).
 * - `orphan_tool_result_dropped`: a tool message whose id matches no
 *   immediately-preceding assistant call was dropped.
 * - `missing_tool_result_synthesized`: an unanswered call was closed with a
 *   placeholder result.
 */
export type NormalizeRepairKind =
  | 'arguments_closed'
  | 'arguments_fallback_empty'
  | 'arguments_fallback_non_object'
  | 'empty_tool_name'
  | 'orphan_tool_result_dropped'
  | 'missing_tool_result_synthesized';

export interface NormalizeOptions {
  /**
   * Fires once per applied repair, in message order. kosong is a pure library
   * with no logger; hosts that want observability (log/telemetry) wire this
   * up themselves.
   */
  readonly onRepair?: ((kind: NormalizeRepairKind, toolCallId: string) => void) | undefined;
}

/** Deterministic placeholder for tool calls whose name streamed in empty. */
export const UNKNOWN_TOOL_NAME = 'unknown_tool';

/**
 * Placeholder body for results synthesized to close an unanswered call.
 * Mirrors the agent-core projector's synthetic-result text so a repaired
 * exchange reads the same regardless of which layer closed it.
 */
const SYNTHETIC_TOOL_RESULT_TEXT =
  'Tool result is not available in the current context. Do not assume the tool completed successfully.';

/**
 * Return a wire-legal view of `messages`: the same array reference when the
 * history is already healthy, otherwise a repaired copy.
 *
 * Fast path holds iff:
 * - every assistant tool call has a non-empty name and arguments that are
 *   `null`, empty/whitespace, or a valid JSON object (valid JSON that is an
 *   array/scalar takes the repair path — the converters require an object);
 * - every assistant message's calls are all answered by the contiguous tool
 *   block immediately following it (ids matched as a multiset, so duplicate
 *   id pairs produced by lax providers pass through verbatim — deduplicating
 *   them is a projection-level semantic decision this layer must not make);
 * - no orphan tool messages exist outside such a block.
 *
 * Anything else takes the repair path (copy-on-write).
 */
export function normalizeMessagesForWire(
  messages: Message[],
  options?: NormalizeOptions,
): Message[] {
  return tryNormalizeFastPath(messages) ?? repairMessages(messages, options?.onRepair);
}

function tryNormalizeFastPath(messages: Message[]): Message[] | undefined {
  // Multiset of the immediately-preceding assistant's unanswered call ids;
  // `undefined` when the previous message cannot open a tool block.
  let pending: Map<string, number> | undefined;
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId;
      const remaining = id === undefined ? undefined : pending?.get(id);
      if (remaining === undefined || remaining === 0) return undefined;
      pending!.set(id!, remaining - 1);
      continue;
    }
    // A non-tool message closes the current block: unanswered calls fail.
    if (pending !== undefined && pendingCount(pending) > 0) return undefined;
    pending = undefined;
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        if (call.name.trim().length === 0) return undefined;
        if (!isValidOrEmptyJsonObjectCached(call)) return undefined;
      }
      pending = new Map();
      for (const call of message.toolCalls) {
        pending.set(call.id, (pending.get(call.id) ?? 0) + 1);
      }
    }
  }
  // A trailing exchange left open at send time is never valid on the wire
  // (every provider requires results after calls), so it is not fast-path
  // healthy either; the repair path closes it.
  if (pending !== undefined && pendingCount(pending) > 0) return undefined;
  return messages;
}

function repairMessages(
  messages: Message[],
  onRepair: ((kind: NormalizeRepairKind, toolCallId: string) => void) | undefined,
): Message[] {
  const out: Message[] = [];
  let pending: Map<string, number> | undefined;
  // Close the current block: synthesize results for unanswered calls.
  const flushPending = (): void => {
    if (pending === undefined) return;
    for (const [id, count] of pending) {
      for (let i = 0; i < count; i++) {
        onRepair?.('missing_tool_result_synthesized', id);
        out.push(createToolMessage(id, SYNTHETIC_TOOL_RESULT_TEXT));
      }
    }
    pending = undefined;
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId;
      const remaining = id === undefined ? undefined : pending?.get(id);
      if (remaining === undefined || remaining === 0) {
        // No matching call in the immediately-preceding assistant (includes
        // displaced results — reordering is the projector's job, this layer
        // only guarantees legality).
        onRepair?.('orphan_tool_result_dropped', id ?? '');
        continue;
      }
      pending!.set(id!, remaining - 1);
      out.push(message);
      continue;
    }
    flushPending();
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const repaired = repairToolCalls(message, onRepair);
      out.push(repaired);
      pending = new Map();
      for (const call of repaired.toolCalls) {
        pending.set(call.id, (pending.get(call.id) ?? 0) + 1);
      }
      continue;
    }
    out.push(message);
  }
  flushPending();
  return out;
}

/** Copy-on-write per-message repair; returns the input untouched when clean. */
function repairToolCalls(
  message: Message,
  onRepair: ((kind: NormalizeRepairKind, toolCallId: string) => void) | undefined,
): Message {
  let repaired: ToolCall[] | undefined;
  const usedNames = new Set(message.toolCalls.map((call) => call.name));
  for (let i = 0; i < message.toolCalls.length; i++) {
    const call = message.toolCalls[i]!;
    let next: ToolCall | undefined;

    if (call.name.trim().length === 0) {
      const name = placeholderToolName(usedNames);
      usedNames.add(name);
      next = { ...call, name };
      onRepair?.('empty_tool_name', call.id);
    }

    const args = next?.arguments ?? call.arguments;
    if (args !== null && args.trim().length > 0 && !parsesToJsonObject(args)) {
      if (isValidJson(args)) {
        // Valid JSON but not an object ('[1,2]', '"abc"', '123'): the
        // provider converters require a JSON object and hard-throw on
        // anything else, so the arguments cannot be preserved on the wire.
        next = { ...(next ?? call), arguments: '{}' };
        onRepair?.('arguments_fallback_non_object', call.id);
      } else {
        const closed = closeTruncatedJson(args);
        if (closed !== '{}' && parsesToJsonObject(closed)) {
          next = { ...(next ?? call), arguments: closed };
          onRepair?.('arguments_closed', call.id);
        } else {
          // Unrecoverable — including fragments that only close to a
          // non-object ('[1,2' → '[1,2]'), which the converters would still
          // reject.
          next = { ...(next ?? call), arguments: '{}' };
          onRepair?.('arguments_fallback_empty', call.id);
        }
      }
    }

    if (next !== undefined) {
      repaired ??= message.toolCalls.slice(0, i);
      repaired.push(next);
    } else {
      repaired?.push(call);
    }
  }
  return repaired === undefined ? message : { ...message, toolCalls: repaired };
}

function placeholderToolName(usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(UNKNOWN_TOOL_NAME)) return UNKNOWN_TOOL_NAME;
  for (let i = 2; ; i++) {
    const candidate = `${UNKNOWN_TOOL_NAME}_${String(i)}`;
    if (!usedNames.has(candidate)) return candidate;
  }
}

function pendingCount(pending: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of pending.values()) total += count;
  return total;
}

function isValidOrEmptyJsonObject(text: string | null): boolean {
  if (text === null) return true;
  if (text.trim().length === 0) return true;
  // Cheap pre-scan: an unbalanced candidate (unterminated string, unclosed
  // brackets) cannot be valid JSON — skip the JSON.parse object
  // materialization and go straight to the repair path.
  if (!isBalancedJsonCandidate(text)) return false;
  return parsesToJsonObject(text);
}

/**
 * Per-ToolCall verdict cache for the fast path. A healthy history is
 * re-validated on every request, so JSON.parse of every historical tool
 * call's arguments would otherwise run once per request per call. The cache
 * is keyed by ToolCall identity and stores the producing `arguments` string
 * reference alongside the verdict: streaming accumulation always REPLACES
 * `call.arguments` with a new string rather than mutating in place, so a
 * matching reference guarantees identical content (string identity implies
 * value equality) and any reassignment simply misses the cache. Stale
 * verdicts are therefore impossible.
 */
const argumentsValidityCache = new WeakMap<
  ToolCall,
  { arguments: string | null; valid: boolean }
>();

function isValidOrEmptyJsonObjectCached(call: ToolCall): boolean {
  const cached = argumentsValidityCache.get(call);
  if (cached !== undefined && cached.arguments === call.arguments) {
    return cached.valid;
  }
  const valid = isValidOrEmptyJsonObject(call.arguments);
  argumentsValidityCache.set(call, { arguments: call.arguments, valid });
  return valid;
}

/**
 * Parse check: true only when the text is valid JSON *and* an object
 * (arrays, strings, numbers, booleans and `null` fail) — the shape every
 * provider converter requires of tool-call arguments.
 */
function parsesToJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan-only balance check: true when the text ends outside a string with all
 * brackets closed. Does not verify bracket-type pairing (`{]` passes here and
 * is caught by the subsequent JSON.parse) — it exists to route obviously
 * truncated payloads to the repair path without materializing huge argument
 * strings through JSON.parse on every request.
 */
function isBalancedJsonCandidate(text: string): boolean {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return !inString && depth === 0;
}

/**
 * Best-effort close of truncated JSON: unterminated strings are closed
 * (dangling escapes dropped first), dangling `,` separators are removed,
 * dangling `:` are filled with `null`, and open brackets are closed in
 * reverse order. Returns the closed string when it parses, otherwise `{}`.
 *
 * The caller is responsible for the empty-input case (empty/whitespace
 * arguments are legal on the wire and pass through untouched).
 */
export function closeTruncatedJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '{}';

  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack.at(-1) === '{') stack.pop();
    } else if (ch === ']') {
      if (stack.at(-1) === '[') stack.pop();
    }
  }

  let body = trimmed;
  if (escaped) body = body.slice(0, -1);
  if (inString) {
    body += '"';
  } else {
    // Trailing separators dangle outside a string: drop commas, fill colons.
    // Whitespace outside a string is insignificant, so trimEnd is safe here
    // (it is NOT safe once we have appended a closing quote above).
    for (;;) {
      body = body.trimEnd();
      if (body.endsWith(',')) {
        body = body.slice(0, -1);
        continue;
      }
      if (body.endsWith(':')) {
        body += 'null';
        continue;
      }
      break;
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    body += stack[i] === '{' ? '}' : ']';
  }

  return isValidJson(body) ? body : '{}';
}
