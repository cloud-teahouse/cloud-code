/**
 * Custom model wizard — the "add custom model" flow behind /model.
 *
 * Steps (Esc at any step aborts and resolves `undefined`; the caller reopens
 * the model picker):
 *   a. Provider      — existing providers, plus a "new provider…" entry that
 *                      chains into the custom provider wizard
 *   b. Model id      — the model name sent on the wire; the resulting
 *                      `provider/model` alias must not already exist
 *   c. Display name  — optional; empty falls back to the model id
 *   d. Context window — positive integer; prefilled with a per-API-type default
 *   e. Thinking efforts — multi-select (none/minimal/…/max) mapped onto
 *                      supportEfforts (+ offEffort for 'none')
 *   f. Capabilities  — multi-select (tool_use, image_in, …)
 *   g. Persist       — merged into `models` via harness.setConfig; the shape
 *                      matches ModelAliasBaseSchema, so the alias works for
 *                      sub-agents (profile.model / secondary_model) like any
 *                      catalog-imported model.
 *
 * Resolves with the new alias on success so callers can select it in the
 * model picker.
 */

import { t } from '../i18n';
import type { ModelAlias } from '@cloud-code/sdk';
import { formatErrorMessage } from '../utils/event-payload';
import { isCustomModel } from '../utils/custom-entries';
import { runCustomProviderWizard } from './custom-provider-wizard';
import type { SlashCommandHost } from './dispatch';
import { promptChoice, promptInput, promptMultiChoice } from './prompts';

export interface CustomModelWizardOptions {
  /** Skip the provider step (e.g. chained from the provider wizard). */
  readonly initialProviderId?: string;
}

const NEW_PROVIDER_VALUE = '__new_provider__';

/** Thinking effort levels offered by the multi-select, mapped onto
 * supportEfforts; 'none' maps onto offEffort (the wire value that disables
 * thinking, models.dev convention). */
const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Preselected efforts per API type: kimi/anthropic endpoints default to all
 * levels, the OpenAI family to the common reasoning tiers. */
const DEFAULT_EFFORTS_BY_TYPE: Record<string, readonly string[]> = {
  kimi: EFFORT_LEVELS,
  anthropic: EFFORT_LEVELS,
  openai: ['low', 'medium', 'high'],
  openai_responses: ['low', 'medium', 'high'],
};
const DEFAULT_EFFORTS_FALLBACK: readonly string[] = ['low', 'medium', 'high'];

/** Context-window prefill per API type (editable; empty keeps the default). */
const CONTEXT_DEFAULT_BY_TYPE: Record<string, number> = {
  kimi: 262_144,
  anthropic: 200_000,
  openai: 128_000,
  openai_responses: 400_000,
};
const CONTEXT_DEFAULT_FALLBACK = 200_000;

const CAPABILITY_VALUES = [
  'tool_use',
  'image_in',
  'video_in',
  'audio_in',
  'dynamically_loaded_tools',
] as const;

export async function runCustomModelWizard(
  host: SlashCommandHost,
  options: CustomModelWizardOptions = {},
): Promise<string | undefined> {
  const providerId = await resolveWizardProvider(host, options.initialProviderId);
  if (providerId === undefined) return undefined;

  const providers = await host.harness.getConfig().then((config) => config.providers ?? {});
  const providerType = providers[providerId]?.type ?? 'openai';

  const existingAliases = await host.harness
    .getConfig()
    .then((config) => new Set(Object.keys(config.models ?? {})));

  // b. Model id — the alias `provider/model` it produces must be unique.
  const modelId = await promptInput(host, {
    title: t('commands.model.add.modelIdTitle'),
    subtitleLines: [t('commands.model.add.modelIdSubtitle')],
    emptyHint: t('commands.model.add.modelIdEmpty'),
    validate: (value) =>
      existingAliases.has(`${providerId}/${value}`)
        ? t('commands.model.add.aliasTaken', { alias: `${providerId}/${value}` })
        : undefined,
  });
  if (modelId === undefined) return undefined;

  // c. Display name — optional, falls back to the model id.
  const displayNameInput = await promptInput(host, {
    title: t('commands.model.add.displayNameTitle'),
    subtitleLines: [t('commands.model.add.displayNameSubtitle')],
    allowEmpty: true,
    initialValue: modelId,
  });
  if (displayNameInput === undefined) return undefined;
  const displayName = displayNameInput.length > 0 ? displayNameInput : modelId;

  // d. Context window — positive integer, prefilled with the type default.
  const contextDefault = CONTEXT_DEFAULT_BY_TYPE[providerType] ?? CONTEXT_DEFAULT_FALLBACK;
  const contextRaw = await promptInput(host, {
    title: t('commands.model.add.contextTitle'),
    subtitleLines: [
      t('commands.model.add.contextSubtitle', { type: providerType, default: contextDefault }),
    ],
    allowEmpty: true,
    initialValue: String(contextDefault),
    emptyHint: t('commands.model.add.contextInvalid'),
    validate: (value) =>
      /^[1-9]\d*$/.test(value) ? undefined : t('commands.model.add.contextInvalid'),
  });
  if (contextRaw === undefined) return undefined;
  const maxContextSize = contextRaw.length === 0 ? contextDefault : Number.parseInt(contextRaw, 10);

  // e. Thinking efforts — multi-select with per-type preselection.
  const efforts = await promptEfforts(
    host,
    DEFAULT_EFFORTS_BY_TYPE[providerType] ?? DEFAULT_EFFORTS_FALLBACK,
  );
  if (efforts === undefined) return undefined;

  // f. Capabilities — multi-select; 'thinking' is implied by the effort step.
  const capabilities = await promptCapabilities(host, ['tool_use']);
  if (capabilities === undefined) return undefined;

  // g. Persist — the shape mirrors ModelAliasBaseSchema exactly.
  const alias = `${providerId}/${modelId}`;
  try {
    const config = await host.harness.getConfig();
    const models = { ...config.models };
    models[alias] = buildCustomModelEntry(providerId, modelId, {
      displayName,
      maxContextSize,
      efforts,
      capabilities,
    });
    await host.harness.setConfig({ models });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(t('commands.model.add.saveFailed', { error: formatErrorMessage(error) }));
    return undefined;
  }

  host.showStatus(t('commands.model.add.added', { alias }), 'success');
  return alias;
}

/**
 * Provider step: pick an existing provider, or chain into the custom provider
 * wizard via the trailing "new provider…" option (aborting that wizard loops
 * back to the provider list). With no providers configured the only way
 * forward is the new-provider option.
 */
async function resolveWizardProvider(
  host: SlashCommandHost,
  initialProviderId: string | undefined,
): Promise<string | undefined> {
  let providers = await host.harness.getConfig().then((config) => config.providers ?? {});
  if (initialProviderId !== undefined && providers[initialProviderId] !== undefined) {
    return initialProviderId;
  }

  for (;;) {
    const options = [
      ...Object.entries(providers).map(([id, provider]) => ({
        value: id,
        label: id,
        description: provider.type,
      })),
      { value: NEW_PROVIDER_VALUE, label: t('commands.model.add.newProviderOption') },
    ];
    const picked = await promptChoice(host, {
      title: t('commands.model.add.providerTitle'),
      options,
    });
    if (picked === undefined) return undefined;
    if (picked !== NEW_PROVIDER_VALUE) return picked;

    const created = await runCustomProviderWizard(host);
    providers = await host.harness.getConfig().then((config) => config.providers ?? {});
    if (created !== undefined) return created;
    // Aborted the provider wizard — loop back to the provider list.
  }
}

// ---------------------------------------------------------------------------
// Shared field steps & entry builder (add and edit wizards)
// ---------------------------------------------------------------------------

/**
 * Thinking-effort multi-select ('none' is the offEffort wire value) with a
 * trailing "custom names…" action row inside the same picker: firing it opens
 * the free-text input and returns to the picker with the typed names injected
 * as checked options (built-in checks preserved). `initialEfforts` may contain
 * custom names (edit prefill) — they are seeded as extra checked options.
 */
async function promptEfforts(
  host: SlashCommandHost,
  initialEfforts: readonly string[],
): Promise<readonly string[] | undefined> {
  const customEffortOptions: Array<{ value: string; label: string }> = [];
  for (const name of initialEfforts) {
    if (
      !(EFFORT_LEVELS as readonly string[]).includes(name) &&
      !customEffortOptions.some((option) => option.value === name)
    ) {
      customEffortOptions.push({ value: name, label: name });
    }
  }
  let effortSelection = initialEfforts;
  for (;;) {
    const values = await promptMultiChoice(host, {
      title: t('commands.model.add.effortsTitle'),
      options: [
        ...EFFORT_LEVELS.map((value) => ({
          value,
          label: value,
          ...(value === 'none' ? { description: t('commands.model.add.effortNoneDesc') } : {}),
        })),
        ...customEffortOptions,
      ],
      initialSelected: effortSelection,
      customActionLabel: t('commands.model.add.customEffortsOption'),
    });
    if (values === undefined) return undefined;
    if (typeof values === 'object' && 'custom' in values) {
      // Custom names flow to the provider verbatim on OpenAI-compatible wires
      // (kosong's ThinkingEffort is an open string type).
      const raw = await promptInput(host, {
        title: t('commands.model.add.customEffortsTitle'),
        subtitleLines: [],
        allowEmpty: true,
        validate: (value) => {
          const tokens = value
            .split(',')
            .map((part) => part.trim().toLowerCase())
            .filter((part) => part.length > 0);
          return tokens.every((part) => /^[a-z0-9_-]+$/.test(part))
            ? undefined
            : t('commands.model.add.customEffortsInvalid');
        },
      });
      // Esc from the name input returns to the picker, not out of the wizard.
      if (raw === undefined) {
        effortSelection = values.values;
        continue;
      }
      const known = new Set([
        ...EFFORT_LEVELS,
        ...customEffortOptions.map((option) => option.value),
      ]);
      const added: string[] = [];
      for (const name of new Set(
        raw
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter((part) => part.length > 0),
      )) {
        if (known.has(name)) continue;
        known.add(name);
        customEffortOptions.push({ value: name, label: name });
        added.push(name);
      }
      effortSelection = [...values.values, ...added];
      continue;
    }
    return values;
  }
}

/** Capabilities multi-select; 'thinking' is derived from the effort step. */
async function promptCapabilities(
  host: SlashCommandHost,
  initialSelected: readonly string[],
): Promise<readonly string[] | undefined> {
  const capabilities = await promptMultiChoice(host, {
    title: t('commands.model.add.capsTitle'),
    options: CAPABILITY_VALUES.map((value) => ({
      value,
      label: t(`commands.model.add.cap.${value}`),
    })),
    initialSelected,
  });
  if (capabilities === undefined || 'custom' in capabilities) return undefined;
  return capabilities;
}

/** Field set the model wizard (add and edit) collects. */
export interface CustomModelDraft {
  readonly displayName: string;
  readonly maxContextSize: number;
  /** Picker values; the 'none' entry maps onto offEffort, the rest onto supportEfforts. */
  readonly efforts: readonly string[];
  /** Picker values, without the derived 'thinking' capability. */
  readonly capabilities: readonly string[];
}

/**
 * Build the persisted alias entry for `draft` — the ModelAliasBaseSchema
 * shape catalog imports produce. With `base` (edit) fields the wizard does
 * not own (`maxInputSize`, `reasoningKey`, …) carry over, hand-written
 * capabilities outside the picker's vocabulary are preserved, and a custom
 * offEffort wire value survives; fields the draft emptied are removed so the
 * wholesale `setModelAlias` write does not resurrect them.
 */
export function buildCustomModelEntry(
  providerId: string,
  modelId: string,
  draft: CustomModelDraft,
  base?: ModelAlias,
): ModelAlias {
  const supportEfforts = draft.efforts.filter((effort) => effort !== 'none');
  const offSelected = draft.efforts.includes('none');

  const capabilities = [...draft.capabilities];
  for (const capability of base?.capabilities ?? []) {
    if (
      capability !== 'thinking' &&
      !(CAPABILITY_VALUES as readonly string[]).includes(capability) &&
      !capabilities.includes(capability)
    ) {
      capabilities.push(capability);
    }
  }
  if (supportEfforts.length > 0 || offSelected) capabilities.push('thinking');

  const offEffort = offSelected ? (base?.offEffort ?? 'none') : undefined;

  const entry: ModelAlias = {
    ...base,
    provider: providerId,
    model: modelId,
    maxContextSize: draft.maxContextSize,
    displayName: draft.displayName,
  };
  if (capabilities.length > 0) entry.capabilities = capabilities;
  else delete entry.capabilities;
  if (supportEfforts.length > 0) entry.supportEfforts = [...supportEfforts];
  else delete entry.supportEfforts;
  if (offEffort !== undefined) entry.offEffort = offEffort;
  else delete entry.offEffort;
  // A default effort the edited model no longer supports is dropped.
  if (
    entry.defaultEffort !== undefined &&
    !(entry.supportEfforts ?? []).includes(entry.defaultEffort)
  ) {
    delete entry.defaultEffort;
  }
  return entry;
}

/** Picker-state projection of a persisted entry's effort fields. */
function effortsOfEntry(entry: ModelAlias): readonly string[] {
  return [...(entry.supportEfforts ?? []), ...(entry.offEffort !== undefined ? ['none'] : [])];
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const xs = [...(a ?? [])].sort();
  const ys = [...(b ?? [])].sort();
  return xs.length === ys.length && xs.every((value, index) => value === ys[index]);
}

/** True when the edit produced no change in any wizard-owned field. */
function modelEntryUnchanged(entry: ModelAlias, base: ModelAlias): boolean {
  return (
    entry.displayName === (base.displayName ?? base.model) &&
    entry.maxContextSize === base.maxContextSize &&
    sameStrings(entry.capabilities, base.capabilities) &&
    sameStrings(entry.supportEfforts, base.supportEfforts) &&
    entry.offEffort === base.offEffort &&
    entry.defaultEffort === base.defaultEffort
  );
}

/**
 * Edit wizard for an existing custom model — the add steps minus provider and
 * model id (both immutable: the alias `provider/model` hangs off them) with
 * the current values prefilled: display name → context window → thinking
 * efforts (incl. custom names) → capabilities. Only a real change is written
 * — wholesale, via `harness.setModelAlias`, so cleared fields actually clear.
 *
 * Resolves 'updated' / 'unchanged', or `undefined` when aborted or the alias
 * is not a custom model (managed models get a guard message).
 */
export async function runCustomModelEditWizard(
  host: SlashCommandHost,
  alias: string,
): Promise<'updated' | 'unchanged' | undefined> {
  const config = await host.harness.getConfig();
  const existing = config.models?.[alias];
  if (existing === undefined) {
    host.showError(t('commands.model.edit.gone', { alias }));
    return undefined;
  }
  if (!isCustomModel(existing, config.providers ?? {})) {
    host.showError(t('commands.model.edit.guard', { alias }));
    return undefined;
  }

  // Display name — optional, falls back to the model id (same as add).
  const displayNameInput = await promptInput(host, {
    title: t('commands.model.add.displayNameTitle'),
    subtitleLines: [t('commands.model.add.displayNameSubtitle')],
    allowEmpty: true,
    initialValue: existing.displayName ?? existing.model,
  });
  if (displayNameInput === undefined) return undefined;
  const displayName = displayNameInput.length > 0 ? displayNameInput : existing.model;

  // Context window — positive integer, prefilled with the current value.
  const contextRaw = await promptInput(host, {
    title: t('commands.model.add.contextTitle'),
    subtitleLines: [
      t('commands.model.edit.contextSubtitle', { current: existing.maxContextSize }),
    ],
    initialValue: String(existing.maxContextSize),
    emptyHint: t('commands.model.add.contextInvalid'),
    validate: (value) =>
      /^[1-9]\d*$/.test(value) ? undefined : t('commands.model.add.contextInvalid'),
  });
  if (contextRaw === undefined) return undefined;
  const maxContextSize = Number.parseInt(contextRaw, 10);

  // Thinking efforts — prefilled from the entry (custom names included).
  const efforts = await promptEfforts(host, effortsOfEntry(existing));
  if (efforts === undefined) return undefined;

  // Capabilities — prefilled with the picker-known, non-derived entries.
  const initialCapabilities = (existing.capabilities ?? []).filter(
    (capability) =>
      capability !== 'thinking' &&
      (CAPABILITY_VALUES as readonly string[]).includes(capability),
  );
  const capabilities = await promptCapabilities(host, initialCapabilities);
  if (capabilities === undefined) return undefined;

  const entry = buildCustomModelEntry(
    existing.provider,
    existing.model,
    { displayName, maxContextSize, efforts, capabilities },
    existing,
  );
  if (modelEntryUnchanged(entry, existing)) {
    host.showStatus(t('commands.model.edit.unchanged', { alias }));
    return 'unchanged';
  }

  try {
    await host.harness.setModelAlias(alias, entry);
    await host.authFlow.refreshAvailableModels();
    // The context-window edit of the live model is reflected immediately.
    if (host.state.appState.model === alias) {
      host.setAppState({ maxContextTokens: maxContextSize });
    }
  } catch (error) {
    host.showError(t('commands.model.add.saveFailed', { error: formatErrorMessage(error) }));
    return undefined;
  }

  host.showStatus(t('commands.model.edit.updated', { alias }), 'success');
  return 'updated';
}
