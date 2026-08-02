/**
 * Orchestration for `/import` from Kimi Code: resolve the source home, build
 * a full import plan (pure scan, no writes), and apply an approved plan.
 *
 * Source home resolution mirrors upstream: `$KIMI_CODE_HOME` first, then
 * `~/.kimi-code`. The target home follows the app's own data-dir rule
 * (`$CLOUD_CODE_HOME` > `~/.cloud-code`).
 */

import { homedir } from 'node:os';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { stringify as stringifyToml } from 'smol-toml';

import { getDataDir } from '#/utils/paths';

import {
  buildKeyMergePlan,
  mergeConfigTomlData,
  mergeFlatRecordData,
  mergeMcpData,
} from './kimi-key-merge';
import {
  applyAgentsMdImport,
  applyCredentialImport,
  applyHistoryMerge,
  applySkillImport,
  buildAgentsMdPlan,
  buildCredentialPlan,
  buildHistoryMergePlan,
  buildSkillImportPlan,
} from './kimi-files';
import { applySessionImport, buildSessionImportPlan } from './kimi-sessions';
import type {
  KeyMergePlan,
  KimiImportApplyOptions,
  KimiImportApplyResult,
  KimiImportPlan,
} from './types';

export function resolveKimiSourceHome(): string {
  return process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export async function kimiSourceHomeExists(sourceHome: string): Promise<boolean> {
  return isDirectory(sourceHome);
}

/**
 * Prepared write payloads keyed by category. Kept out of the plan type so
 * the plan stays display-shaped; built together with the plan so apply
 * executes exactly what the preview showed.
 */
interface PreparedWrites {
  config?: { plan: KeyMergePlan; merged: Record<string, unknown> };
  keybindings?: { plan: KeyMergePlan; merged: Record<string, unknown> };
  mcp?: { plan: KeyMergePlan; merged: Record<string, unknown> };
}

export interface BuiltKimiImportPlan {
  readonly plan: KimiImportPlan;
  readonly prepared: PreparedWrites;
}

export async function buildKimiImportPlan(input?: {
  readonly sourceHome?: string;
  readonly targetHome?: string;
}): Promise<BuiltKimiImportPlan> {
  const sourceHome = input?.sourceHome ?? resolveKimiSourceHome();
  const targetHome = input?.targetHome ?? getDataDir();

  const [config, keybindings, mcp, agentsMd, skills, sessions, inputHistory, credentials] =
    await Promise.all([
      buildKeyMergePlan({
        sourcePath: join(sourceHome, 'config.toml'),
        targetPath: join(targetHome, 'config.toml'),
        format: 'toml',
        merge: mergeConfigTomlData,
      }),
      buildKeyMergePlan({
        sourcePath: join(sourceHome, 'keybindings.json'),
        targetPath: join(targetHome, 'keybindings.json'),
        format: 'json',
        merge: mergeFlatRecordData,
      }),
      buildKeyMergePlan({
        sourcePath: join(sourceHome, 'mcp.json'),
        targetPath: join(targetHome, 'mcp.json'),
        format: 'json',
        merge: mergeMcpData,
      }),
      buildAgentsMdPlan({ sourceHome, targetHome }),
      buildSkillImportPlan({ sourceHome, targetHome }),
      buildSessionImportPlan({ sourceHome, targetHome }),
      buildHistoryMergePlan({ sourceHome, targetHome }),
      buildCredentialPlan({ sourceHome, targetHome }),
    ]);

  const prepared: PreparedWrites = {
    ...(config !== undefined ? { config } : {}),
    ...(keybindings !== undefined ? { keybindings } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  };

  const blockers: string[] = [];
  for (const category of [config, keybindings, mcp]) {
    if (category?.plan.targetError !== undefined) {
      blockers.push(`${category.plan.targetPath}: ${category.plan.targetError}`);
    }
  }

  return {
    plan: {
      sourceHome,
      targetHome,
      ...(config !== undefined ? { config: config.plan } : {}),
      ...(keybindings !== undefined ? { keybindings: keybindings.plan } : {}),
      ...(mcp !== undefined ? { mcp: mcp.plan } : {}),
      ...(agentsMd !== undefined ? { agentsMd } : {}),
      skills,
      sessions,
      inputHistory,
      credentials,
      blockers,
    },
    prepared,
  };
}

function blocked(plan: KeyMergePlan | undefined): boolean {
  return plan?.targetError !== undefined || plan?.sourceError !== undefined;
}

async function writeKeyMerge(
  entry: { plan: KeyMergePlan; merged: Record<string, unknown> },
  format: 'toml' | 'json',
): Promise<number> {
  if (entry.plan.importedKeys.length === 0) return 0;
  await mkdir(dirname(entry.plan.targetPath), { recursive: true, mode: 0o700 });
  const content =
    format === 'toml'
      ? stringifyToml(entry.merged)
      : `${JSON.stringify(entry.merged, null, 2)}\n`;
  await writeFile(entry.plan.targetPath, content, { encoding: 'utf-8', mode: 0o600 });
  return entry.plan.importedKeys.length;
}

export async function applyKimiImportPlan(
  built: BuiltKimiImportPlan,
  options: KimiImportApplyOptions,
): Promise<KimiImportApplyResult> {
  const { plan, prepared } = built;
  const imported: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const errors: string[] = [];
  const bump = (bucket: Record<string, number>, key: string, n: number) => {
    bucket[key] = (bucket[key] ?? 0) + n;
  };

  // Structured config files (refused when the scan flagged either side bad).
  if (prepared.config !== undefined && !blocked(prepared.config.plan)) {
    try {
      bump(imported, 'config', await writeKeyMerge(prepared.config, 'toml'));
    } catch (error) {
      errors.push(`config.toml: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (prepared.keybindings !== undefined && !blocked(prepared.keybindings.plan)) {
    try {
      bump(imported, 'keybindings', await writeKeyMerge(prepared.keybindings, 'json'));
    } catch (error) {
      errors.push(`keybindings.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (prepared.mcp !== undefined && !blocked(prepared.mcp.plan)) {
    try {
      bump(imported, 'mcp', await writeKeyMerge(prepared.mcp, 'json'));
    } catch (error) {
      errors.push(`mcp.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (plan.agentsMd?.action === 'import') {
    try {
      await applyAgentsMdImport(plan.agentsMd);
      bump(imported, 'instructions', 1);
    } catch (error) {
      errors.push(`AGENTS.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const skills = await applySkillImport(plan.skills, options.renameConflictingSkills);
  bump(imported, 'skills', skills.imported);
  errors.push(...skills.errors);

  const sessions = await applySessionImport(plan.sessions, plan.targetHome);
  bump(imported, 'sessions', sessions.imported);
  errors.push(...sessions.errors);

  const history = await applyHistoryMerge(plan.inputHistory);
  bump(imported, 'inputHistory', history.imported);
  errors.push(...history.errors);

  if (options.includeCredentials) {
    const credentials = await applyCredentialImport(plan.credentials);
    bump(imported, 'credentials', credentials.imported);
    errors.push(...credentials.errors);
  }

  // Skipped tallies for the summary (what was planned but not applied).
  bump(
    skipped,
    'skills',
    plan.skills.filter((s) => s.action === 'skip').length -
      (options.renameConflictingSkills
        ? plan.skills.filter(
            (s) => s.skipReason === 'conflict' && s.renameTargetPath !== undefined,
          ).length
        : 0),
  );
  bump(skipped, 'sessions', plan.sessions.filter((s) => s.action === 'skip').length);
  bump(
    skipped,
    'inputHistory',
    plan.inputHistory.filter((h) => h.action === 'skip').length,
  );
  if (!options.includeCredentials) {
    bump(skipped, 'credentials', plan.credentials.length);
  }
  for (const [key, category] of [
    ['config', plan.config],
    ['keybindings', plan.keybindings],
    ['mcp', plan.mcp],
  ] as const) {
    if (category === undefined) continue;
    if (category.targetError !== undefined || category.sourceError !== undefined) {
      bump(skipped, key, 1);
    } else {
      bump(skipped, key, category.keptKeys.length);
    }
  }

  return { imported, skipped, errors, notes: sessions.notes };
}

/** Count of units the default apply (no credentials) would write. */
export function countPlannedImports(plan: KimiImportPlan): number {
  let total = 0;
  for (const category of [plan.config, plan.keybindings, plan.mcp]) {
    if (category !== undefined && category.targetError === undefined && category.sourceError === undefined) {
      total += category.importedKeys.length;
    }
  }
  if (plan.agentsMd?.action === 'import') total += 1;
  total += plan.skills.filter((s) => s.action === 'import').length;
  total += plan.sessions.filter((s) => s.action === 'import').length;
  total += plan.inputHistory.reduce((n, h) => n + (h.action === 'import' ? h.entriesToAppend.length : 0), 0);
  return total;
}
