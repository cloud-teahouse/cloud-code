import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { McpServerConfig } from '../config/schema';
import type { AgentFileRoot } from '../profile/agentfile/types';
import { discoverSkills, type SkillRoot } from '../skill';
import type { HookDef } from '../session/hooks';
import { inlinePluginCommand, loadPluginCommand } from './commands';
import { downloadZip, extractZip } from './archive';
import {
  resolveGithubRefSha,
  resolveGithubSource,
  type GithubSourceResolution,
} from './github-resolver';
import { parseManifest, type ParsedManifestResult } from './manifest';
import {
  findProjectRoot,
  isPluginEnabledInScope,
  readProjectPluginOverrides,
  writeProjectPluginOverride,
  type PluginEnableScope,
} from './project-scope';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import { resolveInstallSource } from './source';
import {
  type EnabledPluginSessionStart,
  type EnabledPluginSystemPrompt,
  type PluginAgentDir,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginOutputStyleDir,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type PluginUpdateResult,
  type ReloadSummary,
  normalizePluginId,
} from './types';

// Hidden Kimi CLI subcommand that re-enters as a Node interpreter.
// Used as fallback when an MCP server declares `"command": "node"` but the
// user is running a single-binary Kimi build that doesn't have `node` on PATH.
const KIMI_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

export interface PluginManagerOptions {
  readonly cloudCodeHomeDir: string;
}

export class PluginManager {
  private readonly cloudCodeHomeDir: string;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.cloudCodeHomeDir = options.cloudCodeHomeDir;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.cloudCodeHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async install(source: string): Promise<PluginRecord> {
    const resolved = resolveInstallSource(source);

    if (resolved.kind !== 'local-path') {
      let zipUrl: string;
      let github: PluginGithubMetadata | undefined;
      if (resolved.kind === 'github') {
        const githubResolution = await resolveGithubSource(resolved);
        zipUrl = githubResolution.tarballUrl;
        github = {
          owner: resolved.owner,
          repo: resolved.repo,
          ref: githubResolution.ref,
          // A sha-pinned install already knows its content identity — record
          // it so a later update() can no-op without a download. Other ref
          // kinds stay undefined: resolving them costs an api.github.com call
          // we deliberately avoid on the install hot path (see
          // github-resolver.ts); update() treats an undefined baseline as
          // "unknown → re-materialize once and record".
          ...(githubResolution.ref.kind === 'sha'
            ? { installedSha: githubResolution.ref.value }
            : {}),
        };
      } else {
        zipUrl = resolved.path;
      }
      return this.installZipPlugin({
        zipUrl,
        originalSource: source.trim(),
        sourceType: resolved.kind === 'github' ? 'github' : 'zip-url',
        github,
      });
    }

    const sourceRoot = await normalizeInstallRoot(resolved.path);
    const originalSource = resolved.path;
    let parsed = await parseManifest(sourceRoot);
    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${sourceRoot}: ${msg}`);
    }
    const id = normalizePluginId(parsed.manifest.name);
    const normalizedRoot = await copyPluginToManagedRoot(this.cloudCodeHomeDir, id, sourceRoot);
    parsed = await parseManifest(normalizedRoot);
    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${normalizedRoot}: ${msg}`);
    }
    const existing = this.records.get(id);
    const now = new Date().toISOString();
    const record = await recordFrom({
      id,
      root: normalizedRoot,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      originalSource,
      source: 'local-path',
      capabilities: existing?.capabilities,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  /**
   * Shared zip-backed install path (github / zip-url installs, plugin
   * update): download → extract to a staging tmpdir → parse+validate → copy
   * over the managed root → re-parse → record. With `forcedId` set (update),
   * the staged plugin must declare the same manifest name — a rename mid-
   * update would silently fork the install into a second managed root, so it
   * is rejected before anything is overwritten.
   */
  private async installZipPlugin(input: {
    readonly zipUrl: string;
    readonly originalSource: string;
    readonly sourceType: 'github' | 'zip-url';
    readonly github?: PluginGithubMetadata;
    readonly forcedId?: string;
  }): Promise<PluginRecord> {
    const buffer = await downloadZip(input.zipUrl);
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'cloud-code-plugin-zip-'));
    let parsed: ParsedManifestResult;
    let normalizedRoot: string;
    try {
      const detectedRoot = await extractZip(buffer, tmpDir);
      parsed = await parseManifest(detectedRoot);
      if (parsed.manifest === undefined) {
        const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error(`Cannot install plugin from ${input.originalSource}: ${msg}`);
      }
      const manifestId = normalizePluginId(parsed.manifest.name);
      if (input.forcedId !== undefined && manifestId !== input.forcedId) {
        throw new Error(
          `Cannot update plugin "${input.forcedId}": the new version declares a different ` +
            `name ("${parsed.manifest.name}"). Remove the plugin and install it again instead.`,
        );
      }
      const id = input.forcedId ?? manifestId;
      normalizedRoot = await copyPluginToManagedRoot(this.cloudCodeHomeDir, id, detectedRoot);
      parsed = await parseManifest(normalizedRoot);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${normalizedRoot}: ${msg}`);
    }
    const id = input.forcedId ?? normalizePluginId(parsed.manifest.name);
    const existing = this.records.get(id);
    const now = new Date().toISOString();
    const record = await recordFrom({
      id,
      root: normalizedRoot,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      originalSource: input.originalSource,
      source: input.sourceType,
      capabilities: existing?.capabilities,
      github: input.github,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  /**
   * Update a GitHub-sourced plugin: re-resolve its ref (a bare-URL install
   * re-runs the latest-release lookup, so updates track upstream releases),
   * compare the resolved commit sha against the recorded `installedSha`, and
   * re-materialize the managed root when they differ. Preserves the enabled
   * flag, per-server capability state, and the original install timestamp
   * (the shared zip path keeps all three). A missing `installedSha` baseline
   * (every install that did not pin a sha) re-materializes once and records
   * the sha for subsequent no-op comparisons.
   */
  async update(id: string): Promise<PluginUpdateResult> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    const github = current.github;
    if (current.source !== 'github' || github === undefined) {
      throw new Error(
        `Plugin "${key}" was not installed from GitHub; only GitHub plugins can be updated`,
      );
    }

    // Re-resolve from the original source string when we have it (its
    // ref-shape carries the user's original intent: bare URL → latest release
    // again). Records written before originalSource was persisted — or whose
    // source string no longer parses as GitHub — fall back to the recorded ref.
    let resolution: GithubSourceResolution | undefined;
    if (current.originalSource !== undefined) {
      const resolved = resolveInstallSource(current.originalSource);
      if (resolved.kind === 'github') {
        resolution = await resolveGithubSource(resolved);
      }
    }
    resolution ??= await resolveGithubSource({
      kind: 'github',
      owner: github.owner,
      repo: github.repo,
      ref: github.ref,
    });
    const sha = await resolveGithubRefSha(github.owner, github.repo, resolution.ref);
    const previousSha = github.installedSha;
    if (previousSha === sha) {
      return { id: key, updated: false, previousSha, sha, ref: resolution.ref, record: current };
    }

    const record = await this.installZipPlugin({
      zipUrl: resolution.tarballUrl,
      originalSource:
        current.originalSource ?? `https://github.com/${github.owner}/${github.repo}`,
      sourceType: 'github',
      github: { owner: github.owner, repo: github.repo, ref: resolution.ref, installedSha: sha },
      forcedId: key,
    });
    return { id: key, updated: true, previousSha, sha, ref: resolution.ref, record };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.enabled === enabled) return;
    const now = new Date().toISOString();
    this.records.set(key, { ...current, enabled, updatedAt: now });
    await this.persist();
  }

  /**
   * Set a project-scope enable override (`<projectRoot>/.cloud-code/plugins.json`).
   * The project root is resolved from `workDir` by walking up to the nearest
   * `.git` (falling back to `workDir`). Overrides win over the install-level
   * flag for sessions in that project; `enabled === undefined` clears the
   * override so the project inherits the user-level flag again.
   */
  async setProjectEnabled(
    id: string,
    enabled: boolean | undefined,
    workDir: string,
  ): Promise<void> {
    const key = normalizePluginId(id);
    if (this.records.get(key) === undefined) throw new Error(`Plugin "${id}" is not installed`);
    const projectRoot = await findProjectRoot(workDir);
    await writeProjectPluginOverride(projectRoot, key, enabled);
  }

  /**
   * Resolve the enable scope for a session workDir: the project root (when
   * inside a repository) plus any project-level overrides. Component queries
   * take the result as an optional argument; without one they apply the
   * user-level (install) flag only.
   */
  async resolveEnableScope(workDir?: string): Promise<PluginEnableScope> {
    if (workDir === undefined) return {};
    const projectRoot = await findProjectRoot(workDir);
    const overrides = await readProjectPluginOverrides(projectRoot);
    return overrides.size === 0 ? { projectRoot } : { projectRoot, overrides };
  }

  /** Effective enabled state of a record under an optional scope. */
  isEnabled(id: string, scope?: PluginEnableScope): boolean {
    const record = this.records.get(normalizePluginId(id));
    if (record === undefined) return false;
    return isPluginEnabledInScope(record.enabled, record.id, scope);
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error(`Plugin "${id}" does not declare MCP server "${server}"`);
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    this.records.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    if (!this.records.delete(key)) {
      throw new Error(`Plugin "${id}" is not installed`);
    }
    await this.persist();
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.cloudCodeHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  pluginSkillRoots(scope?: PluginEnableScope): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: 'extra',
          plugin: { id: record.id, instructions: record.skillInstructions },
        });
      }
    }
    return roots;
  }

  /**
   * Agent-definition directories of every enabled plugin, fed into
   * `loadCustomAgentProfiles` as the third (plugin) source. Same gating as
   * `pluginSkillRoots`: disabled or errored plugins contribute nothing.
   */
  pluginAgentDirs(scope?: PluginEnableScope): readonly PluginAgentDir[] {
    const dirs: PluginAgentDir[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const dir of record.manifest?.agents ?? []) {
        dirs.push({ pluginId: record.id, path: dir });
      }
    }
    return dirs;
  }

  /**
   * Output-style directories of every enabled plugin, fed into
   * `loadOutputStyles` as a source below user/project dirs in precedence.
   * Same gating as `pluginAgentDirs`: disabled or errored plugins contribute
   * nothing.
   */
  pluginOutputStyleDirs(scope?: PluginEnableScope): readonly PluginOutputStyleDir[] {
    const dirs: PluginOutputStyleDir[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const dir of record.manifest?.outputStyles ?? []) {
        dirs.push({ pluginId: record.id, path: dir });
      }
    }
    return dirs;
  }

  /**
   * Agent-file roots contributed by enabled plugins (the `plugin` source of
   * the agentfile catalog). Same gating as `pluginAgentDirs`.
   */
  pluginAgentRoots(scope?: PluginEnableScope): readonly AgentFileRoot[] {
    const roots: AgentFileRoot[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const dir of record.manifest?.agents ?? []) {
        roots.push({ path: dir, source: 'plugin' });
      }
    }
    return roots;
  }

  enabledSessionStarts(scope?: PluginEnableScope): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      const skill = record.manifest.sessionStart?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  /**
   * System-prompt contributions of every enabled plugin (the manifest
   * `systemPrompt` field). Same gating as `enabledSessionStarts`.
   */
  enabledSystemPrompts(scope?: PluginEnableScope): readonly EnabledPluginSystemPrompt[] {
    const out: EnabledPluginSystemPrompt[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      const content = record.manifest?.systemPrompt;
      if (content === undefined) continue;
      out.push({ pluginId: record.id, content });
    }
    return out;
  }

  enabledMcpServers(scope?: PluginEnableScope): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          withMcpServerEnabled(config, true),
          record,
          this.cloudCodeHomeDir,
        );
      }
    }
    return out;
  }

  enabledHooks(scope?: PluginEnableScope): readonly HookDef[] {
    const out: HookDef[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const hook of record.manifest.hooks ?? []) {
        out.push({
          ...hook,
          cwd: record.root,
          env: pluginRuntimeEnv(record, this.cloudCodeHomeDir),
        });
      }
    }
    return out;
  }

  async enabledCommands(scope?: PluginEnableScope): Promise<readonly PluginCommandDef[]> {
    const out: PluginCommandDef[] = [];
    for (const record of this.records.values()) {
      if (!this.enabledInScope(record, scope)) continue;
      for (const entry of record.manifest.commands ?? []) {
        if (entry.content !== undefined) {
          // Claude Code object-mapping `content` form: the markdown body is
          // inline in the manifest, so there is no file to load.
          out.push(
            inlinePluginCommand({
              pluginId: record.id,
              name: entry.name,
              content: entry.content,
              description: entry.description,
              path: entry.path ?? record.root,
            }),
          );
          continue;
        }
        if (entry.path === undefined) continue;
        const def = await loadPluginCommand({
          commandPath: entry.path,
          pluginId: record.id,
          fallbackName: entry.name,
        });
        if (def !== undefined) {
          out.push(entry.description !== undefined ? { ...def, description: entry.description } : def);
        }
      }
    }
    return out;
  }

  private enabledInScope(
    record: PluginRecord,
    scope?: PluginEnableScope,
  ): record is PluginRecord & { readonly manifest: NonNullable<PluginRecord['manifest']> } {
    if (record.state !== 'ok' || record.manifest === undefined) return false;
    return isPluginEnabledInScope(record.enabled, record.id, scope);
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(): Promise<void> {
    const installed: InstalledRecord[] = [...this.records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      originalSource: record.originalSource,
      capabilities: record.capabilities,
      github: record.github,
    }));
    await writeInstalled(this.cloudCodeHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      source: entry.source,
      parsed,
    });
  }
}

async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${rootPath}")`);
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error(`Plugin root does not exist: ${trimmed}`, { cause: error });
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${trimmed}`);
  }
  return resolved;
}

async function copyPluginToManagedRoot(
  cloudCodeHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<string> {
  const managedRoot = path.join(cloudCodeHomeDir, 'plugins', 'managed', id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    await rm(managedRoot, { recursive: true, force: true });
    await rename(stagingRoot, managedRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return realpath(managedRoot);
}

async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  source?: PluginSource;
  parsed: ParsedManifestResult;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    skillCount: await countDiscoveredPluginSkills(input.id, parsed.manifest),
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.skillCount,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hookCount: record.manifest?.hooks?.length ?? 0,
    commandCount: record.manifest?.commands?.length ?? 0,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
  };
}

async function countDiscoveredPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
): Promise<number> {
  const roots = (manifest?.skills ?? []).map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
  }) satisfies SkillRoot);
  if (roots.length === 0) return 0;
  const skills = await discoverSkills({ roots });
  return skills.length;
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    mcpServers: pluginMcpServersInfo(record),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

function isMcpServerEnabled(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginRecord): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): PluginMcpServerInfo {
  if (config.transport === 'http' || config.transport === 'sse') {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: config.transport,
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: 'stdio',
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys: config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

function withMcpServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  return { ...config, enabled };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  // Plugin ids cannot contain ":", so this keeps plugin/server pairs unambiguous
  // even when either side contains "-".
  return `plugin-${pluginId}:${serverName}`;
}

/**
 * Runtime env for plugin-provided hook processes and stdio MCP servers.
 * `KIMI_PLUGIN_ROOT` is the native contract; `CLAUDE_PLUGIN_ROOT` /
 * `CLAUDE_PLUGIN_DATA` keep Claude Code format plugins working unmodified
 * (their `${CLAUDE_PLUGIN_ROOT}` references are also substituted at parse
 * time — the env var covers runtime self-expansion).
 */
function pluginRuntimeEnv(
  record: PluginRecord,
  cloudCodeHomeDir: string,
): Record<string, string> {
  return {
    CLOUD_CODE_HOME: cloudCodeHomeDir,
    KIMI_PLUGIN_ROOT: record.root,
    CLAUDE_PLUGIN_ROOT: record.root,
    CLAUDE_PLUGIN_DATA: path.join(cloudCodeHomeDir, 'plugins', 'data', record.id),
  };
}

function withPluginMcpRuntime(
  config: McpServerConfig,
  record: PluginRecord,
  cloudCodeHomeDir: string,
): McpServerConfig {
  if (config.transport === 'http' || config.transport === 'sse') return config;

  const env = {
    ...config.env,
    ...pluginRuntimeEnv(record, cloudCodeHomeDir),
  };

  if (config.command === 'node' && isCloudCodeNativeBinary()) {
    return {
      ...config,
      command: process.execPath,
      args: [KIMI_NODE_FALLBACK_SUBCOMMAND, ...(config.args ?? [])],
      cwd: config.cwd ?? record.root,
      env,
    };
  }

  return { ...config, cwd: config.cwd ?? record.root, env };
}

function isCloudCodeNativeBinary(): boolean {
  return !path.basename(process.execPath).toLowerCase().startsWith('node');
}
