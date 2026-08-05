import {
  effectiveModelAlias,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type CloudCodeConfig,
  type ExperimentalFeatureState,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type ThinkingEffort,
} from '@cloud-code/sdk';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { FullscreenSelectorComponent } from '../components/dialogs/fullscreen-selector';
import { LanguageSelectorComponent } from '../components/dialogs/language-selector';
import {
  modelDisplayName,
  segmentsFor,
  type ModelSelection,
} from '../components/dialogs/model-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { DEFAULT_TUI_CONFIG, saveTuiConfig, type TuiConfig } from '../config';
import type { EditorSlotHandle } from '../editor-slot';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import {
  isLocalePreference,
  resolveDescription,
  t,
  type LocalePreference,
  type MessageKey,
} from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import {
  isCustomModel,
  resolveModelFallback,
  revertActiveModelAfterRemoval,
} from '../utils/custom-entries';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { runCustomModelEditWizard, runCustomModelWizard } from './custom-model-wizard';
import { setExperimentalFeatures } from './experimental-flags';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some(
    (entry) => entry.kind === 'user' && entry.bullet !== '',
  );
}

function currentTuiConfig(host: SlashCommandHost): TuiConfig {
  return {
    theme: host.state.appState.theme,
    language: host.state.appState.language ?? DEFAULT_TUI_CONFIG.language,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    fullscreen: host.state.appState.fullscreen ?? DEFAULT_TUI_CONFIG.fullscreen,
    vimMode: host.state.appState.vimMode === 'INSERT' || host.state.appState.vimMode === 'NORMAL',
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
  };
}

export function effectiveModelForHost(host: SlashCommandHost, model: ModelAlias): ModelAlias {
  const providerType = host.state.appState.availableProviders[model.provider]?.type;
  // Flat models (no named provider, e.g. inline base_url served by a v2
  // backend) have no provider entry to look up; their own protocol declaration
  // plays the provider-identity role, mirroring the resolver.
  return effectiveModelAlias(model, providerType ?? model.protocol);
}

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice(t('commands.plan.cleared'));
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(t('commands.plan.unknownSubcommand', { subcommand: subcmd }));
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, enabled: boolean): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        t('commands.plan.on'),
        plan?.path !== undefined ? t('commands.plan.willBeCreated', { path: plan.path }) : undefined,
      );
      return;
    }
    host.showNotice(t('commands.plan.off'));
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.plan.failed', { error: msg }));
  }
}

export async function handleYoloCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'yolo') {
      host.showNotice(t('commands.yolo.alreadyOn'));
      return;
    }
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice(t('commands.yolo.on'), t('commands.yolo.onDetail'));
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'yolo') {
      host.showNotice(t('commands.yolo.alreadyOff'));
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('commands.yolo.off'));
    return;
  }

  if (currentMode === 'yolo') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('commands.yolo.off'));
  } else {
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice(t('commands.yolo.on'), t('commands.yolo.onDetail'));
  }
}

export async function handleAutoCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'auto') {
      host.showNotice(t('commands.autoMode.alreadyOn'));
      return;
    }
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice(t('commands.autoMode.on'), t('commands.autoMode.onDetail'));
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'auto') {
      host.showNotice(t('commands.autoMode.alreadyOff'));
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('commands.autoMode.off'));
    return;
  }

  if (currentMode === 'auto') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('commands.autoMode.off'));
  } else {
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice(t('commands.autoMode.on'), t('commands.autoMode.onDetail'));
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }
  const customInstruction = args.trim() || undefined;
  await session.compact({ instruction: customInstruction });
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

/**
 * `/vim` — runtime toggle for vim modal editing (codex `/vim` parity).
 * Session-only: the persisted default stays with `editor.vim_mode` in
 * tui.toml, and `/reload` re-applies it. Enabling starts in INSERT mode;
 * mode flips afterwards arrive via the editor's onVimModeChange wiring.
 */
export function handleVimCommand(host: SlashCommandHost): void {
  const editor = host.state.editor;
  const enabled = !editor.isVimEnabled();
  editor.setVimEnabled(enabled);
  // Mirror the mode the editor settled into (like handleReloadCommand) so the
  // footer badge updates immediately instead of waiting for the first flip.
  host.setAppState({ vimMode: enabled ? editor.getVimMode() : null });
  host.showNotice(
    enabled ? t('commands.vim.on') : t('commands.vim.off'),
    enabled ? t('commands.vim.onDetail') : undefined,
  );
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(t('commands.theme.unknown', { theme }));
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleLanguageCommand(host: SlashCommandHost, args: string): Promise<void> {
  const value = args.trim();
  if (value.length === 0) {
    showLanguagePicker(host);
    return;
  }
  if (!isLocalePreference(value)) {
    host.showError(t('commands.language.invalid', { value }));
    return;
  }
  await applyLanguageChoice(host, value);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  // Kick the OAuth model-list refresh immediately — the picker mounts on the
  // cached list without waiting for the network, and its rows live-update
  // when the refresh lands (selection/search state preserved).
  const refresh = refreshModelsForPicker(host);
  if (alias === 'add') {
    await handleModelAddWizard(host);
    return;
  }
  if (alias.length > 0 && host.state.appState.availableModels[alias] === undefined) {
    // Unknown alias: give the in-flight refresh a bounded chance to introduce
    // it (e.g. a model added upstream) before reporting it as unknown.
    await withTimeout(refresh, MODEL_PICKER_REFRESH_TIMEOUT_MS);
    if (host.state.appState.availableModels[alias] === undefined) {
      host.showError(t('commands.model.unknownAlias', { alias }));
      return;
    }
  }
  // No cached models yet: wait briefly for the refresh rather than flashing
  // the "none configured" notice at a first-run user.
  if (alias.length === 0 && Object.keys(host.state.appState.availableModels).length === 0) {
    await withTimeout(refresh, MODEL_PICKER_REFRESH_TIMEOUT_MS);
  }
  // Config-derived picker state (the persisted default feeding the delete
  // confirmation's impact lines, the subagent default feeding the badge)
  // resolves lazily instead of blocking the picker on a config read.
  let defaultModel: string | undefined;
  let subagentDefault: SubagentDefault;
  const picker = showModelPicker(
    host,
    alias.length === 0 ? host.state.appState.model : alias,
    () => defaultModel,
    () => subagentDefault,
  );
  void host.harness
    .getConfig()
    .then((config) => {
      defaultModel = config.defaultModel;
      subagentDefault = secondaryAssignmentOf(config);
      // Repaint so an already-armed delete confirm picks up the impact lines
      // and the rows pick up the subagent badge.
      picker?.invalidate();
      host.state.ui.requestRender();
    })
    .catch(() => undefined); // best-effort: impact lines and the badge stay absent
  if (picker !== undefined) {
    void refresh.then(() => {
      picker.updateModels(effectiveModelsForPicker(host));
      host.state.ui.requestRender();
    });
  }
}

/** `/model add` (and the picker's "Add custom model" row): run the custom
 * model wizard, then reopen the picker — with the new alias preselected on
 * success, or at the previous state when the wizard was aborted. */
async function handleModelAddWizard(host: SlashCommandHost): Promise<void> {
  const alias = await runCustomModelWizard(host).catch((error: unknown) => {
    host.showError(t('commands.model.add.failed', { error: formatErrorMessage(error) }));
    return undefined;
  });
  await reopenModelPicker(host, alias ?? host.state.appState.model);
}

/** Alt+E on a custom model row: run the edit wizard, then reopen the picker
 * on the same alias (the wizard already reported the outcome). */
async function handleCustomModelEdit(host: SlashCommandHost, alias: string): Promise<void> {
  await runCustomModelEditWizard(host, alias).catch((error: unknown) => {
    host.showError(t('commands.model.add.saveFailed', { error: formatErrorMessage(error) }));
    return undefined;
  });
  await reopenModelPicker(host, alias);
}

/**
 * Custom-model delete (after the picker's inline [y/N] confirm): drop the
 * alias, repair the active model when it was the deleted one (fallback +
 * notice), and reopen the picker. Managed models are guarded — the picker
 * pre-filters, this is the belt-and-braces recheck.
 */
async function handleCustomModelDelete(
  host: SlashCommandHost,
  alias: string,
  subagentDefault?: () => SubagentDefault,
): Promise<void> {
  // Read before the delete: removeCloudCodeModel scrubs a dangling
  // [secondary_model] core-side, so the post-delete config no longer tells.
  const wasSubagentDefault = subagentDefault?.()?.alias === alias;
  try {
    if (!isCustomModel(host.state.appState.availableModels[alias], host.state.appState.availableProviders)) {
      host.showStatus(t('commands.model.manage.guard', { alias }), 'warning');
      showModelPicker(host, alias);
      return;
    }
    await host.harness.removeModel(alias);
    await revertActiveModelAfterRemoval(host, new Set([alias]));
    host.showStatus(t('commands.model.manage.deleted', { alias }), 'success');
    if (wasSubagentDefault) {
      host.showStatus(t('commands.model.manage.subagentCleared'), 'warning');
    }
  } catch (error) {
    host.showError(
      t('commands.model.manage.deleteFailed', { alias, error: formatErrorMessage(error) }),
    );
  }
  await reopenModelPicker(host, host.state.appState.model);
}

/** Impact lines for the picker's delete confirmation: current-model,
 * persisted-default and subagent-default flags, with the fallback named when
 * one exists. */
function modelDeleteImpact(
  host: SlashCommandHost,
  alias: string,
  defaultModel: string | undefined,
  subagentAlias: string | undefined,
): readonly string[] {
  const impact: string[] = [];
  if (alias === host.state.appState.model) {
    const fallback = resolveModelFallback(
      { models: host.state.appState.availableModels, defaultModel },
      new Set([alias]),
    );
    impact.push(
      fallback === undefined
        ? t('dialogs.model.manage.impactCurrentNone')
        : t('dialogs.model.manage.impactCurrent', {
            name: modelDisplayName(fallback, host.state.appState.availableModels[fallback]),
          }),
    );
  }
  if (defaultModel === alias) {
    impact.push(t('dialogs.model.manage.impactDefault'));
  }
  if (subagentAlias === alias) {
    impact.push(t('dialogs.model.manage.impactSubagent'));
  }
  return impact;
}

export async function handleEffortCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError(t('commands.effort.noModel'));
    return;
  }
  const effective = effectiveModelForHost(host, model);
  const segments = segmentsFor(effective);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const providerType = host.state.appState.availableProviders[effective.provider]?.type;
    const protocol = effective.protocol ?? providerType;
    if (protocol !== 'anthropic') {
      host.showError(
        t('commands.effort.unsupported', { effort: arg, alias, available: segments.join(', ') }),
      );
      return;
    }
    const knownEfforts = effective.supportEfforts?.join(', ') ?? t('commands.effort.noneDeclared');
    // Diagnostic warning (the provider validates the value downstream) — keep
    // it in the transcript so the success notice can't replace it.
    host.showStatus(
      t('commands.effort.unlisted', { effort: arg, alias, known: knownEfforts }),
      'warning',
      { transcript: true },
    );
  }
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  const alias = host.state.appState.model;
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host) ? t('commands.switch.cacheWarning') : undefined,
      onSelect: (effort) => {
        host.restoreEditor(editorSlotHandle);
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor(editorSlotHandle);
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

export function showEditorPicker(host: SlashCommandHost, returnTo?: () => void): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyEditorChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

/** In-flight OAuth model-list refreshes, keyed by host: reopening /model
 * while a refresh is still running attaches to it instead of double-fetching. */
const pickerRefreshInflight = new WeakMap<SlashCommandHost, Promise<void>>();

/**
 * Best-effort OAuth provider model refresh (skipped/failed providers surface
 * as warnings). Shared per host: concurrent /model opens await the same
 * refresh rather than triggering one network sweep each.
 */
function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  const existing = pickerRefreshInflight.get(host);
  if (existing !== undefined) return existing;
  const refresh = (async () => {
    try {
      const result = await host.authFlow.refreshOAuthProviderModels();
      if (result === undefined || result === null) return;
      for (const f of result.failed) {
        host.showStatus(
          t('commands.model.refreshProviderSkipped', { provider: f.provider, reason: f.reason }),
          'warning',
        );
      }
    } catch (error) {
      host.showStatus(
        t('commands.model.refreshSkipped', { error: formatErrorMessage(error) }),
        'warning',
      );
    }
  })();
  pickerRefreshInflight.set(host, refresh);
  void refresh.finally(() => {
    if (pickerRefreshInflight.get(host) === refresh) pickerRefreshInflight.delete(host);
  });
  return refresh;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(t('commands.editor.unchanged', { value: value.length > 0 ? value : 'auto-detect' }));
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      editorCommand,
    });
  } catch (error) {
    host.showStatus(
      t('commands.editor.saveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? t('commands.editor.setTo', { value })
      : t('commands.editor.setAutoDetect'),
  );
}

/** Effective (provider-resolved) model set the picker renders, derived from
 * the live app state. Recomputed after a background refresh lands. */
function effectiveModelsForPicker(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels).map(([alias, model]) => [
      alias,
      effectiveModelForHost(host, model),
    ]),
  );
}

/** The `[secondary_model]` assignment as the picker tracks it; undefined when
 * unset or blank (subagents then follow the main model). */
type SubagentDefault = { readonly alias: string; readonly effort?: string } | undefined;

/** The picker's view of `[secondary_model]` — config only; the
 * CLOUD_CODE_SECONDARY_MODEL/EFFORT env overrides still win at spawn. */
function secondaryAssignmentOf(config: CloudCodeConfig): SubagentDefault {
  const alias = config.secondaryModel?.model?.trim();
  if (alias === undefined || alias.length === 0) return undefined;
  const effort = config.secondaryModel?.defaultEffort?.trim();
  return { alias, ...(effort !== undefined && effort.length > 0 ? { effort } : {}) };
}

/** Reopen the picker after a CRUD flow with freshly re-resolved
 * config-derived state, so badges and delete impact lines reflect the write. */
async function reopenModelPicker(host: SlashCommandHost, selectedValue: string): Promise<void> {
  const config = await host.harness.getConfig();
  const subagentDefault = secondaryAssignmentOf(config);
  showModelPicker(host, selectedValue, () => config.defaultModel, () => subagentDefault);
}

export function showModelPicker(
  host: SlashCommandHost,
  selectedValue: string = host.state.appState.model,
  defaultModel?: () => string | undefined,
  subagentDefault?: () => SubagentDefault,
  returnTo?: () => void,
): TabbedModelSelectorComponent | undefined {
  const models = effectiveModelsForPicker(host);
  if (Object.keys(models).length === 0) {
    host.showNotice(
      t('commands.model.noneConfigured'),
      t('commands.model.noneConfiguredDetail'),
    );
    return undefined;
  }
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const component = new TabbedModelSelectorComponent({
    models,
    currentValue: host.state.appState.model,
    selectedValue,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    warning: hasConversationHistory(host) ? t('commands.switch.cacheWarning') : undefined,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor(editorSlotHandle);
      void performModelSwitch(host, alias, thinking, true);
    },
    onSessionOnlySelect: ({ alias, thinking }) => {
      host.restoreEditor(editorSlotHandle);
      void performModelSwitch(host, alias, thinking, false);
    },
    onAddCustom: () => {
      host.restoreEditor(editorSlotHandle);
      void handleModelAddWizard(host);
    },
    manage: {
      isCustom: (alias) =>
        isCustomModel(
          host.state.appState.availableModels[alias],
          host.state.appState.availableProviders,
        ),
      onEdit: (alias) => {
        host.restoreEditor(editorSlotHandle);
        void handleCustomModelEdit(host, alias);
      },
      onDelete: (alias) => {
        host.restoreEditor(editorSlotHandle);
        void handleCustomModelDelete(host, alias, subagentDefault);
      },
      onGuard: (alias) => {
        // The picker stays open; the guard reads as a transient warning.
        host.showStatus(t('commands.model.manage.guard', { alias }), 'warning');
      },
      deleteImpact: (alias) => modelDeleteImpact(host, alias, defaultModel?.(), subagentDefault?.()?.alias),
    },
    // Present only when the host resolved the subagent default (a bare
    // reopen without config state keeps the picker single-scope).
    ...(subagentDefault !== undefined
      ? {
          subagent: {
            current: subagentDefault,
            onAssign: (selection: ModelSelection | undefined) => {
              host.restoreEditor(editorSlotHandle);
              void performSubagentAssign(host, selection);
            },
          },
        }
      : {}),
    onCancel,
  });
  const editorSlotHandle = host.mountEditorReplacement(component, { onPreempt: onCancel });
  return component;
}

async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError(t('commands.model.switchWhileStreaming'));
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  let effectiveAlias = alias;
  let effectiveEffort = effort;

  const session = host.session;
  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
      const status = await session.getStatus();
      effectiveAlias = status.model ?? alias;
      effectiveEffort = status.thinkingEffort;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.model.switchFailed', { error: msg }));
    return;
  }

  if (session === undefined) {
    effectiveAlias = host.state.appState.model;
    effectiveEffort = host.state.appState.thinkingEffort;
  }
  const effectiveModelChanged = effectiveAlias !== prevModel;
  const effectiveEffortChanged = effectiveEffort !== prevEffort;
  const displayName = modelDisplayName(
    effectiveAlias,
    host.state.appState.availableModels[effectiveAlias],
  );
  host.setAppState({ model: effectiveAlias, thinkingEffort: effectiveEffort });
  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(
        host,
        effectiveAlias,
        effectiveEffort,
        effectiveEffortChanged,
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(t('commands.model.persistFailed', { name: displayName, error: msg }));
      return;
    }
  }

  let status: string;
  if (effectiveModelChanged) {
    status = persist
      ? t('commands.model.switched', { name: displayName, effort: effectiveEffort })
      : t('commands.model.switchedSession', { name: displayName, effort: effectiveEffort });
  } else if (effectiveEffortChanged) {
    status = persist
      ? t('commands.model.thinkingSet', { effort: effectiveEffort })
      : t('commands.model.thinkingSetSession', { effort: effectiveEffort });
  } else if (persist && persisted) {
    status = t('commands.model.savedDefault', { name: displayName, effort: effectiveEffort });
  } else {
    status = t('commands.model.alreadyUsing', { name: displayName, effort: effectiveEffort });
  }
  host.showStatus(status, 'success');
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  effortChanged: boolean,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const model = host.state.appState.availableModels[alias];
  const full = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model).supportEfforts,
  );
  // Re-confirming the effort shown when the picker opened is not an explicit
  // choice — persist the model but leave the stored effort preference alone.
  const patch = effortChanged ? full : { enabled: full.enabled };
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    (!effortChanged || config.thinking?.effort === patch.effort)
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
}

/**
 * Alt+A in the picker: persist the subagent default (`[secondary_model]`) or
 * clear it (selection undefined). Config-only — the live session and its
 * model are untouched, so unlike performModelSwitch there is no streaming
 * guard; new subagent spawns resolve it from the reloaded config.
 */
async function performSubagentAssign(
  host: SlashCommandHost,
  selection: ModelSelection | undefined,
): Promise<void> {
  try {
    if (selection === undefined) {
      await host.harness.setSecondaryModel({});
      host.showStatus(t('commands.model.subagentCleared'), 'success');
      return;
    }
    await host.harness.setSecondaryModel({ model: selection.alias, effort: selection.thinking });
    const name = modelDisplayName(
      selection.alias,
      host.state.appState.availableModels[selection.alias],
    );
    host.showStatus(
      t('commands.model.subagentSet', { name, effort: selection.thinking }),
      'success',
    );
  } catch (error) {
    host.showError(t('commands.model.subagentFailed', { error: formatErrorMessage(error) }));
  }
}

export function showThemePicker(host: SlashCommandHost, returnTo?: () => void): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyThemeChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(t('commands.theme.unchanged', { theme }));
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(t('commands.theme.loadFailed', { theme }), 'error');
      return;
    }
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      theme,
    });
  } catch (error) {
    host.showStatus(
      t('commands.theme.saveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  const resolved = theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.showStatus(
    theme === 'auto'
      ? t('commands.theme.setToAuto', { theme, resolved: resolved ?? 'dark' })
      : t('commands.theme.setTo', { theme }),
  );
}

export function showLanguagePicker(host: SlashCommandHost, returnTo?: () => void): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new LanguageSelectorComponent({
      currentValue: host.state.appState.language ?? DEFAULT_TUI_CONFIG.language,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyLanguageChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

/** Display label for a language preference in feedback messages. */
export function languageDisplayName(pref: LocalePreference): string {
  const key: MessageKey =
    pref === 'auto'
      ? 'dialogs.language.auto'
      : pref === 'en'
        ? 'dialogs.language.en'
        : 'dialogs.language.zh-CN';
  return t(key);
}

async function applyLanguageChoice(host: SlashCommandHost, pref: LocalePreference): Promise<void> {
  const name = languageDisplayName(pref);
  if (pref === host.state.appState.language) {
    host.showStatus(t('commands.language.unchanged', { name }));
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      language: pref,
    });
  } catch (error) {
    host.showStatus(
      t('commands.language.saveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  await host.applyLanguage(pref);
  host.showStatus(t('commands.language.set', { name }));
}

export function showPermissionPicker(host: SlashCommandHost, returnTo?: () => void): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyPermissionChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

export function showUpdatePreferencePicker(host: SlashCommandHost, returnTo?: () => void): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

export function showFullscreenPicker(host: SlashCommandHost, returnTo?: () => void): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new FullscreenSelectorComponent({
      currentValue: host.state.appState.fullscreen ?? DEFAULT_TUI_CONFIG.fullscreen,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        void applyFullscreenChoice(host, value);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

export async function showExperimentsPanel(
  host: SlashCommandHost,
  returnTo?: () => void,
): Promise<void> {
  let features: readonly ExperimentalFeatureState[];
  try {
    features = await host.harness.getExperimentalFeatures();
  } catch (error) {
    host.showError(t('commands.experiments.loadFailed', { error: formatErrorMessage(error) }));
    return;
  }
  mountExperimentsPanel(host, features, returnTo);
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
  editorSlotHandle?: EditorSlotHandle,
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus(
      t('commands.experiments.noChanges'),
      'textMuted',
    );
    return;
  }

  const experimental: Record<string, boolean> = {};
  for (const change of changes) {
    experimental[change.id] = change.enabled;
  }

  try {
    await host.harness.setConfig({ experimental });
    const features = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(features);
    host.refreshSlashCommandAutocomplete();
    host.restoreEditor(editorSlotHandle);
    if (host.session !== undefined) {
      await host.session.reloadSession();
      await host.reloadCurrentSessionView(
        host.session,
        t('commands.experiments.updatedReloaded'),
      );
    } else {
      host.showStatus(t('commands.experiments.updated'), 'success');
    }
  } catch (error) {
    host.showError(t('commands.experiments.failed', { error: formatErrorMessage(error) }));
  }
}

function mountExperimentsPanel(
  host: SlashCommandHost,
  features: readonly ExperimentalFeatureState[],
  returnTo?: () => void,
): void {
  const onCancel = () => {
    host.restoreEditor(editorSlotHandle);
    returnTo?.();
  };
  const editorSlotHandle = host.mountEditorReplacement(
    new ExperimentsSelectorComponent({
      features,
      onApply: (changes) => {
        void applyExperimentalFeatureChanges(host, changes, editorSlotHandle);
      },
      onCancel,
    }),
    { onPreempt: onCancel },
  );
}

type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade'
    > & { language?: LocalePreference };
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'upgrade'>): void;
  showStatus(msg: string, color?: string): void;
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(
      autoInstall ? t('commands.upgrade.alreadyEnabled') : t('commands.upgrade.alreadyDisabled'),
    );
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      t('commands.upgrade.saveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ upgrade });
  host.showStatus(autoInstall ? t('commands.upgrade.enabled') : t('commands.upgrade.disabled'));
}

type FullscreenHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade' | 'disablePasteBurst' | 'vimMode'
    > & { language?: LocalePreference; fullscreen?: boolean };
    readonly ui: {
      setFullscreen(enabled: boolean): void;
    };
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'fullscreen'>): void;
  showStatus(msg: string, color?: string): void;
};

export async function applyFullscreenChoice(
  host: FullscreenHost,
  fullscreen: boolean,
): Promise<void> {
  const current = host.state.appState.fullscreen ?? DEFAULT_TUI_CONFIG.fullscreen;
  if (fullscreen === current) {
    host.showStatus(
      fullscreen
        ? t('commands.fullscreen.alreadyEnabled')
        : t('commands.fullscreen.alreadyDisabled'),
    );
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      fullscreen,
    });
  } catch (error) {
    host.showStatus(
      t('commands.fullscreen.saveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ fullscreen });
  // Live-switch the render path (no restart needed): pi-tui handles the
  // alt-screen enter/exit, the SGR mouse-reporting toggle, and the forced
  // full repaint of the newly selected path. Same call /reload makes.
  host.state.ui.setFullscreen(fullscreen);
  host.showStatus(
    fullscreen ? t('commands.fullscreen.enabled') : t('commands.fullscreen.disabled'),
  );
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(t('commands.permission.unchanged', { mode }));
    return;
  }

  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.permission.failed', { error: msg }));
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(t('commands.permission.mode', { mode }));
}

// ---------------------------------------------------------------------------
// Secondary model (`/secondary_model`)
// ---------------------------------------------------------------------------

export async function handleSecondaryModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  if (Object.keys(models).length === 0) {
    host.showNotice(
      t('commands.model.noneConfigured'),
      t('commands.model.noneConfiguredDetail'),
    );
    return;
  }
  if (alias.length > 0 && models[alias] === undefined) {
    host.showError(t('commands.model.unknownAlias', { alias }));
    return;
  }
  const secondary = (await host.harness.getConfig()).secondaryModel;
  showSecondaryModelPicker(host, models, secondary?.model ?? '', secondary?.defaultEffort, alias);
}

/**
 * The models a picker may offer: the user's configured aliases with
 * host-effective provider resolution applied, minus the synthesized
 * `__secondary__` derived entry — a runtime artifact of the `[secondary_model]`
 * recipe that must never be selectable as a primary or secondary model.
 */
function pickerModelsForHost(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels)
      .filter(([alias]) => alias !== SECONDARY_DERIVED_MODEL_ALIAS)
      .map(([alias, model]) => [alias, effectiveModelForHost(host, model)]),
  );
}

function showSecondaryModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  currentEffort: string | undefined,
  selectedValue?: string,
): void {
  const editorSlotHandle = host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      ...(selectedValue !== undefined ? { selectedValue } : {}),
      currentThinkingEffort: currentEffort ?? 'off',
      title: t('commands.secondaryModel.title'),
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor(editorSlotHandle);
        void performSecondaryModelSwitch(host, alias, thinking);
      },
      onCancel: () => {
        host.restoreEditor(editorSlotHandle);
      },
    }),
  );
}

/**
 * Persist-first, then live-apply: the synthesized derived entry only exists in
 * the core config after a reload. No session-only variant — a session-local
 * recipe with patch fields would bind a derived alias the core config cannot
 * resolve.
 */
async function performSecondaryModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  let updatedConfig: CloudCodeConfig;
  try {
    updatedConfig = await host.harness.setConfig({
      secondaryModel: { model: alias, defaultEffort: effort },
    });
  } catch (error) {
    host.showError(t('commands.secondaryModel.saveFailed', { error: formatErrorMessage(error) }));
    return;
  }
  if (host.session !== undefined) {
    try {
      await host.session.applyPersistedSecondaryModel();
    } catch (error) {
      host.showError(
        t('commands.secondaryModel.applyFailed', {
          name: displayName,
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
  }
  host.setAppState({ availableModels: updatedConfig.models ?? {} });
  // Report the effective binding from the reloaded config, not the picked
  // value: CLOUD_CODE_SECONDARY_MODEL / CLOUD_CODE_SECONDARY_EFFORT override
  // the recipe at runtime, and the session binds the overlaid snapshot
  // (mirrors how /model displays the effective alias read back from the session).
  const effective = updatedConfig.secondaryModel;
  const envOverrides: string[] = [];
  if (effective?.model !== undefined && effective.model !== alias) {
    envOverrides.push(`CLOUD_CODE_SECONDARY_MODEL=${effective.model}`);
  }
  if (effective?.defaultEffort !== undefined && effective.defaultEffort !== effort) {
    envOverrides.push(`CLOUD_CODE_SECONDARY_EFFORT=${effective.defaultEffort}`);
  }
  if (envOverrides.length > 0 && effective?.model !== undefined) {
    const effectiveName = modelDisplayName(
      effective.model,
      updatedConfig.models?.[effective.model],
    );
    host.showStatus(
      t('commands.secondaryModel.envOverride', {
        name: displayName,
        vars: envOverrides.join(' and '),
        effective: effectiveName,
      }),
      'warning',
    );
    return;
  }
  host.showStatus(
    host.session === undefined
      ? t('commands.secondaryModel.savedNextSessions', { name: displayName, effort })
      : t('commands.secondaryModel.saved', { name: displayName, effort }),
    'success',
  );
}
