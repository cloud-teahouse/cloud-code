/**
 * `/import` — import local data from Claude Code, Codex, or Kimi Code.
 *
 * Architecture: Claude Code and Codex imports stay model-driven — the command
 * delegates to the existing `import-from-cc-codex` builtin skill, whose
 * conservative preview flow (instructions/skills/MCP, never overwrite, never
 * migrate credentials) is preserved unchanged. Kimi Code is our upstream and
 * shares our on-disk formats, so its import is deterministic instead:
 * scan → preview → confirm → apply, implemented in `utils/import/` and
 * covered by unit tests. Credentials are never copied unless the user
 * explicitly opts in after reviewing a risk warning.
 */

import { ImportSourceSelectorComponent, type ImportSourceChoice } from '../components/dialogs/import-source-selector';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { LLM_NOT_SET_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t, type MessageKey } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';
import {
  applyKimiImportPlan,
  buildKimiImportPlan,
  countPlannedImports,
  kimiSourceHomeExists,
  resolveKimiSourceHome,
  type BuiltKimiImportPlan,
} from '#/utils/import/kimi-import';
import { applyCredentialImport } from '#/utils/import/kimi-files';
import type {
  KimiImportApplyResult,
  KimiImportPlan,
  KimiImportSkipReason,
  KeyMergePlan,
} from '#/utils/import/types';

/** Skill handling the Claude Code / Codex model-driven import flow. */
export const IMPORT_FROM_CC_CODEX_SKILL_NAME = 'import-from-cc-codex';

function parseImportSourceArg(args: string): ImportSourceChoice | 'invalid' | undefined {
  const value = args.trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (value === 'claude' || value === 'claude-code' || value === 'cc') return 'claude';
  if (value === 'codex') return 'codex';
  if (value === 'kimi' || value === 'kimi-code' || value === 'kimicode') return 'kimi';
  return 'invalid';
}

export async function handleImportCommand(host: SlashCommandHost, args: string): Promise<void> {
  const source = parseImportSourceArg(args);
  if (source === 'invalid') {
    host.showError(t('commands.import.unknownSource', { source: args.trim() }));
    return;
  }
  if (source !== undefined) {
    await startImportForSource(host, source);
    return;
  }

  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ImportSourceSelectorComponent({
      onSelect: (choice) => {
        host.restoreEditor(editorSlotHandle);
        void startImportForSource(host, choice);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function startImportForSource(
  host: SlashCommandHost,
  source: ImportSourceChoice,
): Promise<void> {
  if (source === 'kimi') {
    await runKimiImport(host);
    return;
  }
  // Claude Code / Codex: delegate to the model-driven skill (needs a session
  // and a configured model, exactly like a direct skill invocation).
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
    return;
  }
  host.sendSkillActivation(session, IMPORT_FROM_CC_CODEX_SKILL_NAME, source);
}

// ---------------------------------------------------------------------------
// Kimi Code deterministic import
// ---------------------------------------------------------------------------

async function runKimiImport(host: SlashCommandHost): Promise<void> {
  const sourceHome = resolveKimiSourceHome();
  if (!(await kimiSourceHomeExists(sourceHome))) {
    host.showError(t('commands.import.kimi.sourceMissing', { path: sourceHome }));
    return;
  }

  let built: BuiltKimiImportPlan;
  try {
    built = await buildKimiImportPlan({ sourceHome });
  } catch (error) {
    host.showError(t('commands.import.kimi.scanFailed', { error: formatErrorMessage(error) }));
    return;
  }
  const { plan } = built;

  // The full plan lands in the transcript for reference; the confirm picker
  // carries the compact summary.
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    renderMode: 'plain',
    content: planDetailText(plan),
  });

  const total = countPlannedImports(plan);
  if (total === 0) {
    // Credentials-only is not "nothing": they exist but are excluded by
    // default, so say so explicitly and still offer the opt-in picker.
    const copyable = plan.credentials.filter((c) => c.skipReason === undefined).length;
    if (copyable > 0) {
      host.showNotice(t('commands.import.kimi.nothingButCredentials'));
      mountCredentialsPicker(host, plan);
      return;
    }
    host.showNotice(t('commands.import.kimi.nothingToImport'));
    return;
  }
  mountKimiConfirmPicker(host, built);
}

function mountKimiConfirmPicker(host: SlashCommandHost, built: BuiltKimiImportPlan): void {
  const { plan } = built;
  const renameableConflicts = plan.skills.filter(
    (s) => s.action === 'skip' && s.skipReason === 'conflict' && s.renameTargetPath !== undefined,
  ).length;

  const options: ChoiceOption[] = [
    {
      value: 'apply',
      label: t('selectors.import.confirm.apply.label'),
      description: t('selectors.import.confirm.apply.description'),
    },
  ];
  if (renameableConflicts > 0) {
    options.push({
      value: 'apply-rename',
      label: t('selectors.import.confirm.applyRename.label'),
      description: t('selectors.import.confirm.applyRename.description', {
        count: renameableConflicts,
      }),
    });
  }
  options.push({
    value: 'cancel',
    label: t('selectors.import.confirm.cancel.label'),
    description: t('selectors.import.confirm.cancel.description'),
  });

  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    host.showStatus(t('commands.import.kimi.cancelled'), 'textMuted');
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('selectors.import.confirm.title'),
      notice: [
        planSummaryText(plan),
        t('selectors.import.confirm.tomlNote'),
        t('selectors.import.confirm.snapshotNote'),
      ].join('\n'),
      noticeTone: plan.blockers.length > 0 ? 'warning' : 'success',
      options,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        if (value === 'cancel') {
          host.showStatus(t('commands.import.kimi.cancelled'), 'textMuted');
          return;
        }
        void executeKimiImport(host, built, value === 'apply-rename');
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function executeKimiImport(
  host: SlashCommandHost,
  built: BuiltKimiImportPlan,
  renameConflictingSkills: boolean,
): Promise<void> {
  const spinner = host.showProgressSpinner(t('commands.import.kimi.applying'));
  try {
    const result = await applyKimiImportPlan(built, {
      includeCredentials: false,
      renameConflictingSkills,
    });
    spinner.stop({ ok: result.errors.length === 0, label: t('commands.import.kimi.done.title') });
    reportApplyResult(host, result);
  } catch (error) {
    spinner.stop({ ok: false, label: t('commands.import.kimi.done.title') });
    host.showError(t('commands.import.kimi.applyFailed', { error: formatErrorMessage(error) }));
    return;
  }

  // Credentials are a separate, explicit opt-in with its own risk warning.
  const copyable = built.plan.credentials.filter((c) => c.skipReason === undefined).length;
  if (copyable > 0) {
    mountCredentialsPicker(host, built.plan);
  }
}

/** Category -> i18n key for the post-apply imported-count phrase. */
const CATEGORY_COUNT_KEYS: Readonly<Record<string, MessageKey>> = {
  config: 'commands.import.kimi.count.config',
  keybindings: 'commands.import.kimi.count.keybindings',
  mcp: 'commands.import.kimi.count.mcp',
  instructions: 'commands.import.kimi.count.instructions',
  skills: 'commands.import.kimi.count.skills',
  sessions: 'commands.import.kimi.count.sessions',
  inputHistory: 'commands.import.kimi.count.inputHistory',
  credentials: 'commands.import.kimi.count.credentials',
};

function reportApplyResult(host: SlashCommandHost, result: KimiImportApplyResult): void {
  const { imported, skipped, errors } = result;
  const notes = result.notes ?? [];
  const parts: string[] = [];
  for (const [category, count] of Object.entries(imported)) {
    const key = CATEGORY_COUNT_KEYS[category];
    if (key !== undefined && count > 0) parts.push(t(key, { count }));
  }
  const detailLines = [
    parts.length > 0
      ? parts.join(t('commands.import.kimi.countSeparator'))
      : t('commands.import.kimi.count.none'),
  ];
  // The skipped tally closes the loop with the preview: whatever was listed
  // as skipped/conflicted there stayed untouched here.
  const skippedTotal = Object.values(skipped ?? {}).reduce((n, c) => n + c, 0);
  if (skippedTotal > 0) {
    detailLines.push(t('commands.import.kimi.done.skippedSummary', { count: skippedTotal }));
  }
  for (const note of notes) {
    detailLines.push(
      t('commands.import.kimi.note.homedirNotRewritten', {
        sessionId: note.sessionId,
        count: note.unmatchedHomedirs,
      }),
    );
  }
  detailLines.push(t('commands.import.kimi.done.reloadHint'));
  if (errors.length > 0) {
    host.showError(
      t('commands.import.kimi.errors', { count: errors.length }) + `\n${errors.join('\n')}`,
    );
  }
  host.showNotice(t('commands.import.kimi.done.title'), detailLines.join('\n'));
}

function mountCredentialsPicker(host: SlashCommandHost, plan: KimiImportPlan): void {
  const options: ChoiceOption[] = [
    {
      value: 'no',
      label: t('selectors.import.credentials.no.label'),
      description: t('selectors.import.credentials.no.description'),
    },
    {
      value: 'yes',
      label: t('selectors.import.credentials.yes.label'),
      description: t('selectors.import.credentials.yes.description'),
      tone: 'danger',
    },
  ];
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    host.showStatus(t('selectors.import.credentials.skipped'), 'textMuted');
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('selectors.import.credentials.title'),
      notice: t('selectors.import.credentials.notice'),
      noticeTone: 'warning',
      options,
      currentValue: 'no',
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        if (value !== 'yes') {
          host.showStatus(t('selectors.import.credentials.skipped'), 'textMuted');
          return;
        }
        void executeCredentialImport(host, plan);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function executeCredentialImport(host: SlashCommandHost, plan: KimiImportPlan): Promise<void> {
  const { imported, errors } = await applyCredentialImport(plan.credentials);
  if (errors.length > 0) {
    host.showError(
      t('commands.import.kimi.errors', { count: errors.length }) + `\n${errors.join('\n')}`,
    );
  }
  host.showNotice(
    imported > 0
      ? t('selectors.import.credentials.done', { count: imported })
      : t('selectors.import.credentials.none'),
  );
}

// ---------------------------------------------------------------------------
// Preview text builders
// ---------------------------------------------------------------------------

const SKIP_REASON_KEYS: Readonly<Record<KimiImportSkipReason, MessageKey>> = {
  conflict: 'commands.import.reason.conflict',
  duplicate: 'commands.import.reason.duplicate',
  incompatible: 'commands.import.reason.incompatible',
  invalid: 'commands.import.reason.invalid',
  empty: 'commands.import.reason.empty',
};

function reasonText(reason: KimiImportSkipReason | undefined, detail: string | undefined): string {
  if (reason === undefined) return '';
  const base = t(SKIP_REASON_KEYS[reason]);
  return detail !== undefined ? `${base}: ${detail}` : base;
}

type KeyMergeCategory = 'config' | 'keybindings' | 'mcp';

const KEY_MERGE_SUMMARY_KEYS: Readonly<Record<KeyMergeCategory, { ok: MessageKey; blocked: MessageKey }>> = {
  config: { ok: 'commands.import.summary.config', blocked: 'commands.import.summary.configBlocked' },
  keybindings: {
    ok: 'commands.import.summary.keybindings',
    blocked: 'commands.import.summary.keybindingsBlocked',
  },
  mcp: { ok: 'commands.import.summary.mcp', blocked: 'commands.import.summary.mcpBlocked' },
};

const KEY_MERGE_DETAIL_TITLE_KEYS: Readonly<Record<KeyMergeCategory, MessageKey>> = {
  config: 'commands.import.detail.config',
  keybindings: 'commands.import.detail.keybindings',
  mcp: 'commands.import.detail.mcp',
};

function keyMergeSummaryLine(category: KeyMergeCategory, merge: KeyMergePlan | undefined): string | undefined {
  if (merge === undefined) return undefined;
  const keys = KEY_MERGE_SUMMARY_KEYS[category];
  if (merge.targetError !== undefined || merge.sourceError !== undefined) {
    return t(keys.blocked, { path: merge.targetPath });
  }
  return t(keys.ok, { imported: merge.importedKeys.length, kept: merge.keptKeys.length });
}

function planSummaryText(plan: KimiImportPlan): string {
  const lines: string[] = [];
  for (const category of ['config', 'keybindings', 'mcp'] as const) {
    const line = keyMergeSummaryLine(category, plan[category]);
    if (line !== undefined) lines.push(line);
  }

  if (plan.agentsMd !== undefined) {
    lines.push(
      plan.agentsMd.action === 'import'
        ? t('commands.import.summary.instructions')
        : t('commands.import.summary.instructionsSkip', {
            reason: reasonText(plan.agentsMd.skipReason, undefined),
          }),
    );
  }

  const skillsImported = plan.skills.filter((s) => s.action === 'import').length;
  if (plan.skills.length > 0) {
    lines.push(
      t('commands.import.summary.skills', {
        imported: skillsImported,
        skipped: plan.skills.length - skillsImported,
      }),
    );
  }

  const sessionsImported = plan.sessions.filter((s) => s.action === 'import').length;
  if (plan.sessions.length > 0) {
    lines.push(
      t('commands.import.summary.sessions', {
        imported: sessionsImported,
        skipped: plan.sessions.length - sessionsImported,
      }),
    );
  }

  const historyEntries = plan.inputHistory.reduce(
    (n, h) => n + (h.action === 'import' ? h.entriesToAppend.length : 0),
    0,
  );
  const historyFiles = plan.inputHistory.filter((h) => h.action === 'import').length;
  if (historyEntries > 0) {
    lines.push(t('commands.import.summary.history', { imported: historyEntries, files: historyFiles }));
  }

  const credentialsAvailable = plan.credentials.filter((c) => c.skipReason === undefined).length;
  if (credentialsAvailable > 0) {
    lines.push(t('commands.import.summary.credentials', { count: credentialsAvailable }));
  }

  for (const blocker of plan.blockers) {
    lines.push(t('commands.import.summary.blocker', { blocker }));
  }
  return lines.join('\n');
}

function keyMergeDetailLines(category: KeyMergeCategory, merge: KeyMergePlan | undefined): string[] {
  if (merge === undefined) return [];
  const lines = [t(KEY_MERGE_DETAIL_TITLE_KEYS[category], { path: merge.targetPath })];
  if (merge.sourceError !== undefined) {
    lines.push(`  ! ${t('commands.import.reason.invalid')}: ${merge.sourceError}`);
  } else if (merge.targetError !== undefined) {
    lines.push(`  ! ${t('commands.import.reason.invalid')}: ${merge.targetError}`);
  } else {
    for (const key of merge.importedKeys) lines.push(`  + ${key}`);
    for (const key of merge.keptKeys) {
      lines.push(`  = ${key} (${t('commands.import.reason.conflict')})`);
    }
  }
  return lines;
}

function planDetailText(plan: KimiImportPlan): string {
  const lines: string[] = [
    t('commands.import.detail.title'),
    t('commands.import.detail.source', { path: plan.sourceHome }),
    t('commands.import.detail.target', { path: plan.targetHome }),
    '',
  ];

  for (const category of ['config', 'keybindings', 'mcp'] as const) {
    const section = keyMergeDetailLines(category, plan[category]);
    if (section.length > 0) lines.push(...section, '');
  }

  if (plan.agentsMd !== undefined) {
    lines.push(t('commands.import.detail.instructions', { path: plan.agentsMd.targetPath }));
    lines.push(
      plan.agentsMd.action === 'import'
        ? `  + ${plan.agentsMd.sourcePath}`
        : `  - ${plan.agentsMd.sourcePath} (${reasonText(plan.agentsMd.skipReason, undefined)})`,
    );
    lines.push('');
  }

  if (plan.skills.length > 0) {
    lines.push(t('commands.import.detail.skills'));
    for (const skill of plan.skills) {
      if (skill.action === 'import') {
        lines.push(`  + ${skill.name}`);
      } else {
        const rename =
          skill.renameName !== undefined
            ? ` → ${t('commands.import.detail.renameHint', { name: skill.renameName })}`
            : '';
        lines.push(
          `  - ${skill.name} (${reasonText(skill.skipReason, skill.detail)})${rename}`,
        );
      }
    }
    lines.push('');
  }

  if (plan.sessions.length > 0) {
    lines.push(t('commands.import.detail.sessions'));
    for (const session of plan.sessions) {
      if (session.action === 'import') {
        lines.push(`  + ${session.title} (${session.sessionId}, ${session.workDir})`);
      } else {
        lines.push(
          `  - ${session.title} (${session.sessionId}) — ${reasonText(session.skipReason, session.detail)}`,
        );
      }
    }
    lines.push('');
  }

  if (plan.inputHistory.length > 0) {
    lines.push(t('commands.import.detail.history'));
    for (const history of plan.inputHistory) {
      if (history.action === 'import') {
        lines.push(`  + ${history.sourcePath}: ${history.entriesToAppend.length}`);
      } else {
        lines.push(`  - ${history.sourcePath} (${reasonText(history.skipReason, undefined)})`);
      }
    }
    lines.push('');
  }

  if (plan.credentials.length > 0) {
    lines.push(t('commands.import.detail.credentials'));
    for (const credential of plan.credentials) {
      lines.push(
        credential.skipReason === undefined
          ? `  ? ${credential.fileName} (${t('commands.import.detail.credentialsOptIn')})`
          : `  - ${credential.fileName} (${reasonText(credential.skipReason, undefined)})`,
      );
    }
    lines.push('');
  }

  for (const blocker of plan.blockers) {
    lines.push(`! ${t('commands.import.summary.blocker', { blocker })}`);
  }
  return lines.join('\n').replaceAll(/\n{3,}/g, '\n\n').trimEnd();
}
