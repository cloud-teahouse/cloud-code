/**
 * ChatGPT Codex (OAuth) managed provider — constants, model discovery, and
 * config provisioning. Sibling implementation to managed-kimi-code.ts, built
 * on the contracts documented in docs/oauth/chatgpt-codex-oauth-research.md:
 *
 *  - Issuer `https://auth.openai.com`, first-party Codex CLI client_id.
 *  - Backend base `https://chatgpt.com/backend-api/codex` (no `/v1`).
 *  - Every backend request carries `Authorization: Bearer <access_token>`
 *    plus `ChatGPT-Account-ID: <account_id>` (from the id_token's
 *    `https://api.openai.com/auth` namespace claims).
 *  - Model discovery `GET {base}/models?client_version={v}` returns
 *    `{models: ModelInfo[]}` (slug / display_name / context_window /
 *    supported_reasoning_levels / default_reasoning_level / service_tiers).
 */

import { readApiErrorMessage } from './api-error';
import { OAuthUnauthorizedError } from './errors';
import { mergeRefreshedModelAlias } from './model-alias-merge';
import type { ManagedKimiConfigShape, ManagedKimiModelAlias } from './managed-kimi-code';
import { isRecord } from './utils';

export const CHATGPT_CODEX_PLATFORM_ID = 'chatgpt-codex';
export const CHATGPT_CODEX_PROVIDER_NAME = 'managed:chatgpt-codex';
export const CHATGPT_CODEX_OAUTH_KEY = 'oauth/chatgpt-codex';
/** Credential file / lockfile stem under the Cloud Code home dir. */
export const CHATGPT_CODEX_TOKEN_STORAGE_NAME = 'chatgpt-codex';

export const CHATGPT_CODEX_ISSUER = 'https://auth.openai.com';
export const CHATGPT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CHATGPT_CODEX_ORIGINATOR = 'codex_cli_rs';
export const CHATGPT_CODEX_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** Per-request header carrying the ChatGPT account id on backend calls. */
export const CHATGPT_ACCOUNT_ID_HEADER = 'ChatGPT-Account-ID';

/**
 * Headers every ChatGPT-backend call shares: the bearer token, JSON accept,
 * and the product User-Agent / account id when known (mirrors codex's
 * backend client `headers()`).
 */
export function chatGptBackendHeaders(options: {
  readonly accessToken: string;
  readonly accountId?: string | undefined;
  readonly userAgent?: string | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
  };
  if (options.userAgent !== undefined && options.userAgent.length > 0) {
    headers['User-Agent'] = options.userAgent;
  }
  if (options.accountId !== undefined && options.accountId.length > 0) {
    headers[CHATGPT_ACCOUNT_ID_HEADER] = options.accountId;
  }
  return headers;
}

/**
 * Login callback ports. Hard-coded: the OpenAI authorization server's
 * redirect_uri allow-list only permits these two localhost ports, so there
 * is no freedom to pick an arbitrary free port (1457 is the fallback when
 * 1455 is occupied).
 */
export const CHATGPT_CODEX_LOGIN_PORTS: readonly number[] = [1455, 1457];

export interface ChatGptCodexModelInfo {
  readonly id: string;
  readonly contextLength: number | undefined;
  readonly supportEfforts: readonly string[] | undefined;
  readonly defaultEffort: string | undefined;
  readonly displayName: string | undefined;
  /**
   * Service tier ids the catalog declares for this model (from the Codex
   * backend's `service_tiers[].id`; `'priority'` is the fast tier). Undefined
   * when the catalog declares none — the /fast gate fails closed on it.
   */
  readonly serviceTiers: readonly string[] | undefined;
}

export interface FetchChatGptCodexModelsOptions {
  readonly accessToken: string;
  /**
   * Account id from the id_token claims. Optional so degraded tokens can
   * still attempt the call; the backend may reject requests without it.
   */
  readonly accountId?: string | undefined;
  readonly baseUrl?: string | undefined;
  /**
   * Sent as the `client_version` query param; defaults to '0.0.0'.
   * WARNING: do not pass a real app version here. The Codex backend gates the
   * catalog by each model's `minimal_client_version` (≥0.98.0 for all current
   * models), so any third-party version string yields an EMPTY model list
   * (live-tested 2026-07-23: 0.28.1/0.20.0/0.55.0 → 0 models; 0.0.0 → all).
   * The param is required (omitting it → HTTP 400); '0.0.0' returns the full
   * catalog. Only override this in tests.
   */
  readonly clientVersion?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ChatGptCodexApplyResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export interface ChatGptCodexProvisionResult {
  readonly providerName: typeof CHATGPT_CODEX_PROVIDER_NAME;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly models: readonly ChatGptCodexModelInfo[];
  readonly configPath?: string | undefined;
}

export interface ChatGptCodexConfigAdapter<TConfig> {
  read(): Promise<TConfig> | TConfig;
  write(config: TConfig): Promise<void> | void;
  apply(
    config: TConfig,
    input: {
      readonly models: readonly ChatGptCodexModelInfo[];
      readonly baseUrl?: string | undefined;
      readonly oauthKey?: string | undefined;
      readonly preserveDefaultModel?: boolean | undefined;
    },
  ): ChatGptCodexApplyResult;
  remove?(config: TConfig): void;
  readonly configPath?: string | undefined;
}

export interface ProvisionChatGptCodexConfigOptions<TConfig> {
  readonly adapter: ChatGptCodexConfigAdapter<TConfig>;
  readonly accessToken: string;
  readonly accountId?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly oauthKey?: string | undefined;
  readonly preserveDefaultModel?: boolean | undefined;
  readonly clientVersion?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export class ChatGptCodexModelsAuthError extends OAuthUnauthorizedError {
  readonly status: number;
  readonly baseUrl: string;

  constructor(options: {
    readonly status: number;
    readonly baseUrl: string;
    readonly message: string;
  }) {
    super(
      `ChatGPT Codex models endpoint ${options.baseUrl} rejected OAuth credentials: ${options.message}`,
    );
    this.name = 'ChatGptCodexModelsAuthError';
    this.status = options.status;
    this.baseUrl = options.baseUrl;
  }
}

/** Fields written by a catalog refresh; everything else on an alias is user-owned. */
const CHATGPT_CODEX_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'supportEfforts',
  'defaultEffort',
  'serviceTiers',
]);

/**
 * Whether an OAuth provider reference targets the ChatGPT Codex credential
 * slot. Used by auth facades to route token resolution to the ChatGPT OAuth
 * manager instead of the Kimi device-flow manager.
 */
export function isChatGptCodexProvider(
  providerName: string | undefined,
  oauthRef?: { readonly key?: string | undefined } | undefined,
): boolean {
  return providerName === CHATGPT_CODEX_PROVIDER_NAME || oauthRef?.key === CHATGPT_CODEX_OAUTH_KEY;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? CHATGPT_CODEX_BASE_URL).replace(/\/+$/, '');
}

function toModelInfo(item: unknown): ChatGptCodexModelInfo | undefined {
  if (!isRecord(item) || typeof item['slug'] !== 'string' || item['slug'].length === 0) {
    return undefined;
  }
  // Skip backend-internal entries (e.g. codex-auto-review has visibility
  // 'hide') and models the account cannot use through the API.
  if (item['visibility'] === 'hide' || item['supported_in_api'] === false) {
    return undefined;
  }
  const contextWindow = Number(item['context_window']);
  const displayName = item['display_name'];
  const defaultEffort = item['default_reasoning_level'];
  return {
    id: item['slug'],
    contextLength:
      Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    supportEfforts: parseReasoningLevels(item['supported_reasoning_levels']),
    defaultEffort:
      typeof defaultEffort === 'string' && defaultEffort.length > 0 ? defaultEffort : undefined,
    displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined,
    serviceTiers: parseServiceTierIds(item['service_tiers']),
  };
}

/**
 * The catalog's `supported_reasoning_levels` is an array of
 * `{effort, description}` objects (not plain strings) — extract the effort
 * names in catalog order.
 *
 * Filter to the values the Responses API actually accepts (`reasoning.effort`
 * enum: none/minimal/low/medium/high/xhigh/max — 400 error message
 * 2026-07-24). The catalog advertises `ultra` ("Maximum reasoning with
 * automatic task delegation") for gpt-5.6-sol/terra, but the endpoint rejects
 * it: delegation is a separate mode, not a reasoning.effort value.
 */
const API_SUPPORTED_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function parseReasoningLevels(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => (isRecord(v) && typeof v['effort'] === 'string' && v['effort'].length > 0 ? v['effort'] : undefined))
    .filter((v): v is string => v !== undefined && API_SUPPORTED_EFFORTS.has(v));
  return out.length > 0 ? out : undefined;
}

/**
 * The catalog's `service_tiers` is an array of `{id, name, description}`
 * objects (codex protocol `ModelServiceTier`). Only the ids matter here:
 * `'priority'` is the fast tier `/fast` gates on (codex's own
 * `supports_service_tier` matches on `tier.id` the same way).
 */
function parseServiceTierIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => (isRecord(v) && typeof v['id'] === 'string' && v['id'].length > 0 ? v['id'] : undefined))
    .filter((v): v is string => v !== undefined);
  return out.length > 0 ? out : undefined;
}

export async function fetchChatGptCodexModels(
  options: FetchChatGptCodexModelsOptions,
): Promise<ChatGptCodexModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const clientVersion = options.clientVersion ?? '0.0.0';
  const url = `${baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`;
  const headers: Record<string, string> = {
    originator: CHATGPT_CODEX_ORIGINATOR,
    ...options.headers,
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
  };
  if (options.accountId !== undefined && options.accountId.length > 0) {
    headers[CHATGPT_ACCOUNT_ID_HEADER] = options.accountId;
  }
  const response = await fetchImpl(url, { headers, signal: options.signal ?? null });
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to list ChatGPT Codex models (HTTP ${response.status}).`,
    );
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new ChatGptCodexModelsAuthError({ status: response.status, baseUrl, message });
    }
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['models'])) {
    throw new Error(`Unexpected models response for ${baseUrl}.`);
  }
  return payload['models']
    .map((item) => toModelInfo(item))
    .filter((item): item is ChatGptCodexModelInfo => item !== undefined);
}

function capabilitiesForModel(model: ChatGptCodexModelInfo): string[] | undefined {
  const caps = new Set<string>();
  if (model.supportEfforts !== undefined && model.supportEfforts.length > 0) {
    caps.add('thinking');
  }
  // Codex backend models are tool-use capable; without the capability the
  // agent loop would strip tools and make the model unusable for coding.
  caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

function toChatGptCodexModelAlias(model: ChatGptCodexModelInfo): ManagedKimiModelAlias {
  const capabilities = capabilitiesForModel(model);
  return {
    provider: CHATGPT_CODEX_PROVIDER_NAME,
    model: model.id,
    maxContextSize: model.contextLength ?? 0,
    capabilities,
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.supportEfforts !== undefined ? { supportEfforts: model.supportEfforts } : {}),
    ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
    ...(model.serviceTiers !== undefined ? { serviceTiers: model.serviceTiers } : {}),
  };
}

function managedModelKey(modelId: string): string {
  return `${CHATGPT_CODEX_PLATFORM_ID}/${modelId}`;
}

function assertPositiveContextLength(model: ChatGptCodexModelInfo): void {
  if (!Number.isInteger(model.contextLength) || (model.contextLength ?? 0) <= 0) {
    throw new Error(`ChatGPT Codex model "${model.id}" must include a positive context_window.`);
  }
}

export function applyChatGptCodexConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly models: readonly ChatGptCodexModelInfo[];
    readonly baseUrl?: string | undefined;
    readonly oauthKey?: string | undefined;
    readonly preserveDefaultModel?: boolean | undefined;
  },
): ChatGptCodexApplyResult {
  if (options.models.length === 0) {
    throw new Error('No models available for ChatGPT Codex.');
  }
  for (const model of options.models) {
    assertPositiveContextLength(model);
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const oauth = {
    storage: 'file' as const,
    key: options.oauthKey ?? CHATGPT_CODEX_OAUTH_KEY,
  };
  const existingModels = config.models ?? {};
  const selectedDefault = selectDefaultModel(config, options.models, {
    preserveExisting: options.preserveDefaultModel === true,
  });

  config.providers[CHATGPT_CODEX_PROVIDER_NAME] = {
    type: 'openai_responses',
    baseUrl,
    apiKey: '',
    oauth,
    // The Codex backend rejects `max_output_tokens` outright
    // (`400 Unsupported parameter`); the completion-budget machinery honors
    // this flag as a no-op for this provider.
    omitMaxOutputTokens: true,
    // The Codex backend identifies first-party clients via the `originator`
    // header; it is part of the protocol contract (the authorize URL carries
    // the same value). The product's own User-Agent is left untouched.
    customHeaders: { originator: CHATGPT_CODEX_ORIGINATOR },
  };

  // Same merge contract as applyManagedKimiCodeConfig: upstream-owned fields
  // are overwritten, hand-written extras survive, models upstream no longer
  // lists are removed.
  const upstreamKeys = new Set(options.models.map((m) => managedModelKey(m.id)));
  for (const [key, model] of Object.entries(existingModels)) {
    if (
      isRecord(model) &&
      model['provider'] === CHATGPT_CODEX_PROVIDER_NAME &&
      !upstreamKeys.has(key)
    ) {
      delete existingModels[key];
    }
  }
  for (const model of options.models) {
    const key = managedModelKey(model.id);
    const existing = isRecord(existingModels[key]) ? existingModels[key] : {};
    existingModels[key] = mergeRefreshedModelAlias(
      existing,
      toChatGptCodexModelAlias(model),
      CHATGPT_CODEX_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
  config.defaultModel = selectedDefault.modelKey;
  config.thinking = { ...config.thinking, enabled: selectedDefault.thinking };

  return {
    defaultModel: selectedDefault.modelKey,
    defaultThinking: selectedDefault.thinking,
  };
}

function selectDefaultModel(
  config: ManagedKimiConfigShape,
  models: readonly ChatGptCodexModelInfo[],
  options: { readonly preserveExisting: boolean },
): { readonly modelKey: string; readonly thinking: boolean } {
  const firstModel = models[0];
  if (firstModel === undefined) {
    throw new Error('No models available for ChatGPT Codex.');
  }

  const managedModels = new Map(models.map((model) => [managedModelKey(model.id), model]));
  const existingModels = config.models ?? {};
  const currentDefault =
    typeof config.defaultModel === 'string' && config.defaultModel.length > 0
      ? config.defaultModel
      : undefined;

  if (options.preserveExisting && currentDefault !== undefined) {
    const existing = existingModels[currentDefault];
    // Preserve the current default when it is still one of ours, or when it
    // belongs to a different provider entirely.
    if (managedModels.has(currentDefault)) {
      const preserved = managedModels.get(currentDefault);
      return {
        modelKey: currentDefault,
        thinking: config.thinking?.enabled ?? supportsReasoning(preserved),
      };
    }
    if (isRecord(existing) && existing['provider'] !== CHATGPT_CODEX_PROVIDER_NAME) {
      return {
        modelKey: currentDefault,
        thinking: config.thinking?.enabled ?? supportsReasoning(managedModels.get(currentDefault)),
      };
    }
  }

  return {
    modelKey: managedModelKey(firstModel.id),
    thinking: config.thinking?.enabled ?? supportsReasoning(firstModel),
  };
}

function supportsReasoning(model: ChatGptCodexModelInfo | undefined): boolean {
  return model?.supportEfforts !== undefined && model.supportEfforts.length > 0;
}

export function applyChatGptCodexLogoutConfig(config: ManagedKimiConfigShape): void {
  delete config.providers[CHATGPT_CODEX_PROVIDER_NAME];

  let removedDefaultModel = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== CHATGPT_CODEX_PROVIDER_NAME) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefaultModel = true;
  }
  config.models = existingModels;

  if (removedDefaultModel) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === CHATGPT_CODEX_PROVIDER_NAME) {
    config['defaultProvider'] = undefined;
  }
}

export async function provisionChatGptCodexConfig<TConfig>(
  options: ProvisionChatGptCodexConfigOptions<TConfig>,
): Promise<ChatGptCodexProvisionResult> {
  const models = await fetchChatGptCodexModels({
    accessToken: options.accessToken,
    accountId: options.accountId,
    baseUrl: options.baseUrl,
    clientVersion: options.clientVersion,
    fetchImpl: options.fetchImpl,
  });
  const config = await options.adapter.read();
  const applied = options.adapter.apply(config, {
    models,
    baseUrl: options.baseUrl,
    oauthKey: options.oauthKey,
    preserveDefaultModel: options.preserveDefaultModel,
  });
  await options.adapter.write(config);
  return {
    providerName: CHATGPT_CODEX_PROVIDER_NAME,
    defaultModel: applied.defaultModel,
    defaultThinking: applied.defaultThinking,
    models,
    configPath: options.adapter.configPath,
  };
}
