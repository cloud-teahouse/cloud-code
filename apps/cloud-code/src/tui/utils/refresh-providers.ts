import {
  refreshProviderModels,
  type ProviderChange,
  type RefreshProviderOptions,
  type RefreshProviderScope,
  type RefreshResult,
} from '@cloud-code/oauth';
import type { CloudCodeConfig, CloudCodeConfigPatch, OAuthRef } from '@cloud-code/sdk';

/**
 * CLI-side host for provider-model refresh. Kept on the SDK's full config types
 * so existing TUI callers (and tests) don't change; the daemon uses the oauth
 * package's `ManagedKimiConfigShape`-typed host directly.
 */
export interface RefreshProviderHost {
  getConfig(): Promise<CloudCodeConfig>;
  removeProvider(providerId: string): Promise<CloudCodeConfig>;
  setConfig(patch: CloudCodeConfigPatch): Promise<CloudCodeConfig>;
  resolveOAuthToken(providerName: string, oauthRef?: OAuthRef): Promise<string>;
  /**
   * Optional per-request headers an OAuth provider needs alongside the
   * bearer token (e.g. `ChatGPT-Account-ID` for `managed:chatgpt-codex`).
   */
  resolveOAuthHeaders?(
    providerName: string,
    oauthRef?: OAuthRef,
  ): Promise<Record<string, string> | undefined>;
  /** Product User-Agent sent on custom-registry (api.json) fetches. */
  readonly userAgent?: string;
}

export type { ProviderChange, RefreshProviderOptions, RefreshProviderScope, RefreshResult };

/**
 * Refresh remote model metadata for the configured providers. Thin adapter over
 * the shared `refreshProviderModels` orchestrator in `@cloud-code/oauth`
 * (which is also what the daemon's scheduled/manual refresh uses).
 */
export async function refreshAllProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  return refreshProviderModels(
    {
      getConfig: () => host.getConfig(),
      removeProvider: (providerId) => host.removeProvider(providerId),
      setConfig: (patch) => host.setConfig(patch as unknown as CloudCodeConfigPatch),
      resolveOAuthToken: (providerName, oauthRef) =>
        host.resolveOAuthToken(providerName, oauthRef as unknown as OAuthRef),
      resolveOAuthHeaders: async (providerName, oauthRef) =>
        host.resolveOAuthHeaders?.(providerName, oauthRef as unknown as OAuthRef),
      userAgent: host.userAgent,
    },
    options,
  );
}
