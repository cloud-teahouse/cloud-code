import { type ChatProvider } from '@cloud-code/kosong';
import { OpenAIResponsesChatProvider } from '@cloud-code/kosong/providers/openai-responses';

import type { ServiceTierConfig } from '#/config/schema';

import type { ServiceTier } from './types';

/**
 * Wire value of the codex fast tier (`ServiceTier::Fast` serializes to
 * "priority"; codex `config_types.rs`). The catalog declares it as a
 * `service_tiers[].id` entry on each fast-capable model.
 */
export const FAST_SERVICE_TIER_ID = 'priority';

/** Model metadata the fast-tier gate needs: catalog-declared service tiers. */
export interface FastTierModelShape {
  readonly serviceTiers?: readonly string[] | undefined;
}

/** The resolved model plus its provider's own declaration (request-side use). */
export interface FastTierResolvedModelShape extends FastTierModelShape {
  readonly providerServiceTiers?: readonly string[] | undefined;
}

/** Provider metadata the fast-tier gate needs: wire type, endpoint, and any
 * endpoint-level service_tier declaration (explicit third-party opt-in). */
export interface FastTierProviderShape {
  readonly type?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly serviceTiers?: readonly string[] | undefined;
}

/**
 * The single decision point for "may the fast tier (`service_tier:
 * 'priority'`) apply to this model" — shared by the `/fast` command, the
 * footer fast marker, and the request-side guard below.
 *
 * True only when the provider speaks `openai_responses` AND the model's
 * effective tiers declare `'priority'` AND one of:
 *  - the endpoint is the official Codex backend (chatgpt.com) — tiers come
 *    from the Codex `/models` catalog;
 *  - the provider itself declares `'priority'` — the explicit opt-in for
 *    third-party OpenAI Responses endpoints that honor service_tier.
 *
 * Fails closed: an undeclared endpoint never receives service_tier (a stale
 * alias copied from the official catalog to a third-party baseUrl is not a
 * declaration — opt in at the provider, not per model).
 */
export function isFastTierSupported(
  model: FastTierModelShape | undefined,
  provider: FastTierProviderShape | undefined,
): boolean {
  if (provider?.type !== 'openai_responses') return false;
  // Alias declaration wins; the provider's own declaration is the fallback
  // (same merge as provider-manager's ResolvedRuntimeProvider).
  const tiers = model?.serviceTiers ?? provider.serviceTiers;
  if (tiers?.includes(FAST_SERVICE_TIER_ID) !== true) return false;
  return (
    provider.baseUrl?.includes('chatgpt.com') === true ||
    provider.serviceTiers?.includes(FAST_SERVICE_TIER_ID) === true
  );
}

/**
 * Map the persisted config.toml value (`service_tier = "fast" | "default"`)
 * to the runtime tier. Only "fast" enables anything; "default" and an absent
 * key both resolve to `undefined` (default tier, request body untouched).
 */
export function serviceTierFromConfig(configTier: ServiceTierConfig | undefined): ServiceTier | undefined {
  return configTier === 'fast' ? 'priority' : undefined;
}

/**
 * Final link of the `ConfigState.provider` decoration chain. Fast mode is a
 * ChatGPT Codex (OpenAI Responses) feature: with `serviceTier === 'priority'`
 * the provider carries `service_tier: 'priority'` into every `/responses`
 * request via kosong's generation-kwargs passthrough — but only when the
 * current model passes {@link isFastTierSupported} (official Codex backend +
 * catalog-declared priority tier). Any other provider or model — or the tier
 * being off — is returned unchanged, so the field never appears in the
 * request body when fast mode does not apply.
 */
export function applyServiceTier(
  provider: ChatProvider,
  serviceTier: ServiceTier | undefined,
  model?: FastTierResolvedModelShape,
): ChatProvider {
  if (!(provider instanceof OpenAIResponsesChatProvider) || serviceTier !== FAST_SERVICE_TIER_ID) {
    return provider;
  }
  const baseUrl = provider.modelParameters['baseUrl'];
  const fastCapable = isFastTierSupported(model, {
    type: 'openai_responses',
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    serviceTiers: model?.providerServiceTiers,
  });
  if (!fastCapable) {
    return provider;
  }
  return provider.withGenerationKwargs({ service_tier: FAST_SERVICE_TIER_ID });
}
