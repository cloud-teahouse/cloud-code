/**
 * Wire-log lite reader: recover session-listing fields from an
 * agent wire log without parsing the whole file. Only the first and last
 * {@link WIRE_LITE_READ_BUF_SIZE} bytes are read, so the session picker stays
 * fast no matter how large the transcript grows.
 *
 * What each window is for (mirroring Claude's readLiteMetadata):
 * - head window: the FIRST real user prompt (the fallback title source).
 * - tail window: the LAST real user prompt, the newest `session.meta` record
 *   (title/lastPrompt re-appended by the Session layer — see
 *   `Session.reAppendSessionMetadata`), and the latest record timestamp.
 *
 * The reader is a pure fallback: when the session's `state.json` is present
 * and carries a field, `SessionStore` never consults the wire for it. Every
 * failure mode (missing file, unreadable file, corrupt lines, a trailing
 * crash-truncated line) degrades to an empty/partial summary — the lite
 * reader never throws.
 *
 * This module also owns the turn-record classification shared with the fork
 * truncation path (`session-store.ts`): which records count as user-visible
 * turn boundaries, and how their display text is derived.
 */

import { open } from 'node:fs/promises';

import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
} from '#/session/prompt-metadata';

import type { AgentRecord } from '../../agent/records';

/** Head/tail window size for lite reads (Claude's LITE_READ_BUF_SIZE). */
export const WIRE_LITE_READ_BUF_SIZE = 65_536;

export interface WireLiteSummary {
  /** First user-visible prompt, from the head window. */
  readonly firstPrompt?: string;
  /** Last user-visible prompt, from the tail window. */
  readonly lastPrompt?: string;
  /** Title from the newest `session.meta` record in the tail window. */
  readonly title?: string;
  /** `isCustomTitle` from the newest `session.meta` record in the tail. */
  readonly isCustomTitle?: boolean;
  /** Latest record `time` seen in the tail window (ms epoch). */
  readonly lastActiveAt?: number;
}

/**
 * Read the head and tail windows of an agent wire log and extract the
 * listing summary. Never throws — any IO/parse failure yields whatever was
 * recovered before it (usually an empty summary).
 */
export async function readWireLiteSummary(wirePath: string): Promise<WireLiteSummary> {
  let fh;
  try {
    fh = await open(wirePath, 'r');
  } catch {
    return {};
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return {};
    if (size <= 2 * WIRE_LITE_READ_BUF_SIZE) {
      // Small file: one read serves both windows.
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return scanLiteWindow(buf.toString('utf8'), { dropHeadRemainder: false });
    }
    const head = Buffer.alloc(WIRE_LITE_READ_BUF_SIZE);
    await fh.read(head, 0, WIRE_LITE_READ_BUF_SIZE, 0);
    const tail = Buffer.alloc(WIRE_LITE_READ_BUF_SIZE);
    await fh.read(tail, 0, WIRE_LITE_READ_BUF_SIZE, size - WIRE_LITE_READ_BUF_SIZE);

    const headSummary = scanLiteWindow(head.toString('utf8'), {
      dropHeadRemainder: false,
      dropTailRemainder: true,
      firstPromptOnly: true,
    });
    const tailSummary = scanLiteWindow(tail.toString('utf8'), {
      dropHeadRemainder: true,
    });
    return { ...tailSummary, firstPrompt: headSummary.firstPrompt };
  } catch {
    return {};
  } finally {
    await fh.close().catch(() => {});
  }
}

interface LiteScanOptions {
  /** Drop the first (partial) line — tail windows start mid-line. */
  readonly dropHeadRemainder?: boolean;
  /** Drop the last (partial) line — head windows end mid-line. */
  readonly dropTailRemainder?: boolean;
  /** Stop after the first prompt (head-window scans need nothing else). */
  readonly firstPromptOnly?: boolean;
}

function scanLiteWindow(text: string, options: LiteScanOptions): WireLiteSummary {
  let body = text;
  if (options.dropHeadRemainder === true) {
    const firstNewline = body.indexOf('\n');
    body = firstNewline === -1 ? '' : body.slice(firstNewline + 1);
  }
  const lines = body.split('\n');
  if (options.dropTailRemainder === true && lines.length > 0 && !body.endsWith('\n')) {
    lines.pop();
  }

  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let title: string | undefined;
  let isCustomTitle: boolean | undefined;
  let lastActiveAt: number | undefined;

  for (const line of lines) {
    const record = parseLiteLine(line);
    if (record === undefined) continue;
    const time = recordTime(record);
    if (time !== undefined) {
      lastActiveAt = lastActiveAt === undefined ? time : Math.max(lastActiveAt, time);
    }
    if (record.type === 'session.meta') {
      // Last write wins — the Session layer re-appends, so the newest
      // `session.meta` in the window is authoritative. Field-gated: a
      // sparse/foreign record must not blank values already recovered.
      if (record.title !== undefined || record.isCustomTitle !== undefined) {
        title = record.title;
        isCustomTitle = record.isCustomTitle;
      }
      // The re-appended lastPrompt is chronologically newer than the tail
      // window's prompt records.
      if (typeof record.lastPrompt === 'string') {
        lastPrompt = record.lastPrompt;
      }
      continue;
    }
    // Per-record degradation (the module header's promise): a well-formed
    // JSON line that is NOT a well-formed record (foreign wire, hand-edited
    // log, missing fields) must skip like a corrupt line — never throw the
    // whole window away.
    let promptText: string | undefined;
    try {
      promptText = promptTextFromRecord(record);
    } catch {
      continue;
    }
    if (promptText === undefined) continue;
    firstPrompt ??= promptText;
    lastPrompt = promptText;
    if (options.firstPromptOnly === true && firstPrompt !== undefined) break;
  }

  return { firstPrompt, lastPrompt, title, isCustomTitle, lastActiveAt };
}

function parseLiteLine(line: string): AgentRecord | undefined {
  const trimmed = line.length > 0 && line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as AgentRecord;
  } catch {
    // Corrupt line, or the crash-truncated final line of the file — the lite
    // reader skips it instead of failing the whole listing.
    return undefined;
  }
}

/** Display text for a user-visible prompt record, or undefined. */
function promptTextFromRecord(record: AgentRecord): string | undefined {
  if (record.type === 'turn.prompt' || record.type === 'turn.steer') {
    if (!isUserVisibleTurnInputRecord(record)) return undefined;
    return promptMetadataTextFromPayload({ input: record.input });
  }
  if (record.type === 'context.append_message') {
    if (!isUserVisibleTurnRecord(record)) return undefined;
    return promptMetadataFromTurnRecord(record);
  }
  return undefined;
}

export function recordTime(record: AgentRecord): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  if (
    record.type === 'metadata' &&
    typeof record.created_at === 'number' &&
    Number.isFinite(record.created_at)
  ) {
    return record.created_at;
  }
  return undefined;
}

/**
 * Whether a `context.append_message` record anchors a user-visible turn: a
 * typed prompt, a user-invoked skill/plugin slash command, or a `!` shell
 * command's input line. Shared with the fork truncation path.
 */
export function isUserVisibleTurnRecord(record: AgentRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const { message } = record;
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      return message.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'mailbox':
    case 'retry':
    case 'system_trigger':
      return false;
  }
}

/** Same classification for `turn.prompt` / `turn.steer` input records. */
export function isUserVisibleTurnInputRecord(record: AgentRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  switch (record.origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return record.origin.trigger === 'user-slash';
    case 'shell_command':
      return record.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'mailbox':
    case 'retry':
    case 'system_trigger':
      return false;
  }
}

/** Display text for a user-visible `context.append_message` turn record. */
export function promptMetadataFromTurnRecord(record: AgentRecord): string | undefined {
  if (record.type !== 'context.append_message' || record.message.role !== 'user') {
    return undefined;
  }
  const { message } = record;
  if (message.origin?.kind === 'skill_activation') {
    return promptMetadataTextFromSkill({
      name: message.origin.skillName,
      args: message.origin.skillArgs,
    });
  }
  if (message.origin?.kind === 'plugin_command') {
    return promptMetadataTextFromPluginCommand({
      pluginId: message.origin.pluginId,
      commandName: message.origin.commandName,
      args: message.origin.commandArgs,
    });
  }
  return promptMetadataTextFromPayload({ input: message.content });
}
