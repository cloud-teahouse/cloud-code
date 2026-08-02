import type { ModelCapability, ProviderConfig } from '@cloud-code/kosong';

/**
 * Runtime service tier requested from the provider. `'priority'` is the wire
 * value sent as `service_tier: 'priority'` on OpenAI Responses requests;
 * `undefined` means the default tier (the field is omitted from the request
 * body entirely). The persisted config.toml form is `service_tier =
 * "fast" | "default"` — see `ServiceTierConfig` in config/schema.
 */
export type ServiceTier = 'priority';

export interface AgentConfigData {
  cwd: string;
  provider?: ProviderConfig;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  subagentNames?: readonly string[];
  thinkingEffort: string;
  systemPrompt: string;
  serviceTier?: ServiceTier | undefined;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  subagentNames: readonly string[];
  thinkingEffort: string;
  systemPrompt: string;
  /** `null` explicitly clears the tier (JSON/record-safe "off"). */
  serviceTier: ServiceTier | null;
}>;
