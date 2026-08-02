/**
 * File-level category importers for `/import` from Kimi Code:
 * AGENTS.md instructions, skills, input history, and (opt-in) credentials.
 * Config.toml / keybindings.json / mcp.json live in kimi-key-merge.ts,
 * sessions in kimi-sessions.ts.
 *
 * Everything here is conservative: no existing target file is ever
 * overwritten — conflicts are skipped (or, for skills, importable under a
 * precomputed `<name>-kimi` rename when the user asks for it).
 */

import { appendFile, chmod, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import type {
  AgentsMdImportPlan,
  CredentialImportItem,
  HistoryMergeItem,
  SkillImportItem,
} from './types';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md instructions
// ---------------------------------------------------------------------------

export const IMPORTED_FROM_KIMI_MARK = 'Imported from Kimi Code';

export function agentsMdBlockMarker(sourcePath: string): string {
  return `<!-- ${IMPORTED_FROM_KIMI_MARK}: ${sourcePath} -->`;
}

export async function buildAgentsMdPlan(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): Promise<AgentsMdImportPlan | undefined> {
  const sourcePath = join(input.sourceHome, 'AGENTS.md');
  const targetPath = join(input.targetHome, 'AGENTS.md');
  const source = await readTextIfExists(sourcePath);
  if (source === undefined) return undefined;
  if (source.trim().length === 0) {
    return { sourcePath, targetPath, action: 'skip', skipReason: 'empty' };
  }
  const target = await readTextIfExists(targetPath);
  if (target !== undefined && target.includes(agentsMdBlockMarker(sourcePath))) {
    return { sourcePath, targetPath, action: 'skip', skipReason: 'duplicate' };
  }
  return { sourcePath, targetPath, action: 'import' };
}

export async function applyAgentsMdImport(plan: AgentsMdImportPlan): Promise<void> {
  const source = await readFile(plan.sourcePath, 'utf-8');
  const existing = await readTextIfExists(plan.targetPath);
  const marker = agentsMdBlockMarker(plan.sourcePath);
  const block = `${marker}\n\n${source.trim()}\n\n<!-- End ${IMPORTED_FROM_KIMI_MARK}: ${plan.sourcePath} -->\n`;
  const content = existing === undefined || existing.length === 0
    ? `${block}`
    : `${existing.replace(/\s*$/, '\n\n')}${block}`;
  await mkdir(dirname(plan.targetPath), { recursive: true, mode: 0o700 });
  await writeFile(plan.targetPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const IGNORED_SKILL_ENTRIES = new Set(['node_modules']);

/** Minimal frontmatter check: directory skills need name + description. */
function bundleFrontmatterError(skillMd: string): string | undefined {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return 'SKILL.md has no frontmatter';
  const frontmatter = match[1] ?? '';
  if (!/^name:\s*\S+/m.test(frontmatter)) return 'SKILL.md frontmatter lacks a name';
  if (!/^description:\s*\S+/m.test(frontmatter)) return 'SKILL.md frontmatter lacks a description';
  return undefined;
}

async function firstFreeRename(skillsDir: string, name: string): Promise<string | undefined> {
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? `${name}-kimi` : `${name}-kimi-${i + 1}`;
    if (!(await pathExists(join(skillsDir, candidate)))) return candidate;
  }
  return undefined;
}

export async function buildSkillImportPlan(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): Promise<SkillImportItem[]> {
  const items: SkillImportItem[] = [];
  const sourceSkillsDir = join(input.sourceHome, 'skills');
  const targetSkillsDir = join(input.targetHome, 'skills');
  let entries;
  try {
    entries = await readdir(sourceSkillsDir, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_SKILL_ENTRIES.has(entry.name)) continue;
    const sourcePath = join(sourceSkillsDir, entry.name);

    let name: string;
    let kind: SkillImportItem['kind'];
    if (entry.isDirectory()) {
      name = entry.name;
      kind = 'bundle';
      const skillMd = await readTextIfExists(join(sourcePath, 'SKILL.md'));
      if (skillMd === undefined) continue; // Not a skill bundle; ignore silently.
      const frontmatterError = bundleFrontmatterError(skillMd);
      if (frontmatterError !== undefined) {
        items.push({
          name,
          sourcePath,
          targetPath: join(targetSkillsDir, name),
          kind,
          action: 'skip',
          skipReason: 'invalid',
          detail: frontmatterError,
        });
        continue;
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      name = entry.name;
      kind = 'flat';
    } else {
      continue;
    }

    const targetPath = join(targetSkillsDir, name);
    if (await pathExists(targetPath)) {
      const renameName = await firstFreeRename(targetSkillsDir, name);
      items.push({
        name,
        sourcePath,
        targetPath,
        kind,
        action: 'skip',
        skipReason: 'conflict',
        detail: 'a skill with this name already exists',
        renameName,
        renameTargetPath: renameName === undefined ? undefined : join(targetSkillsDir, renameName),
      });
      continue;
    }
    items.push({ name, sourcePath, targetPath, kind, action: 'import' });
  }
  return items.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function applySkillImport(
  items: readonly SkillImportItem[],
  renameConflictingSkills: boolean,
): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  for (const item of items) {
    const targetPath =
      item.action === 'import'
        ? item.targetPath
        : renameConflictingSkills && item.skipReason === 'conflict'
          ? item.renameTargetPath
          : undefined;
    if (targetPath === undefined) continue;
    try {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(item.sourcePath, targetPath, {
        recursive: item.kind === 'bundle',
        force: false,
        errorOnExist: true,
      });
      imported++;
    } catch (error) {
      errors.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, errors };
}

// ---------------------------------------------------------------------------
// Input history
// ---------------------------------------------------------------------------

/** Parse a user-history JSONL file into raw contents, tolerating bad rows. */
async function readHistoryContents(path: string): Promise<string[]> {
  const raw = await readTextIfExists(path);
  if (raw === undefined) return [];
  const contents: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { content?: unknown };
      if (typeof parsed.content === 'string' && parsed.content.length > 0) {
        contents.push(parsed.content);
      }
    } catch {
      // JSONL is append-only user data; tolerate bad rows.
    }
  }
  return contents;
}

export async function buildHistoryMergePlan(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): Promise<HistoryMergeItem[]> {
  const items: HistoryMergeItem[] = [];
  const sourceDir = join(input.sourceHome, 'user-history');
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(input.targetHome, 'user-history', entry.name);
    const [sourceContents, targetContents] = await Promise.all([
      readHistoryContents(sourcePath),
      readHistoryContents(targetPath),
    ]);
    if (sourceContents.length === 0) continue;
    const seen = new Set(targetContents);
    const entriesToAppend: string[] = [];
    for (const content of sourceContents) {
      if (seen.has(content)) continue;
      seen.add(content);
      entriesToAppend.push(content);
    }
    if (entriesToAppend.length === 0) {
      items.push({
        sourcePath,
        targetPath,
        entriesToAppend,
        action: 'skip',
        skipReason: 'duplicate',
      });
      continue;
    }
    items.push({ sourcePath, targetPath, entriesToAppend, action: 'import' });
  }
  return items.toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

export async function applyHistoryMerge(
  items: readonly HistoryMergeItem[],
): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  for (const item of items) {
    if (item.action !== 'import') continue;
    try {
      await mkdir(dirname(item.targetPath), { recursive: true, mode: 0o700 });
      const lines = item.entriesToAppend.map((content) => `${JSON.stringify({ content })}\n`);
      await appendFile(item.targetPath, lines.join(''), 'utf-8');
      imported += item.entriesToAppend.length;
    } catch (error) {
      errors.push(
        `${item.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, errors };
}

// ---------------------------------------------------------------------------
// Credentials (opt-in only)
// ---------------------------------------------------------------------------

/**
 * Managed-platform OAuth credential files under `credentials/`. Only the
 * kimi-code family is offered: the main token file plus env-scoped variants.
 * Other products' credentials (e.g. chatgpt-codex.json) belong to their own
 * import source and are never touched here.
 */
const CREDENTIAL_FILE_PATTERN = /^kimi-code(-env-[0-9a-f]+)?\.json$/;

export async function buildCredentialPlan(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): Promise<CredentialImportItem[]> {
  const items: CredentialImportItem[] = [];
  let entries;
  try {
    entries = await readdir(join(input.sourceHome, 'credentials'), { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !CREDENTIAL_FILE_PATTERN.test(entry.name)) continue;
    const targetPath = join(input.targetHome, 'credentials', entry.name);
    items.push({
      fileName: entry.name,
      sourcePath: join(input.sourceHome, 'credentials', entry.name),
      targetPath,
      skipReason: (await pathExists(targetPath)) ? 'conflict' : undefined,
    });
  }
  return items.toSorted((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function applyCredentialImport(
  items: readonly CredentialImportItem[],
): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  for (const item of items) {
    if (item.skipReason !== undefined) continue;
    try {
      await mkdir(dirname(item.targetPath), { recursive: true, mode: 0o700 });
      await cp(item.sourcePath, item.targetPath, { force: false, errorOnExist: true });
      // Token files must stay private regardless of source permissions.
      await chmod(item.targetPath, 0o600);
      imported++;
    } catch (error) {
      errors.push(
        `${item.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, errors };
}
