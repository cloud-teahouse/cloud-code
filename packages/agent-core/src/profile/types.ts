import type { Environment } from '@cloud-code/kaos';
import { z } from 'zod';

import type { SkillRegistry } from '../agent/skill/types';

export const RawSubagentProfileSchema = z.object({
  description: z.string().optional(),
});

export type RawSubagentProfile = z.infer<typeof RawSubagentProfileSchema>;

/**
 * Symbolic model preference a profile declares for subagent spawning: the
 * `Agent` / `AgentSwarm` tools use it as the default for their `model`
 * parameter when the call does not pass one explicitly.
 */
export const AgentModelPreferenceSchema = z.enum(['primary', 'secondary']);

export type AgentModelPreference = z.infer<typeof AgentModelPreferenceSchema>;

export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPromptPath: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  // Exact builtin/user tool names, plus optional MCP glob patterns
  // (`mcp__*`, `mcp__github__*`) that gate which MCP tools the profile sees.
  tools: z.array(z.string()).optional(),
  // Optional model alias overriding the parent agent's model at spawn time.
  model: z.string().optional(),
  whenToUse: z.string().optional(),
  // Omit the merged AGENTS.md content from the rendered system prompt.
  // Read-only subagents (explore/plan) don't need commit/PR/lint conventions —
  // the main agent holds the full context and interprets their results.
  omitAgentsMd: z.boolean().optional(),
  subagents: z.record(z.string(), RawSubagentProfileSchema).optional(),
  modelPreference: AgentModelPreferenceSchema.optional(),
});

export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;

/**
 * Runtime context supplied to a system prompt renderer.
 *
 * Captures everything determined at render time rather than at profile-load
 * time: the OS/shell, working directory, AGENTS.md instructions, available
 * skills, and so on. Loaders return renderers; callers invoke them with
 * the live context whenever a concrete prompt is needed.
 */
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  /**
   * Rendered `MEMORY.md` indexes from the project and user memory dirs
   * (`memory/memory.ts`). Undefined when no memory dir exists — the template
   * then elides the whole `# Memory` section with zero prompt delta.
   */
  readonly memory?: string;
  readonly skills?: SkillRegistry | string;
  readonly pluginSections?: string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
  /** Git status snapshot (main loop); omitted outside git repositories. */
  readonly gitStatus?: string;
  /**
   * Explicit UI language chosen by the user (e.g. '简体中文'), injected by
   * the interactive host. Undefined means "no explicit preference" — the
   * `# Language` section then keeps its infer-from-message behaviour.
   */
  readonly userLanguage?: string;
  /** Aggregated instructions advertised by connected MCP servers. */
  readonly mcpInstructions?: string;
}

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  model?: string;
  /**
   * Denylist with the same matching rules as `tools` (exact builtin/user
   * names plus `mcp__…` glob patterns), applied on top of the `tools`
   * allowlist when the profile takes effect.
   */
  disallowedTools?: string[];
  whenToUse?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
  modelPreference?: AgentModelPreference;
}
