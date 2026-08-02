import type { HookDefConfig, McpServerConfig } from '../config/schema';

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginSessionStart {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly websiteURL?: string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[]; // resolved absolute paths
  readonly agents?: readonly string[]; // resolved absolute paths (agent .md dirs)
  readonly outputStyles?: readonly string[]; // resolved absolute paths (style .md dirs)
  readonly sessionStart?: PluginSessionStart;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly hooks?: readonly HookDefConfig[];
  readonly commands?: readonly PluginCommandEntry[];
  readonly interface?: PluginInterface;
  readonly skillInstructions?: string;
  readonly systemPrompt?: string;
}

/**
 * One plugin-provided directory of file-based agent definitions
 * (`agents/*.md`). Flows into `loadCustomAgentProfiles` as the third source
 * after user-level and project-level dirs; agent names are namespaced as
 * `pluginId:agentName` so they can never shadow builtin or user profiles.
 */
export interface PluginAgentDir {
  readonly pluginId: string;
  readonly path: string;
}

/**
 * One plugin-provided directory of output-style definitions
 * (`outputStyles/*.md`). Flows into `loadOutputStyles` as a source below
 * user/project dirs in precedence; styles keep the plugin id for attribution.
 */
export interface PluginOutputStyleDir {
  readonly pluginId: string;
  readonly path: string;
}

export interface PluginMcpServerState {
  readonly enabled: boolean;
}

export interface PluginCapabilityState {
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerState>>;
}

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface PluginCommandDef {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path: string;
}

/**
 * A resolved command file plus its namespace-preserving name.
 *
 * `name` is the path of the file relative to the declared `commands` entry
 * (without the `.md` extension, using `/` separators), so a file at
 * `commands/frontend/component.md` yields the name `frontend/component`.
 * Frontmatter `name` in the file itself takes precedence over this at load time.
 *
 * Claude Code format plugins may also declare commands via the object-mapping
 * form (`commands: { "about": { "source" | "content", ... } }`): `source`
 * entries set `path` with the mapping key as `name`; `content` entries carry
 * the markdown body inline and have no `path`.
 */
export interface PluginCommandEntry {
  readonly path?: string;
  readonly name: string;
  /** Inline markdown body (Claude Code object-mapping `content` form). */
  readonly content?: string;
  /** Manifest-level description override (Claude Code object-mapping metadata). */
  readonly description?: string;
}

export type PluginManifestKind = 'kimi-plugin-root' | 'kimi-plugin-dir' | 'claude-plugin';
export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginState = 'ok' | 'error';

export interface PluginGithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadata {
  readonly owner: string;
  readonly repo: string;
  readonly ref: PluginGithubRef;
  readonly installedSha?: string;
}

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
  readonly skillInstructions?: string;
  readonly skillCount: number;
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hookCount: number;
  readonly commandCount: number;
  readonly hasErrors: boolean;
  readonly source: PluginSource;
  readonly originalSource?: string;
  readonly github?: PluginGithubMetadata;
}

export interface PluginInfo extends PluginSummary {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledPluginSessionStart {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface EnabledPluginSystemPrompt {
  readonly pluginId: string;
  readonly content: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

/** Outcome of `PluginManager.update()`. */
export interface PluginUpdateResult {
  readonly id: string;
  /** False when the resolved commit sha equals the recorded `installedSha`. */
  readonly updated: boolean;
  readonly previousSha?: string;
  readonly sha: string;
  /** The ref the update resolved to (may differ from the installed ref). */
  readonly ref: PluginGithubRef;
  readonly record: PluginRecord;
}

export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}
