import {
  catalogModelToAlias,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@cloud-code/sdk';
import { capabilitiesForModel } from '@cloud-code/oauth';
import type {
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@cloud-code/oauth';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import {
  MultiChoicePickerComponent,
  type MultiChoiceOption,
} from '../components/dialogs/multi-choice-picker';
import { PlatformSelectorComponent } from '../components/dialogs/platform-selector';
import { resolveDescription, t } from '../i18n';
import type { SlashCommandHost } from './dispatch';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const selector = new PlatformSelectorComponent({
      onSelect: (platformId) => {
        host.restoreEditor(editorSlotHandle);
        resolve(platformId);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(selector, { onPreempt: onCancel });
  });
}

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new ChoicePickerComponent({
      title: t('commands.logout.selectProvider'),
      options,
      currentValue,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        resolve(value);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

export interface FeedbackPromptResult {
  readonly value: string;
}

export function promptFeedbackInput(host: SlashCommandHost): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
      host.restoreEditor(editorSlotHandle);
      resolve(result.kind === 'ok' ? { value: result.value } : undefined);
    });
    const editorSlotHandle = host.mountEditorReplacement(dialog, {
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        resolve(undefined);
      },
    });
  });
}

export type FeedbackAttachmentLevel = 'none' | 'logs' | 'logs+codebase';

// Labels/descriptions hold i18n *keys* (the constant is module-level but the
// locale is a runtime singleton); they are resolved when the picker is built.
const FEEDBACK_ATTACHMENT_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'none',
    label: 'commands.feedback.attachNone.label',
    description: 'commands.feedback.attachNone.description',
  },
  {
    value: 'logs',
    label: 'commands.feedback.attachLogs.label',
    description: 'commands.feedback.attachLogs.description',
  },
  {
    value: 'logs+codebase',
    label: 'commands.feedback.attachCodebase.label',
    description: 'commands.feedback.attachCodebase.description',
    descriptionTone: 'warning',
  },
];

export function promptFeedbackAttachment(
  host: SlashCommandHost,
): Promise<FeedbackAttachmentLevel | undefined> {
  return new Promise((resolve) => {
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new ChoicePickerComponent({
      title: t('commands.feedback.attachmentTitle'),
      options: FEEDBACK_ATTACHMENT_OPTIONS.map((option) => ({
        ...option,
        label: resolveDescription(option.label),
        description:
          option.description === undefined ? undefined : resolveDescription(option.description),
      })),
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        resolve(value as FeedbackAttachmentLevel);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = [t('commands.login.apiKeyDefaultSubtitle')],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor(editorSlotHandle);
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    const editorSlotHandle = host.mountEditorReplacement(dialog, {
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        resolve(undefined);
      },
    });
  });
}

/**
 * Asks for the provider endpoint the catalog did not declare (or declared
 * only as an env placeholder) — required for catalog imports whose protocol
 * was guessed, where the built-in default endpoint would point at the wrong
 * host. Esc cancels the import.
 */
export function promptBaseUrl(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      [t('selectors.baseUrl.subtitle')],
      (result: ApiKeyInputResult) => {
        host.restoreEditor(editorSlotHandle);
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: t('selectors.baseUrl.title', { platform: platformName }),
        mask: false,
        emptyHint: t('selectors.baseUrl.empty'),
      },
    );
    const editorSlotHandle = host.mountEditorReplacement(dialog, {
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        resolve(undefined);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Generic wizard prompts (custom provider / model wizards)
// ---------------------------------------------------------------------------

export interface InputPromptOptions {
  readonly title: string;
  readonly subtitleLines: readonly string[];
  /** Mask the typed value (API keys). Defaults to false for plain inputs. */
  readonly mask?: boolean;
  /** Allow submitting an empty value (resolves with ''). */
  readonly allowEmpty?: boolean;
  /** Prefill the input with an editable suggestion. */
  readonly initialValue?: string;
  /** Hint shown when an empty submit is rejected. */
  readonly emptyHint?: string;
  /** Inline validation; returns the error message or undefined when valid. */
  readonly validate?: (value: string) => string | undefined;
}

/** Single-line text input backed by ApiKeyInputDialogComponent. Esc resolves undefined. */
export function promptInput(
  host: SlashCommandHost,
  options: InputPromptOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      '',
      options.subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor(editorSlotHandle);
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: options.title,
        mask: options.mask ?? false,
        ...(options.allowEmpty !== undefined ? { allowEmpty: options.allowEmpty } : {}),
        ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
        ...(options.emptyHint !== undefined ? { emptyHint: options.emptyHint } : {}),
        ...(options.validate !== undefined ? { validate: options.validate } : {}),
      },
    );
    const editorSlotHandle = host.mountEditorReplacement(dialog, {
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        resolve(undefined);
      },
    });
  });
}

export interface ChoicePromptOptions {
  readonly title: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
}

/** Single-select picker. Esc resolves undefined. */
export function promptChoice(
  host: SlashCommandHost,
  options: ChoicePromptOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new ChoicePickerComponent({
      title: options.title,
      options: options.options,
      ...(options.currentValue !== undefined ? { currentValue: options.currentValue } : {}),
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        resolve(value);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

export interface MultiChoicePromptOptions {
  readonly title: string;
  readonly options: readonly MultiChoiceOption[];
  readonly initialSelected?: readonly string[];
  /**
   * Trailing action row (no checkbox): Space/Enter/click resolves with
   * {@link MULTI_CHOICE_CUSTOM_ACTION} instead of submitting — the caller
   * runs its sub-dialog and typically re-invokes this prompt with updated
   * options/selection.
   */
  readonly customActionLabel?: string;
}

/** Resolution shape when the picker's trailing custom action row fires. */
export interface MultiChoiceCustomResolution {
  readonly custom: true;
  readonly values: readonly string[];
}

/** Multi-select picker (space toggles, Enter confirms). Esc resolves undefined. */
export function promptMultiChoice(
  host: SlashCommandHost,
  options: MultiChoicePromptOptions,
): Promise<readonly string[] | MultiChoiceCustomResolution | undefined> {
  return new Promise((resolve) => {
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new MultiChoicePickerComponent({
      title: options.title,
      options: options.options,
      ...(options.initialSelected !== undefined
        ? { initialSelected: options.initialSelected }
        : {}),
      ...(options.customActionLabel !== undefined
        ? {
            customAction: {
              label: options.customActionLabel,
              onTrigger: (values) => {
                host.restoreEditor(editorSlotHandle);
                resolve({ custom: true, values });
              },
            },
          }
        : {}),
      onSubmit: (values) => {
        host.restoreEditor(editorSlotHandle);
        resolve(values);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => resolveCatalogImport(entry).kind !== 'invalid')
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError(t('commands.provider.catalogEmpty'));
      resolve(undefined);
      return;
    }

    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new ChoicePickerComponent({
      title: t('commands.provider.selectProvider'),
      options,
      searchable: true,
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        resolve(value);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

export async function promptModelSelectionForOpenPlatform(
  host: SlashCommandHost,
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): Promise<{ model: ManagedKimiCodeModelInfo; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${platform.id}/${m.id}`] = {
      provider: platform.id,
      model: m.id,
      maxContextSize: m.contextLength,
      capabilities: capabilitiesForModel(m),
      displayName: m.displayName,
    };
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: ThinkingEffort } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const onCancel = () => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinkingEffort: initialThinking ? 'on' : 'off',
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor(editorSlotHandle);
        resolve({ alias, thinking });
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(selector, { onPreempt: onCancel });
  });
}
