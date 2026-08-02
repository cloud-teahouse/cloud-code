/**
 * Guardian transcript construction (F3). Ported from codex
 * `codex-rs/core/src/guardian/prompt.rs` (`collect_guardian_transcript_entries`,
 * `render_guardian_transcript_entries`, `guardian_truncate_text`) onto Cloud
 * Code's `ContextMessage[]` history, using the repo's char-based
 * `estimateTokens` instead of codex's byte heuristic.
 *
 * Selection is intentionally simple and predictable:
 * - each entry is truncated to its per-entry cap
 * - user and assistant entries share the message budget
 * - tool calls/results use a separate tool budget so tool evidence cannot
 *   crowd out the human conversation
 * - third-party user-role messages (background task / coordinator
 *   notifications) keep their content excluded but leave a fixed host marker
 *   entry where they sat, so consent-bar adjacency stays judgable
 * - if all user turns fit, keep them all; otherwise keep the first and latest
 *   user turns as anchors, then fill the remaining message budget with other
 *   user turns from newest to oldest
 * - after user turns are selected, keep recent non-user entries from newest to
 *   oldest while the budgets and recent-entry limit allow
 */

import type { ContextMessage } from '../context';
import { estimateTokens } from '../../utils/tokens';

export const GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000;
export const GUARDIAN_MAX_TOOL_TRANSCRIPT_TOKENS = 10_000;
export const GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS = 2_000;
export const GUARDIAN_MAX_TOOL_ENTRY_TOKENS = 1_000;
export const GUARDIAN_MAX_ACTION_STRING_TOKENS = 16_000;
export const GUARDIAN_RECENT_ENTRY_LIMIT = 40;

const TRUNCATION_TAG = 'truncated';
/** codex `approx_bytes_for_tokens`: 4 chars per token (ASCII assumption). */
const CHARS_PER_TOKEN = 4;

/**
 * Zero-width space used to neutralize forged transcript structure inside
 * untrusted entry text (design doc §3.3). The host-generated delimiter lines
 * (`>>> TRANSCRIPT START/END` in reviewer.ts) and entry headers (`[N] role:`,
 * rendered in {@link renderGuardianTranscriptEntries}) are never sanitized,
 * so a zero-width-decorated lookalike can never byte-equal the real thing.
 */
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Neutralizes transcript-structure forgery inside untrusted tool/assistant
 * entry text (design doc §3.3, pure string patch):
 * - a line-leading `>>>` gets a zero-width space inserted before it, so a
 *   forged `>>> TRANSCRIPT END` inside tool output can no longer stand in
 *   for the host-generated delimiter lines;
 * - a newline followed by an entry-header lookalike (`[<digits>] <word>:`)
 *   gets a zero-width space inserted before the `[`, so a forged
 *   `[7] user: …` can no longer pass for a real entry header.
 * User entries are exempt (caller side): the user is the authorizer, so
 * forging transcript structure against themselves buys an attacker nothing.
 */
function sanitizeGuardianEntryText(text: string): string {
  return text
    .replace(/^>>>/gm, `${ZERO_WIDTH_SPACE}>>>`)
    .replace(/\n(\[\d+\] \w+:)/g, `\n${ZERO_WIDTH_SPACE}$1`);
}

/**
 * Fixed text of the elided third-party marker. Rendered as a host entry where
 * a non-user-typed user-role message (background task / coordinator
 * notification) sat in the conversation: existence is evidence for consent-bar
 * adjacency, content stays withheld. Host-authored, so never sanitized.
 */
export const GUARDIAN_ELIDED_THIRD_PARTY_TEXT = 'third-party activity (content elided)';

export type GuardianTranscriptEntryKind =
  | { readonly type: 'user' }
  | { readonly type: 'assistant' }
  | { readonly type: 'tool'; readonly role: string }
  | { readonly type: 'elided' };

export interface GuardianTranscriptEntry {
  readonly kind: GuardianTranscriptEntryKind;
  readonly text: string;
}

function roleOf(kind: GuardianTranscriptEntryKind): string {
  switch (kind.type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return kind.role;
    case 'elided':
      return 'host';
  }
}

function textOf(message: ContextMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Retains the human-readable conversation plus recent tool call / result
 * evidence for guardian review. Only real user input (`origin.kind ===
 * 'user'`) counts as a user entry — injections, hook results, compaction
 * summaries, shell-command echoes, and other contextual user-role messages
 * are excluded (transcript hygiene, design doc §7.7). One exception keeps
 * only the EXISTENCE, never the content: background/coordinator task
 * notifications (`origin.kind === 'background_task'`) leave a fixed
 * `elided` marker entry so the reviewer can tell that third-party activity
 * sat between two visible entries (consent-bar Path B adjacency).
 */
export function collectGuardianTranscriptEntries(
  history: readonly ContextMessage[],
): GuardianTranscriptEntry[] {
  const entries: GuardianTranscriptEntry[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const push = (kind: GuardianTranscriptEntryKind, text: string) => {
    if (text.trim().length === 0) return;
    // Only tool/assistant text is untrusted evidence; user entries stay
    // verbatim (design doc §3.3).
    entries.push({
      kind,
      text: kind.type === 'user' ? text : sanitizeGuardianEntryText(text),
    });
  };

  for (const message of history) {
    switch (message.role) {
      case 'user': {
        if (message.origin?.kind === 'user') {
          push({ type: 'user' }, textOf(message));
        } else if (message.origin?.kind === 'background_task') {
          // Third-party speech (background / coordinator task notifications):
          // the content stays excluded (transcript hygiene), but its
          // EXISTENCE is marked so the reviewer can judge Path B adjacency —
          // a user reply after third-party activity is not necessarily
          // answering the agent's proposal. The marker is a fixed
          // host-authored string; nothing from the message leaks.
          push({ type: 'elided' }, GUARDIAN_ELIDED_THIRD_PARTY_TEXT);
        }
        break;
      }
      case 'assistant': {
        push({ type: 'assistant' }, textOf(message));
        for (const call of message.toolCalls) {
          toolNamesByCallId.set(call.id, call.name);
          push(
            { type: 'tool', role: `tool ${call.name} call` },
            call.arguments ?? '',
          );
        }
        break;
      }
      case 'tool': {
        const name =
          message.toolCallId === undefined
            ? undefined
            : toolNamesByCallId.get(message.toolCallId);
        push(
          { type: 'tool', role: name === undefined ? 'tool result' : `tool ${name} result` },
          textOf(message),
        );
        break;
      }
      case 'system':
        break;
    }
  }
  return entries;
}

export interface GuardianTranscriptRender {
  readonly lines: readonly string[];
  /** Present when some entries were dropped by the budgets. */
  readonly omissionNote?: string;
}

export function renderGuardianTranscriptEntries(
  entries: readonly GuardianTranscriptEntry[],
): GuardianTranscriptRender {
  if (entries.length === 0) {
    return { lines: ['<no retained transcript entries>'] };
  }

  const renderedEntries = entries.map((entry, index) => {
    const tokenCap =
      entry.kind.type === 'tool' ? GUARDIAN_MAX_TOOL_ENTRY_TOKENS : GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS;
    const { text } = guardianTruncateText(entry.text, tokenCap);
    const rendered = `[${String(index + 1)}] ${roleOf(entry.kind)}: ${text}`;
    return { rendered, tokenCount: estimateTokens(rendered) };
  });

  const included: boolean[] = Array.from({ length: entries.length }, () => false);
  let messageTokens = 0;
  let toolTokens = 0;
  const userIndices = entries
    .map((entry, index) => (entry.kind.type === 'user' ? index : -1))
    .filter((index) => index !== -1);

  const firstUserIndex = userIndices[0];
  if (firstUserIndex !== undefined) {
    included[firstUserIndex] = true;
    messageTokens += renderedEntries[firstUserIndex]!.tokenCount;
  }

  const lastUserIndex = userIndices.at(-1);
  if (
    lastUserIndex !== undefined &&
    !included[lastUserIndex] &&
    messageTokens + renderedEntries[lastUserIndex]!.tokenCount <=
      GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS
  ) {
    included[lastUserIndex] = true;
    messageTokens += renderedEntries[lastUserIndex]!.tokenCount;
  }

  for (const index of userIndices.toReversed()) {
    if (included[index]) continue;
    const tokenCount = renderedEntries[index]!.tokenCount;
    if (messageTokens + tokenCount > GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS) continue;
    included[index] = true;
    messageTokens += tokenCount;
  }

  let retainedNonUserEntries = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind.type === 'user' || retainedNonUserEntries >= GUARDIAN_RECENT_ENTRY_LIMIT) {
      continue;
    }
    const tokenCount = renderedEntries[index]!.tokenCount;
    const withinBudget =
      entry.kind.type === 'tool'
        ? toolTokens + tokenCount <= GUARDIAN_MAX_TOOL_TRANSCRIPT_TOKENS
        : messageTokens + tokenCount <= GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS;
    if (!withinBudget) continue;
    included[index] = true;
    retainedNonUserEntries += 1;
    if (entry.kind.type === 'tool') {
      toolTokens += tokenCount;
    } else {
      messageTokens += tokenCount;
    }
  }

  const lines = entries
    .map((_, index) => (included[index] ? renderedEntries[index]!.rendered : undefined))
    .filter((line): line is string => line !== undefined);
  const omittedAny = included.some((value) => !value);
  return {
    lines,
    ...(omittedAny ? { omissionNote: 'Some conversation entries were omitted.' } : {}),
  };
}

/**
 * Head+tail truncation (codex `guardian_truncate_text`): entries longer than
 * the cap keep both ends with a `<truncated omitted_approx_tokens="N" />`
 * marker in the middle, so a long injection payload always loses its middle.
 */
export function guardianTruncateText(
  content: string,
  tokenCap: number,
): { readonly text: string; readonly truncated: boolean } {
  if (content.length === 0) return { text: '', truncated: false };

  const maxChars = tokenCap * CHARS_PER_TOKEN;
  if (content.length <= maxChars) return { text: content, truncated: false };

  // codex `approx_tokens_from_byte_count`: the marker's count comes from the
  // budget heuristic so the layout is deterministic (the marker length feeds
  // the head/tail split below); the value is explicitly approximate.
  const omittedTokens = Math.ceil((content.length - maxChars) / CHARS_PER_TOKEN);
  const marker = `<${TRUNCATION_TAG} omitted_approx_tokens="${String(omittedTokens)}" />`;
  if (maxChars <= marker.length) return { text: marker, truncated: true };

  const availableChars = maxChars - marker.length;
  const prefixChars = Math.floor(availableChars / 2);
  const suffixChars = availableChars - prefixChars;
  const prefixEnd = adjustCharBoundary(content, prefixChars);
  const suffixStart = Math.max(
    prefixEnd,
    adjustCharBoundary(content, content.length - suffixChars),
  );
  return {
    text: content.slice(0, prefixEnd) + marker + content.slice(suffixStart),
    truncated: true,
  };
}

/** Move a UTF-16 offset back if it splits a surrogate pair. */
function adjustCharBoundary(content: string, offset: number): number {
  if (offset <= 0 || offset >= content.length) return offset;
  const codePoint = content.codePointAt(offset - 1);
  if (codePoint === undefined) return offset;
  // Paired high surrogate (codePointAt combines) or a lone high surrogate.
  if (codePoint > 0xffff || (codePoint >= 0xd800 && codePoint <= 0xdbff)) {
    return offset - 1;
  }
  return offset;
}
