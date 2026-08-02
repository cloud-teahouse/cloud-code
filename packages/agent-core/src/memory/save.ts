import { dirname, isAbsolute, join, normalize } from 'pathe';

import type { Kaos } from '@cloud-code/kaos';

import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES, MEMORY_ENTRYPOINT_NAME } from './memory';
import type { MemoryDirs } from './paths';

export type MemoryScope = 'project' | 'user';

export interface SaveMemoryInput {
  readonly scope: MemoryScope;
  readonly path: string;
  readonly description: string;
  readonly content: string;
}

export type SaveMemoryOutcome =
  | { readonly ok: true; readonly memoryPath: string; readonly indexPath: string }
  | { readonly ok: false; readonly error: string };

export type MemoryPathCheck =
  | { readonly ok: true; readonly relPath: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a memory file path and normalize it to forward slashes for use as
 * the markdown link target in the index. The path must be relative, stay
 * inside the memory directory (no `..` escape, no absolute path, no NUL),
 * name a `.md` file, and not be the index itself — `MEMORY.md` is maintained
 * by the save path, never written directly.
 */
export function checkMemoryRelPath(path: string): MemoryPathCheck {
  const fail = (error: string): MemoryPathCheck => ({ ok: false, error });
  if (path.length === 0 || path.includes('\0')) {
    return fail('path must be non-empty and must not contain NUL bytes');
  }
  // Backslashes first so `..\..` cannot smuggle traversal past normalize.
  const slashed = path.replaceAll('\\', '/');
  if (isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//')) {
    return fail('path must be relative to the memory directory, not absolute');
  }
  const normalized = normalize(slashed);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return fail('path must stay inside the memory directory (no `..` segments)');
  }
  if (!normalized.toLowerCase().endsWith('.md')) {
    return fail('memory files must be markdown (`*.md`)');
  }
  const base = normalized.split('/').pop()!;
  if (base.toUpperCase() === MEMORY_ENTRYPOINT_NAME.toUpperCase()) {
    return fail(
      `${MEMORY_ENTRYPOINT_NAME} is the index and is updated automatically — save the memory to its own file instead`,
    );
  }
  return { ok: true, relPath: normalized };
}

/**
 * Write a memory file and point the directory's `MEMORY.md` index at it.
 * Everything that can fail validation is checked before the first write: the
 * path, the one-line description, non-empty content, and the index cap (an
 * update that would push `MEMORY.md` past 200 lines / 25 KB is rejected
 * whole — nothing is written — so the index can never grow past the budget
 * the injection side enforces). On success the memory file lands first and
 * the index second, so a crash mid-save leaves an orphaned topic file rather
 * than a dangling index link.
 */
export async function saveMemory(
  kaos: Kaos,
  dirs: MemoryDirs,
  input: SaveMemoryInput,
): Promise<SaveMemoryOutcome> {
  const fail = (error: string): SaveMemoryOutcome => ({ ok: false, error });

  const check = checkMemoryRelPath(input.path);
  if (!check.ok) return fail(check.error);

  const description = input.description.trim();
  if (description.length === 0) return fail('description must be non-empty');
  if (description.includes('\n')) return fail('description must be a single line');
  if (input.content.trim().length === 0) return fail('content must be non-empty');

  const dir = input.scope === 'project' ? dirs.project : dirs.user;
  const memoryPath = join(dir, check.relPath);
  const indexPath = join(dir, MEMORY_ENTRYPOINT_NAME);

  const existingIndex = (await readIfExists(kaos, indexPath)) ?? '';
  const entry = `- [${description}](${check.relPath})`;
  const updatedIndex = upsertIndexEntry(existingIndex, check.relPath, entry);

  const trimmed = updatedIndex.trim();
  const lines = trimmed.split('\n').length;
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (lines > MAX_ENTRYPOINT_LINES || bytes > MAX_ENTRYPOINT_BYTES) {
    return fail(
      `Updating ${MEMORY_ENTRYPOINT_NAME} would push it to ${String(lines)} lines / ${String(bytes)} bytes, ` +
        `past the ${String(MAX_ENTRYPOINT_LINES)}-line / ${String(MAX_ENTRYPOINT_BYTES)}-byte index budget. ` +
        'Consolidate existing entries or move detail into topic files, then retry.',
    );
  }

  try {
    await kaos.mkdir(dirname(memoryPath), { parents: true, existOk: true });
    await kaos.writeText(memoryPath, input.content);
    await kaos.writeText(indexPath, updatedIndex.endsWith('\n') ? updatedIndex : `${updatedIndex}\n`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return { ok: true, memoryPath, indexPath };
}

/**
 * Insert or refresh one index line. A line already linking the same file is
 * replaced in place (and duplicate links to it dropped), otherwise the entry
 * is appended after the last non-empty line. All other lines — headers,
 * comments, hand-written entries — are preserved verbatim.
 */
export function upsertIndexEntry(indexRaw: string, relPath: string, entry: string): string {
  const lines = indexRaw.split('\n');
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (indexLinkTarget(line) === relPath) {
      if (!replaced) {
        out.push(entry);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    let insertAt = out.length;
    while (insertAt > 0 && out[insertAt - 1]!.trim() === '') insertAt--;
    out.splice(insertAt, 0, entry);
  }
  return out.join('\n');
}

/** The link target of a `- [text](target)` index line, or undefined. */
function indexLinkTarget(line: string): string | undefined {
  const match = /^\s*-\s+\[[^\]]*\]\(([^)]+)\)/.exec(line);
  return match?.[1]?.trim();
}

async function readIfExists(kaos: Kaos, path: string): Promise<string | undefined> {
  try {
    return await kaos.readText(path, { errors: 'ignore' });
  } catch {
    return undefined;
  }
}
