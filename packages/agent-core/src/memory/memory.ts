import { join } from 'pathe';

import type { Kaos } from '@cloud-code/kaos';

import { resolveMemoryDirs } from './paths';

export const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
// ~125 chars/line at 200 lines. The byte cap catches long-line indexes that
// slip past the line cap.
export const MAX_ENTRYPOINT_BYTES = 25_000;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export interface EntrypointTruncation {
  readonly content: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
}

/**
 * Cap `MEMORY.md` content at the line AND byte budgets (Claude Code's
 * `truncateEntrypointContent`): line-truncate first (natural boundary), then
 * byte-truncate at the last newline before the cap so no line is cut mid-way,
 * and append a warning naming which cap fired. Counts are true UTF-8 bytes —
 * the budget exists to bound injected tokens, and char counting would
 * undercount CJK text threefold.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim();
  const lines = trimmed.split('\n');
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(trimmed, 'utf8');
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  // Check the original byte count — long lines are the failure mode the byte
  // cap targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n') : trimmed;
  if (Buffer.byteLength(truncated, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    truncated = cutAtLastNewlineWithinBytes(truncated, MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${String(byteCount)} bytes (limit: ${String(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${String(lineCount)} lines (limit: ${String(MAX_ENTRYPOINT_LINES)})`
        : `${String(lineCount)} lines and ${String(byteCount)} bytes`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/**
 * Cut at the last newline whose prefix fits the byte budget; when no newline
 * fits (a single line longer than the budget), cut at the budget itself
 * without splitting a multi-byte character.
 */
function cutAtLastNewlineWithinBytes(text: string, maxBytes: number): string {
  let from = 0;
  let cut = -1;
  while (true) {
    const newline = text.indexOf('\n', from);
    if (newline === -1) break;
    if (Buffer.byteLength(text.slice(0, newline), 'utf8') > maxBytes) break;
    cut = newline;
    from = newline + 1;
  }
  if (cut > 0) return text.slice(0, cut);

  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Render both memory scopes' `MEMORY.md` indexes for the system prompt,
 * project first. Returns undefined when neither memory dir exists — a fresh
 * machine must produce zero prompt delta. An existing dir with a missing or
 * empty index still renders (with an empty marker): creating the dir is the
 * opt-in signal, matching how the save path teaches the model to check back.
 *
 * The output is a pure function of file contents — no timestamps, fixed scope
 * order — so an unchanged memory set renders byte-identical and the
 * `memory` prompt section's hash does not churn across refreshes.
 */
export async function loadMemoryForPrompt(
  kaos: Kaos,
  brandHome?: string,
): Promise<string | undefined> {
  const dirs = await resolveMemoryDirs(kaos, brandHome);
  const scopes = [
    { label: 'Project memory', dir: dirs.project },
    { label: 'User memory', dir: dirs.user },
  ];

  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = kaos.normpath(scope.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await isDirectory(kaos, scope.dir))) continue;
    const entrypoint = join(scope.dir, MEMORY_ENTRYPOINT_NAME);
    const raw = await readIfFile(kaos, entrypoint);
    const body =
      raw === undefined || raw.trim().length === 0
        ? '(empty — memories saved with the SaveMemory tool are indexed here)'
        : truncateEntrypointContent(raw).content;
    blocks.push(`## ${scope.label} — \`${entrypoint}\`\n\n${body}`);
  }

  return blocks.length === 0 ? undefined : blocks.join('\n\n');
}

async function isDirectory(kaos: Kaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.stat(path);
    return (stat.stMode & S_IFMT) === S_IFDIR;
  } catch {
    return false;
  }
}

async function readIfFile(kaos: Kaos, path: string): Promise<string | undefined> {
  try {
    const stat = await kaos.stat(path);
    if ((stat.stMode & S_IFMT) !== S_IFREG) return undefined;
    return await kaos.readText(path, { errors: 'ignore' });
  } catch {
    return undefined;
  }
}
