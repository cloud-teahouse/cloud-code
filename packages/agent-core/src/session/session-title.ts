/**
 * AI-generated session titles.
 *
 * After the first user prompt lands, the session runs one cheap side-channel
 * call through the `Agent.generate` choke point (the same pattern as
 * compaction and the guardian reviewer: `llm.request` wire records, auth
 * resolution, and diagnostic logging for free — no sub-session, no tools) to
 * replace the truncated-first-message fallback title with a 3-7 word
 * sentence-case title. Any failure — no provider, transport error, or output
 * that ignores the contract — returns null and the caller keeps the fallback.
 */

import { createUserMessage } from '@cloud-code/kosong';

import type { Agent } from '../agent';
import type { GenerateOptionsWithRequestLogFields } from '../agent/llm-request-logger';

export const SESSION_TITLE_TIMEOUT_MS = 30_000;

/** Input slice sent to the title model: recent context wins, so keep the tail. */
const MAX_TITLE_INPUT_LENGTH = 1000;
/**
 * Hard cap on an accepted title. The contract asks for 3-7 words (well under
 * this); a longer response means the model ignored the contract, so it is
 * rejected and the truncated-prompt fallback title stays.
 */
const MAX_SESSION_TITLE_LENGTH = 100;

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`;

/**
 * Generate a sentence-case session title from the session's first user
 * message. Returns null when no provider is configured, on any request
 * failure, or when the response cannot be sanitized into a plausible title.
 */
export async function generateSessionTitle(
  agent: Agent,
  description: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const trimmed = description.trim();
  if (trimmed.length === 0 || !agent.config.hasProvider) return null;
  const input =
    trimmed.length > MAX_TITLE_INPUT_LENGTH ? trimmed.slice(-MAX_TITLE_INPUT_LENGTH) : trimmed;
  try {
    const generateOptions: GenerateOptionsWithRequestLogFields = {
      signal,
      requestLogFields: { kind: 'title' },
    };
    const response = await agent.generate(
      agent.config.provider,
      SESSION_TITLE_PROMPT,
      [],
      [createUserMessage(input)],
      undefined,
      generateOptions,
    );
    if (response.usage !== null) {
      agent.usage.record(agent.config.provider.modelName, response.usage);
    }
    const text =
      typeof response.message.content === 'string'
        ? response.message.content
        : response.message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('');
    return sanitizeSessionTitle(text);
  } catch {
    return null;
  }
}

/**
 * Extract a usable title from the model's raw response: pull `title` out of
 * the first JSON object when present, otherwise treat the first line as plain
 * text. Returns null when nothing plausible remains.
 */
export function sanitizeSessionTitle(raw: string): string | null {
  let text = raw.trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      // The model attempted the JSON contract: accept its `title` field, or
      // reject the response outright — never promote contract-less JSON into
      // a title string.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('title' in parsed) ||
        typeof (parsed as { title: unknown }).title !== 'string'
      ) {
        return null;
      }
      text = (parsed as { title: string }).title;
    } catch {
      // Not JSON after all — fall through to plain-text handling.
    }
  }
  text = text
    .split('\n', 1)[0]!
    .trim()
    .replaceAll(/^["'`]+|["'`]+$/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (text.length === 0 || text.length > MAX_SESSION_TITLE_LENGTH) return null;
  return text;
}
