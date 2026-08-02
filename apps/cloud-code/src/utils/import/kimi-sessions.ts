/**
 * Session import for `/import` from Kimi Code.
 *
 * Layout (identical on both sides): `<home>/sessions/<bucket>/<sessionId>/`
 * holding `state.json` (SessionMeta) and `agents/<agentId>/wire.jsonl`, plus a
 * global append-only `<home>/session_index.jsonl`. The wire format is shared
 * with upstream 0.29.1 (protocol '1.4'); see wire-compat.ts.
 *
 * Import copies the whole session tree (excluding session logs), rewrites the
 * absolute `agents.*.homedir` paths inside `state.json` to the new location,
 * and appends an index entry. Duplicate session ids are skipped; sessions
 * whose wire files fail the compatibility check are skipped and reported.
 */

import { appendFile, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import type { SessionImportItem } from './types';
import { checkWireCompatibility } from './wire-compat';
import { encodeWorkDirKey, isSafeSessionId, normalizeWorkDir } from './workdir-key';

interface SourceIndexEntry {
  readonly sessionId: string;
  readonly workDir?: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Read the source session index as a sessionId -> workDir fallback map. */
async function readSourceIndex(sourceHome: string): Promise<Map<string, SourceIndexEntry>> {
  const map = new Map<string, SourceIndexEntry>();
  let raw: string;
  try {
    raw = await readFile(join(sourceHome, 'session_index.jsonl'), 'utf-8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        sessionId?: unknown;
        workDir?: unknown;
        deleted?: unknown;
      };
      if (typeof parsed.sessionId !== 'string') continue;
      if (parsed.deleted === true) {
        map.delete(parsed.sessionId);
        continue;
      }
      map.set(parsed.sessionId, {
        sessionId: parsed.sessionId,
        workDir: typeof parsed.workDir === 'string' ? parsed.workDir : undefined,
      });
    } catch {
      // Append-only user data: tolerate bad rows.
    }
  }
  return map;
}

/** Collect session ids the target already holds (on-disk dirs + index). */
async function readTargetSessionIds(targetHome: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const sessionsRoot = join(targetHome, 'sessions');
  try {
    for (const bucket of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      for (const entry of await readdir(join(sessionsRoot, bucket.name), { withFileTypes: true })) {
        if (entry.isDirectory()) ids.add(entry.name);
      }
    }
  } catch {
    // No sessions yet.
  }
  try {
    const raw = await readFile(join(targetHome, 'session_index.jsonl'), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          sessionId?: unknown;
          sessionDir?: unknown;
          deleted?: unknown;
        };
        if (typeof parsed.sessionId !== 'string') continue;
        if (parsed.deleted === true) {
          ids.delete(parsed.sessionId);
          continue;
        }
        // An index line without its session directory is an orphan (the dir
        // was deleted or moved out of band): it must not read as a duplicate,
        // or the session can never be re-imported.
        const sessionDir = typeof parsed.sessionDir === 'string' ? parsed.sessionDir : undefined;
        if (sessionDir !== undefined && !(await isDirectory(sessionDir))) continue;
        ids.add(parsed.sessionId);
      } catch {
        // Tolerate bad rows.
      }
    }
  } catch {
    // No index yet.
  }
  return ids;
}

interface StateJsonShape {
  title?: unknown;
  lastPrompt?: unknown;
  workDir?: unknown;
  custom?: unknown;
  agents?: unknown;
}

async function readStateJson(sessionDir: string): Promise<StateJsonShape | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as StateJsonShape) : undefined;
  } catch {
    return undefined;
  }
}

function workDirFromState(state: StateJsonShape): string | undefined {
  if (typeof state.workDir === 'string' && state.workDir.length > 0) return state.workDir;
  const custom = state.custom;
  if (typeof custom === 'object' && custom !== null) {
    const cwd = (custom as Record<string, unknown>)['cwd'];
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  }
  return undefined;
}

function titleFromState(state: StateJsonShape, fallback: string): string {
  if (typeof state.title === 'string' && state.title.length > 0) return state.title;
  if (typeof state.lastPrompt === 'string' && state.lastPrompt.length > 0) {
    return state.lastPrompt.length > 60 ? `${state.lastPrompt.slice(0, 60)}…` : state.lastPrompt;
  }
  return fallback;
}

/** Validate every wire.jsonl in the session tree (main + subagents). */
async function checkSessionWires(sessionDir: string): Promise<
  { ok: true } | { ok: false; reason: 'incompatible' | 'invalid'; detail: string }
> {
  const agentsDir = join(sessionDir, 'agents');
  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'invalid', detail: 'missing agents directory' };
  }
  const wires = agentEntries.filter((e) => e.isDirectory());
  if (!wires.some((e) => e.name === 'main')) {
    return { ok: false, reason: 'invalid', detail: 'missing main agent' };
  }
  for (const agentEntry of wires) {
    const wirePath = join(agentsDir, agentEntry.name, 'wire.jsonl');
    let raw: string;
    try {
      raw = await readFile(wirePath, 'utf-8');
    } catch {
      return { ok: false, reason: 'invalid', detail: `missing wire.jsonl for agent ${agentEntry.name}` };
    }
    const verdict = checkWireCompatibility(raw);
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, detail: `agent ${agentEntry.name}: ${verdict.detail}` };
    }
  }
  return { ok: true };
}

/**
 * Scan `<sourceHome>/sessions` and build one plan item per session found.
 * Never reads or writes the target beyond existence checks.
 */
export async function buildSessionImportPlan(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): Promise<SessionImportItem[]> {
  const items: SessionImportItem[] = [];
  const sessionsRoot = join(input.sourceHome, 'sessions');
  if (!(await isDirectory(sessionsRoot))) return items;

  const [sourceIndex, targetIds] = await Promise.all([
    readSourceIndex(input.sourceHome),
    readTargetSessionIds(input.targetHome),
  ]);

  let buckets;
  try {
    buckets = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = join(sessionsRoot, bucket.name);
    let sessionEntries;
    try {
      sessionEntries = await readdir(bucketDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionEntries) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
      const sessionId = entry.name;
      const sourceDir = join(bucketDir, sessionId);
      const base = { sessionId, sourceDir };

      if (targetIds.has(sessionId)) {
        items.push({
          ...base,
          title: sessionId,
          workDir: '',
          targetDir: '',
          action: 'skip',
          skipReason: 'duplicate',
          detail: 'a session with this id already exists',
        });
        continue;
      }

      const state = await readStateJson(sourceDir);
      if (state === undefined) {
        items.push({
          ...base,
          title: sessionId,
          workDir: '',
          targetDir: '',
          action: 'skip',
          skipReason: 'invalid',
          detail: 'state.json missing or unparseable',
        });
        continue;
      }

      const rawWorkDir = workDirFromState(state) ?? sourceIndex.get(sessionId)?.workDir;
      let workDir: string | undefined;
      if (rawWorkDir !== undefined) {
        try {
          workDir = normalizeWorkDir(rawWorkDir);
        } catch {
          workDir = undefined;
        }
      }
      if (workDir === undefined) {
        items.push({
          ...base,
          title: titleFromState(state, sessionId),
          workDir: '',
          targetDir: '',
          action: 'skip',
          skipReason: 'invalid',
          detail: 'no workDir recorded',
        });
        continue;
      }

      const wires = await checkSessionWires(sourceDir);
      if (!wires.ok) {
        items.push({
          ...base,
          title: titleFromState(state, sessionId),
          workDir,
          targetDir: '',
          action: 'skip',
          skipReason: wires.reason,
          detail: wires.detail,
        });
        continue;
      }

      items.push({
        ...base,
        title: titleFromState(state, sessionId),
        workDir,
        targetDir: join(input.targetHome, 'sessions', encodeWorkDirKey(workDir), sessionId),
        action: 'import',
      });
    }
  }

  return items.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Directory names inside a session tree that are noise, not context. */
const COPY_EXCLUDED_NAMES = new Set(['logs']);

/**
 * Execute the session part of an approved plan. Returns per-session errors;
 * sessions that fail mid-copy are reported and left for manual cleanup rather
 * than indexed. `notes` flag sessions whose state.json homedir values did not
 * point inside the source session dir and were therefore left as-is (the
 * session was likely moved before, or its paths were recorded differently) —
 * replaying such a session may reference paths under the old home.
 */
export async function applySessionImport(
  items: readonly SessionImportItem[],
  targetHome: string,
): Promise<{ imported: number; errors: string[]; notes: SessionImportNote[] }> {
  const todo = items.filter((item) => item.action === 'import');
  const errors: string[] = [];
  const notes: SessionImportNote[] = [];
  let imported = 0;

  for (const item of todo) {
    try {
      await mkdir(dirname(item.targetDir), { recursive: true, mode: 0o700 });
      await cp(item.sourceDir, item.targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (source) => !COPY_EXCLUDED_NAMES.has(basename(source)),
      });
      const unmatched = await rewriteAgentHomedirs(item.sourceDir, item.targetDir);
      if (unmatched > 0) {
        notes.push({ sessionId: item.sessionId, unmatchedHomedirs: unmatched });
      }
      await mkdir(targetHome, { recursive: true, mode: 0o700 });
      await appendFile(
        join(targetHome, 'session_index.jsonl'),
        `${JSON.stringify({ sessionId: item.sessionId, sessionDir: item.targetDir, workDir: item.workDir })}\n`,
        'utf-8',
      );
      imported++;
    } catch (error) {
      errors.push(
        `${item.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, errors, notes };
}

export interface SessionImportNote {
  readonly sessionId: string;
  /** state.json agents.*.homedir values that did not start with the source dir. */
  readonly unmatchedHomedirs: number;
}

/** Rewrite absolute agents.*.homedir paths in the copied state.json. */
async function rewriteAgentHomedirs(sourceDir: string, targetDir: string): Promise<number> {
  const statePath = join(targetDir, 'state.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return 0; // state.json was required at scan time; leave a partial copy unindexed via error upstream.
  }
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const agents = (parsed as { agents?: unknown }).agents;
  if (typeof agents !== 'object' || agents === null) return 0;
  let unmatched = 0;
  for (const meta of Object.values(agents)) {
    if (typeof meta !== 'object' || meta === null) continue;
    const homedir = (meta as { homedir?: unknown }).homedir;
    if (typeof homedir !== 'string') continue;
    if (homedir.startsWith(`${sourceDir}/`)) {
      (meta as { homedir?: unknown }).homedir = `${targetDir}${homedir.slice(sourceDir.length)}`;
    } else {
      unmatched++;
    }
  }
  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return unmatched;
}
