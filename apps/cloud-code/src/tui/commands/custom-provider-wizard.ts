/**
 * Custom provider wizard — the manual "add provider" flow behind /provider.
 *
 * Steps (Esc past the first step goes back one step with the drafts kept;
 * Esc at the first step aborts and resolves `undefined`; the caller reopens
 * the provider manager):
 *   1. API type        — kimi / anthropic / openai / openai_responses
 *   2. Base URL        — required except anthropic (empty = official default);
 *                        must be an http(s) URL; a trailing /v1 is stripped for
 *                        anthropic (the SDK appends /v1/messages itself)
 *   3. API key         — masked, required (the per-type env var is mentioned
 *                        as the fallback)
 *   4. Provider id     — prefilled with a suggestion derived from the base URL
 *                        (conflicts get a numeric suffix); validated against
 *                        existing ids
 *   5. Connectivity    — optional probe of the type's models endpoint; a
 *                        failure warns but still saves
 *   6. Persist         — merged into `providers` via harness.setConfig
 *
 * Resolves with the new provider id on success so callers can chain into the
 * custom model wizard.
 */

import { t } from '../i18n';
import type { ProviderConfig } from '@cloud-code/sdk';
import { formatErrorMessage } from '../utils/event-payload';
import { isCustomProvider } from '../utils/custom-entries';
import type { SlashCommandHost } from './dispatch';
import { promptChoice, promptInput } from './prompts';

/** API types offered by the wizard (subset of the config schema's enum). */
export type CustomProviderType = 'kimi' | 'anthropic' | 'openai' | 'openai_responses';

const CUSTOM_PROVIDER_TYPES: readonly CustomProviderType[] = [
  'kimi',
  'anthropic',
  'openai',
  'openai_responses',
];

/** Env var consulted at runtime when a provider has no inline apiKey. */
const ENV_VAR_BY_TYPE: Record<CustomProviderType, string> = {
  kimi: 'KIMI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openai_responses: 'OPENAI_API_KEY',
};

/** Base-URL example shown per type (anthropic may be left empty). */
const BASE_URL_EXAMPLE_BY_TYPE: Record<CustomProviderType, string> = {
  kimi: 'https://api.kimi.com/coding/v1',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
};

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const PROBE_TIMEOUT_MS = 10_000;

export async function runCustomProviderWizard(
  host: SlashCommandHost,
): Promise<string | undefined> {
  // Step loop: Esc past the first step returns to the previous step with the
  // drafts preserved (the API key is re-entered — masked secrets are never
  // prefilled); Esc at the first step aborts the wizard. The existing-ids
  // list is fetched lazily at the id step so the first prompt mounts
  // synchronously.
  let step = 0;
  let type: CustomProviderType | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let providerId: string | undefined;
  let verify = false;

  for (;;) {
    if (step === 0) {
      const picked = await promptCustomProviderType(host, type);
      if (picked === undefined) return undefined;
      type = picked;
      step = 1;
      continue;
    }
    if (step === 1) {
      const answer = await promptCustomBaseUrl(host, type!, baseUrl, true);
      if (answer.kind === 'cancel') {
        step = 0;
        continue;
      }
      baseUrl = answer.value;
      step = 2;
      continue;
    }
    if (step === 2) {
      const entered = await promptCustomApiKey(host, type!, 'required', true);
      if (entered === undefined) {
        step = 1;
        continue;
      }
      apiKey = entered;
      step = 3;
      continue;
    }
    if (step === 3) {
      const existingIds = await host.harness
        .getConfig()
        .then((config) => Object.keys(config.providers ?? {}));
      const entered = await promptCustomProviderId(
        host,
        providerId ?? deriveProviderIdSuggestion(type!, baseUrl, existingIds),
        existingIds,
        true,
      );
      if (entered === undefined) {
        step = 2;
        continue;
      }
      providerId = entered;
      step = 4;
      continue;
    }
    const choice = await promptChoice(host, {
      title: t('commands.provider.custom.verifyTitle'),
      options: [
        { value: 'yes', label: t('commands.provider.custom.verifyYes') },
        { value: 'no', label: t('commands.provider.custom.verifyNo') },
      ],
      escBack: true,
    });
    if (choice === undefined) {
      step = 3;
      continue;
    }
    verify = choice === 'yes';
    break;
  }

  if (verify) {
    await verifyCustomProvider(host, type!, baseUrl, apiKey!);
  }

  try {
    const config = await host.harness.getConfig();
    const providers = { ...config.providers };
    providers[providerId!] = {
      type: type!,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      apiKey: apiKey!,
    };
    await host.harness.setConfig({ providers });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(
      t('commands.provider.custom.saveFailed', { error: formatErrorMessage(error) }),
    );
    return undefined;
  }

  host.showStatus(t('commands.provider.custom.added', { id: providerId! }), 'success');
  return providerId;
}

function promptCustomProviderType(
  host: SlashCommandHost,
  currentValue?: CustomProviderType,
  escBack = false,
): Promise<CustomProviderType | undefined> {
  return promptChoice(host, {
    title: t('commands.provider.custom.typeTitle'),
    options: CUSTOM_PROVIDER_TYPES.map((type) => ({
      value: type,
      label: t(`commands.provider.custom.type.${type}.label`),
      description: t(`commands.provider.custom.type.${type}.description`),
    })),
    ...(currentValue !== undefined ? { currentValue } : {}),
    escBack,
  }).then((value) =>
    CUSTOM_PROVIDER_TYPES.includes(value as CustomProviderType)
      ? (value as CustomProviderType)
      : undefined,
  );
}

/** Distinguishes "anthropic default endpoint" (ok, no value) from Esc (cancel). */
type BaseUrlAnswer =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ok'; readonly value?: string };

function promptCustomBaseUrl(
  host: SlashCommandHost,
  type: CustomProviderType,
  initialValue?: string,
  escBack = false,
): Promise<BaseUrlAnswer> {
  const optional = type === 'anthropic';
  return promptInput(host, {
    title: t('commands.provider.custom.baseUrlTitle', { type }),
    subtitleLines: [
      optional
        ? t('commands.provider.custom.baseUrlSubtitleOptional', {
            example: BASE_URL_EXAMPLE_BY_TYPE[type],
          })
        : t('commands.provider.custom.baseUrlSubtitle', {
            example: BASE_URL_EXAMPLE_BY_TYPE[type],
          }),
    ],
    allowEmpty: optional,
    emptyHint: t('commands.provider.custom.baseUrlInvalid'),
    ...(initialValue !== undefined ? { initialValue } : {}),
    validate: (value) => (isValidHttpUrl(value) ? undefined : t('commands.provider.custom.baseUrlInvalid')),
    escBack,
  }).then((value) => {
    if (value === undefined) return { kind: 'cancel' };
    // Anthropic only: empty means the official SDK default endpoint.
    if (value.length === 0) return { kind: 'ok' };
    // The Anthropic SDK appends /v1/messages itself — persisting a trailing
    // /v1 would double it (mirrors adaptBaseUrlForWire in the catalog import).
    return { kind: 'ok', value: type === 'anthropic' ? value.replace(/\/v1\/?$/, '') : value };
  });
}

function isValidHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function promptCustomApiKey(
  host: SlashCommandHost,
  type: CustomProviderType,
  mode: 'required' | 'keep-current' = 'required',
  escBack = false,
): Promise<string | undefined> {
  return promptInput(host, {
    title: t('commands.provider.custom.apiKeyTitle', { type }),
    subtitleLines: [
      mode === 'keep-current'
        ? t('commands.provider.custom.apiKeyEditSubtitle', { env: ENV_VAR_BY_TYPE[type] })
        : t('commands.provider.custom.apiKeySubtitle', { env: ENV_VAR_BY_TYPE[type] }),
    ],
    mask: true,
    ...(mode === 'keep-current' ? { allowEmpty: true } : {}),
    escBack,
  });
}

/** Field set the provider wizard (add and edit) collects. */
export interface CustomProviderDraft {
  readonly type: CustomProviderType;
  /** Undefined = the type's official default endpoint (anthropic only). */
  readonly baseUrl?: string;
  /** Undefined = no inline key; the per-type env var is the runtime fallback. */
  readonly apiKey?: string;
}

/**
 * Build the persisted provider entry for `draft`. With `base` (edit) unknown
 * extra fields (`customHeaders`, `env`, …) carry over; cleared draft fields
 * remove the key entirely so the wholesale `setProvider` write does not
 * resurrect them.
 */
export function buildCustomProviderEntry(
  base: ProviderConfig | undefined,
  draft: CustomProviderDraft,
): ProviderConfig {
  const entry: ProviderConfig = { ...base, type: draft.type };
  if (draft.baseUrl !== undefined) entry.baseUrl = draft.baseUrl;
  else delete entry.baseUrl;
  if (draft.apiKey !== undefined) entry.apiKey = draft.apiKey;
  else delete entry.apiKey;
  return entry;
}

/**
 * Edit wizard for an existing custom provider — the add steps with the
 * current values prefilled: API type → base URL → API key (empty keeps the
 * current one) → optional connectivity re-check → persist. The provider id
 * is immutable (model aliases hang off it). Only a real change is written —
 * wholesale, via `harness.setProvider`, so cleared fields actually clear.
 * Esc past the first step goes back one step; Esc at the first step aborts.
 *
 * Resolves 'updated' / 'unchanged', or `undefined` when aborted or the
 * provider is not a custom one (managed providers get a guard message).
 */
export async function runCustomProviderEditWizard(
  host: SlashCommandHost,
  providerId: string,
): Promise<'updated' | 'unchanged' | undefined> {
  const config = await host.harness.getConfig();
  const existing = config.providers[providerId];
  if (existing === undefined) {
    host.showError(t('commands.provider.edit.gone', { id: providerId }));
    return undefined;
  }
  if (!isCustomProvider(providerId, existing)) {
    host.showError(t('commands.provider.edit.guard', { id: providerId }));
    return undefined;
  }
  if (!CUSTOM_PROVIDER_TYPES.includes(existing.type as CustomProviderType)) {
    host.showError(
      t('commands.provider.edit.unsupportedType', { id: providerId, type: existing.type }),
    );
    return undefined;
  }
  const currentType = existing.type as CustomProviderType;

  let step = 0;
  let type: CustomProviderType = currentType;
  let baseUrl: string | undefined = existing.baseUrl;
  let apiKey: string | undefined = existing.apiKey;
  let verify = false;

  for (;;) {
    if (step === 0) {
      const picked = await promptCustomProviderType(host, type);
      if (picked === undefined) return undefined;
      type = picked;
      step = 1;
      continue;
    }
    if (step === 1) {
      const answer = await promptCustomBaseUrl(host, type, baseUrl, true);
      if (answer.kind === 'cancel') {
        step = 0;
        continue;
      }
      baseUrl = answer.value;
      step = 2;
      continue;
    }
    if (step === 2) {
      const entered = await promptCustomApiKey(host, type, 'keep-current', true);
      if (entered === undefined) {
        step = 1;
        continue;
      }
      apiKey = entered.length > 0 ? entered : existing.apiKey;
      step = 3;
      continue;
    }
    const entry = buildCustomProviderEntry(existing, { type, baseUrl, apiKey });
    const changed =
      type !== existing.type || baseUrl !== existing.baseUrl || apiKey !== existing.apiKey;
    if (!changed) {
      host.showStatus(t('commands.provider.edit.unchanged', { id: providerId }));
      return 'unchanged';
    }
    const choice = await promptChoice(host, {
      title: t('commands.provider.custom.verifyTitle'),
      options: [
        { value: 'yes', label: t('commands.provider.custom.verifyYes') },
        { value: 'no', label: t('commands.provider.custom.verifyNo') },
      ],
      escBack: true,
    });
    if (choice === undefined) {
      step = 2;
      continue;
    }
    verify = choice === 'yes';

    if (verify) {
      await verifyCustomProvider(host, type, baseUrl, apiKey ?? '');
    }

    try {
      await host.harness.setProvider(providerId, entry);
      await host.authFlow.refreshAvailableModels();
    } catch (error) {
      host.showError(
        t('commands.provider.custom.saveFailed', { error: formatErrorMessage(error) }),
      );
      return undefined;
    }

    host.showStatus(t('commands.provider.edit.updated', { id: providerId }), 'success');
    return 'updated';
  }
}

function promptCustomProviderId(
  host: SlashCommandHost,
  suggestion: string,
  existingIds: readonly string[],
  escBack = false,
): Promise<string | undefined> {
  return promptInput(host, {
    title: t('commands.provider.custom.idTitle'),
    subtitleLines: [t('commands.provider.custom.idSubtitle', { id: suggestion })],
    initialValue: suggestion,
    escBack,
    validate: (value) => {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
        return t('commands.provider.custom.idInvalid');
      }
      if (isReservedProviderId(value)) {
        return t('commands.provider.custom.idReserved', { id: value });
      }
      if (existingIds.includes(value)) {
        return t('commands.provider.custom.idTaken', { id: value });
      }
      return undefined;
    },
  });
}

/**
 * Ids a custom provider must not take: the managed OAuth services and their
 * alias namespaces. A custom provider named `kimi` renders with the same
 * service label as the managed login and its models become
 * indistinguishable from the managed ones in the picker.
 */
const RESERVED_PROVIDER_IDS: readonly string[] = ['kimi', 'chatgpt-codex', 'kimi-code'];

export function isReservedProviderId(id: string): boolean {
  return id.startsWith('managed:') || RESERVED_PROVIDER_IDS.includes(id);
}

/**
 * Derives a provider id from the base URL's hostname (second-level label:
 * `api.example.com` → `example`), sanitized to the id charset; conflicts get
 * a `-2`, `-3`, … suffix. Falls back to the API type name, then `custom`.
 */
export function deriveProviderIdSuggestion(
  type: CustomProviderType,
  baseUrl: string | undefined,
  existingIds: readonly string[],
): string {
  let base = '';
  if (baseUrl !== undefined) {
    try {
      const parts = new URL(baseUrl).hostname.split('.').filter((part) => part.length > 0);
      const core = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
      base = sanitizeProviderId(core);
    } catch {
      base = '';
    }
  }
  if (base.length === 0) base = sanitizeProviderId(type);
  if (base.length === 0) base = 'custom';
  // A suggestion colliding with the managed service ids would shadow their
  // display names — start from a neutral name instead.
  if (isReservedProviderId(base)) base = `${base}-custom`;

  let candidate = base;
  for (let n = 2; existingIds.includes(candidate) || isReservedProviderId(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function sanitizeProviderId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return /^[a-z0-9]/.test(cleaned) ? cleaned : '';
}

export interface CustomProviderProbeResult {
  readonly ok: boolean;
  /** Number of models listed by the endpoint, when the response parses. */
  readonly modelCount?: number;
  readonly error?: string;
}

/**
 * Lightweight connectivity probe against the type's models endpoint:
 * `{baseUrl}/v1/models` for anthropic (x-api-key + anthropic-version),
 * `{baseUrl}/models` for the OpenAI-family wires (Bearer). Never throws —
 * the wizard warns and saves anyway.
 */
export async function probeCustomProvider(
  type: CustomProviderType,
  baseUrl: string | undefined,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomProviderProbeResult> {
  const url =
    type === 'anthropic'
      ? `${baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}/v1/models`
      : `${baseUrl ?? ''}/models`;
  const headers: Record<string, string> =
    type === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    try {
      const body: unknown = await res.json();
      const data = (body as { readonly data?: unknown }).data;
      return { ok: true, ...(Array.isArray(data) ? { modelCount: data.length } : {}) };
    } catch {
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

async function verifyCustomProvider(
  host: SlashCommandHost,
  type: CustomProviderType,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<void> {
  const url =
    type === 'anthropic'
      ? `${baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}/v1/models`
      : `${baseUrl ?? ''}/models`;
  const spinner = host.showProgressSpinner(t('commands.provider.custom.verifying', { url }));
  const result = await probeCustomProvider(type, baseUrl, apiKey);
  if (result.ok) {
    const label =
      result.modelCount !== undefined
        ? t('commands.provider.custom.verifyOkCount', { count: result.modelCount })
        : t('commands.provider.custom.verifyOk');
    spinner.stop({ ok: true, label });
    host.showStatus(label, 'success');
    return;
  }
  spinner.stop({ ok: false, label: t('commands.provider.custom.verifyFailedSpinner') });
  host.showStatus(
    t('commands.provider.custom.verifyFailed', {
      error: result.error ?? t('commands.provider.custom.verifyFailedUnknown'),
    }),
    'warning',
  );
}
