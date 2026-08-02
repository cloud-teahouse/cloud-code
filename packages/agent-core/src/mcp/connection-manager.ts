import { ErrorCodes, CloudCodeError } from '#/errors';
import { MAX_MCP_TIMEOUT_MS, type McpServerConfig } from '#/config/schema';
import { log as defaultLog } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { Tool } from '@cloud-code/kosong';

import { abortable } from '../utils/abort';
import type { McpAuthCache } from './auth-cache';
import { HttpMcpClient } from './client-http';
import { isRemoteMcpConfig } from './client-remote';
import { SseMcpClient } from './client-sse';
import type { UnexpectedCloseReason } from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpOAuthService } from './oauth';
import { assertMcpInputSchema, truncateMcpDescription, type MCPClient, type MCPToolDefinition } from './types';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

export interface McpServerEntry {
  readonly name: string;
  readonly transport: McpServerConfig['transport'];
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

/**
 * The instructions a connected server advertised in its `initialize`
 * response, paired with the server name for prompt rendering.
 */
export interface McpServerInstructions {
  readonly name: string;
  readonly instructions: string;
}

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  attemptId: number;
  status: McpServerStatus;
  tools?: readonly Tool[];
  /** Verbatim `tools/list` result the converted {@link tools} came from. */
  rawTools?: readonly MCPToolDefinition[];
  enabledNames?: ReadonlySet<string>;
  /** Server instructions from the `initialize` handshake, when advertised. */
  instructions?: string;
  error?: string;
  client?: RuntimeMcpClient;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export const MCP_STARTUP_TIMEOUT_ENV = 'CLOUD_CODE_MCP_STARTUP_TIMEOUT_MS';
export const MCP_TOOL_TIMEOUT_ENV = 'CLOUD_CODE_MCP_TOOL_TIMEOUT_MS';

/** Parse an env override; anything but an integer from 1 to MAX_MCP_TIMEOUT_MS is ignored. */
function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MCP_TIMEOUT_MS
    ? parsed
    : undefined;
}

/**
 * Resolve the global default MCP server startup (connect + tool discovery)
 * timeout. Precedence: `CLOUD_CODE_MCP_STARTUP_TIMEOUT_MS` (integer ms) →
 * `configMs` (`[mcp] startup_timeout_ms`) → `undefined` (the manager's
 * built-in default applies). A per-server `startupTimeoutMs` in `mcp.json`
 * always wins over the resolved value.
 */
export function resolveMcpStartupTimeoutMs(configMs?: number): number | undefined {
  const raw = process.env[MCP_STARTUP_TIMEOUT_ENV];
  if (raw !== undefined) {
    const parsed = parseTimeoutMsEnv(raw);
    if (parsed !== undefined) return parsed;
  }
  return configMs;
}

/**
 * Resolve the global default single MCP tool-call timeout. Precedence:
 * `CLOUD_CODE_MCP_TOOL_TIMEOUT_MS` (integer ms) → `configMs`
 * (`[mcp] tool_timeout_ms`) → `undefined` (the client built-in default
 * applies). A per-server `toolTimeoutMs` in `mcp.json` always wins over the
 * resolved value.
 */
export function resolveMcpToolTimeoutMs(configMs?: number): number | undefined {
  const raw = process.env[MCP_TOOL_TIMEOUT_ENV];
  if (raw !== undefined) {
    const parsed = parseTimeoutMsEnv(raw);
    if (parsed !== undefined) return parsed;
  }
  return configMs;
}

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  readonly stdioCwd?: string;
  /**
   * Optional OAuth orchestrator. When provided, remote servers without a
   * static bearer token participate in the OAuth-via-synthetic-tool flow:
   *  - If `oauthService.hasTokens(name, url)` is true, the provider is
   *    attached to the transport so the SDK can refresh tokens on 401.
   *  - Connection failures that look like 401 / `UnauthorizedError` flip
   *    the entry into `needs-auth` instead of `failed`; `/mcp-config`
   *    drives the browser flow through the synthetic auth tool.
   */
  readonly oauthService?: McpOAuthService;
  /**
   * Parent logger. Defaults to the global `log`; Session passes its own
   * `session.log` so MCP events land in the session log too.
   */
  readonly log?: Logger;
  /**
   * Global default startup (connect + tool discovery) timeout applied when a
   * server entry does not set its own `startupTimeoutMs`. Falls back to the
   * built-in default when unset.
   */
  readonly defaultStartupTimeoutMs?: number;
  /**
   * Global default single tool-call timeout applied when a server entry does
   * not set its own `toolTimeoutMs`. Falls back to the client built-in when
   * unset.
   */
  readonly defaultToolTimeoutMs?: number;
  /**
   * Needs-auth TTL cache. When present, automatic connection
   * attempts (`connectAll` / `connect`) to an OAuth-candidate server whose
   * last auth failure is younger than the TTL short-circuit to `needs-auth`
   * without touching the network — an expired token must not turn every
   * session start / config reload into a refresh storm. Explicit
   * `reconnect()` (the `/mcp-config login` flow) bypasses the cache; a
   * successful connect clears the entry. Absent → no caching (one-shot
   * connectivity-test managers must always hit the network).
   */
  readonly authCache?: McpAuthCache;
}

/**
 * Owns the lifecycle of every configured MCP server for a Session.
 *
 * Servers are connected in parallel; per-server failures are isolated so a
 * crashed or misconfigured entry never blocks Session startup. State
 * transitions are surfaced through {@link onStatusChange} so callers (the
 * Session) can react — registering tools onto the main agent, emitting
 * wire events, or updating the TUI.
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private initialLoad: Promise<void> = Promise.resolve();

  /**
   * OAuth orchestrator injected at construction time. Consumed by the
   * {@link ToolManager} `needs-auth` branch to build the synthetic
   * `authenticate` tool.
   */
  readonly oauthService: McpOAuthService | undefined;
  private readonly log: Logger;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
    this.log = options.log ?? defaultLog;
  }

  /**
   * Returns the URL of a remote MCP server by name, or `undefined` for
   * unknown / non-remote / disabled entries. Used by the synthetic auth tool
   * to drive OAuth discovery against the right base URL.
   */
  getRemoteServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (!isRemoteMcpConfig(entry.config)) return undefined;
    return entry.config.url;
  }

  /**
   * @deprecated Use {@link getRemoteServerUrl}. Kept for in-repo callers that
   * were written before legacy SSE support shared the same OAuth path.
   */
  getHttpServerUrl(name: string): string | undefined {
    return this.getRemoteServerUrl(name);
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly McpServerEntry[] {
    return Array.from(this.entries.values(), toPublicEntry);
  }

  get(name: string): McpServerEntry | undefined {
    const entry = this.entries.get(name);
    return entry !== undefined ? toPublicEntry(entry) : undefined;
  }

  /**
   * Returns the MCP client, the discovered tools, and the allow-list of tool
   * names for a given connected server, or `undefined` if the server is not
   * currently connected. The allow-list combines the server's `enabledTools`
   * and `disabledTools` filters; callers should only register names in the
   * set.
   */
  resolved(
    name: string,
  ):
    | {
        client: MCPClient;
        tools: readonly Tool[];
        rawTools: readonly MCPToolDefinition[];
        enabledNames: ReadonlySet<string>;
      }
    | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
      entry.tools === undefined ||
      entry.rawTools === undefined ||
      entry.client === undefined
    ) {
      return undefined;
    }
    return {
      client: entry.client,
      tools: entry.tools,
      rawTools: entry.rawTools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.name)),
    };
  }

  /**
   * Instructions advertised by every currently connected server, in
   * configuration order. Used to render the system prompt's
   * `# MCP Server Instructions` section; changes to this set are what make
   * a system-prompt refresh worthwhile after a (re)connect.
   */
  serverInstructions(): readonly McpServerInstructions[] {
    const result: McpServerInstructions[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== 'connected') continue;
      const instructions = entry.instructions;
      if (instructions === undefined || instructions.trim().length === 0) continue;
      result.push({ name: entry.name, instructions });
    }
    return result;
  }

  connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const initialLoad = this.connectAllNow(configs);
    this.initialLoad = initialLoad;
    return initialLoad;
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    const previous = this.entries.get(name);
    if (previous !== undefined) {
      await this.closeClient(previous);
    }
    const disabled = config.enabled === false;
    const entry: InternalEntry = {
      name,
      config,
      attemptId: 0,
      status: disabled ? 'disabled' : 'pending',
    };
    this.entries.set(name, entry);
    this.emit(entry);
    if (!disabled) {
      if (await this.shortCircuitNeedsAuth(entry)) return;
      await this.connectOne(entry, this.beginConnectAttempt(entry));
    }
  }

  async remove(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    await this.closeClient(entry);
    entry.status = 'disabled';
    entry.tools = undefined;
    entry.rawTools = undefined;
    entry.enabledNames = undefined;
    entry.instructions = undefined;
    entry.error = undefined;
    this.emit(entry);
    this.entries.delete(name);
    return true;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (signal === undefined) return this.initialLoad;
    return abortable(this.initialLoad, signal);
  }

  private async connectAllNow(configs: Record<string, McpServerConfig>): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, config] of Object.entries(configs)) {
      const disabled = config.enabled === false;
      const entry: InternalEntry = {
        name,
        config,
        attemptId: 0,
        status: disabled ? 'disabled' : 'pending',
      };
      this.entries.set(name, entry);
      this.emit(entry);
      if (!disabled) {
        tasks.push(
          (async () => {
            if (await this.shortCircuitNeedsAuth(entry)) return;
            await this.connectOne(entry, this.beginConnectAttempt(entry));
          })(),
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new CloudCodeError(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new CloudCodeError(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.rawTools = undefined;
    entry.enabledNames = undefined;
    entry.instructions = undefined;
    entry.error = undefined;
    this.emit(entry);
    await this.connectOne(entry, attemptId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs =
      entry.config.startupTimeoutMs ??
      this.options.defaultStartupTimeoutMs ??
      DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = this.createClient(entry.config, entry.name, timeoutMs);
      client = startupClient;
      entry.client = startupClient;
      const discovered = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          // Best-effort cleanup if the startup promise is still racing.
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = discovered.tools;
      entry.rawTools = discovered.rawTools;
      entry.enabledNames = computeEnabledNames(entry.config, discovered.tools);
      entry.instructions = discovered.instructions;
      entry.status = 'connected';
      // A successful connect proves the tokens are good again — drop any
      // cached auth failure so a later expiry re-evaluates fresh.
      void this.options.authCache?.clear(entry.name);
      this.watchForUnexpectedClose(entry, startupClient, attemptId);
    } catch (error) {
      if (!this.isCurrent(entry, attemptId)) {
        if (client !== undefined) {
          await this.closeRuntimeClient(client);
        }
        return;
      }
      if (this.shouldMarkNeedsAuth(entry, error)) {
        entry.status = 'needs-auth';
        entry.error = needsAuthMessage(entry.name);
        // Cache the failure: for the TTL, automatic connection attempts
        // short-circuit instead of stampeding the token endpoint.
        void this.options.authCache?.mark(entry.name);
      } else {
        entry.status = 'failed';
        entry.error = formatStartupError(error, client);
      }
      entry.tools = undefined;
      entry.rawTools = undefined;
      entry.enabledNames = undefined;
      entry.instructions = undefined;
      // Drop the client reference so a later reconnect builds a fresh one.
      await this.closeClient(entry);
    }
    if (!this.isCurrent(entry, attemptId)) return;
    this.emit(entry);
  }

  private watchForUnexpectedClose(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onUnexpectedClose((reason) => {
      // The client may have outlived its entry (shutdown / reconnect already
      // moved on). Drop the event if so — the new attempt owns the state.
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.rawTools = undefined;
      entry.enabledNames = undefined;
      entry.instructions = undefined;
      entry.client = undefined;
      // Best-effort close; the transport is already gone, but this lets the
      // SDK release timers and pending request handlers.
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private createClient(
    config: McpServerConfig,
    name: string,
    startupTimeoutMs: number,
  ): RuntimeMcpClient {
    const toolCallTimeoutMs = config.toolTimeoutMs ?? this.options.defaultToolTimeoutMs;
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        defaultCwd: this.options.stdioCwd,
      });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: this.resolveOAuthProvider(config, name),
      });
    }
    return new HttpMcpClient(config, {
      startupTimeoutMs,
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: this.resolveOAuthProvider(config, name),
    });
  }

  private resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): ReturnType<McpOAuthService['getProvider']> | undefined {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (!isRemoteMcpConfig(config)) return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    // Only attach the provider once tokens have been minted; before that,
    // the transport should propagate a clean 401 so we can flip the entry
    // into `needs-auth` rather than getting tangled in the SDK's auth()
    // flow (which would try DCR before we have an active redirect URL).
    if (!oauthService.hasTokens(name, config.url)) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    return this.isOAuthCandidate(entry.config) && isUnauthorizedLikeError(error);
  }

  /**
   * Whether the server participates in the OAuth-via-synthetic-tool flow at
   * all: an OAuth-capable remote config without static credentials. Static
   * tokens and pinned headers keep their (more actionable) raw errors.
   */
  private isOAuthCandidate(config: McpServerConfig): boolean {
    if (this.oauthService === undefined) return false;
    if (!isRemoteMcpConfig(config)) return false;
    if (config.bearerTokenEnvVar !== undefined) return false;
    // If the user pinned a static `headers` block, treat 401s as a bad header
    // rather than hijacking them into the OAuth flow — the real error is more
    // actionable than "run /mcp-config login" for a server that doesn't speak
    // OAuth.
    if (config.headers !== undefined && config.auth !== 'oauth') return false;
    return true;
  }

  /**
   * Anti-avalanche short-circuit: an OAuth-candidate server
   * whose last auth failure is still inside the cache TTL flips straight to
   * `needs-auth` without a network attempt. Returns true when the entry was
   * short-circuited. Only automatic paths (`connectAll` / `connect`) consult
   * the cache — explicit `reconnect()` always retries for real.
   */
  private async shortCircuitNeedsAuth(entry: InternalEntry): Promise<boolean> {
    const cache = this.options.authCache;
    if (cache === undefined) return false;
    if (!this.isOAuthCandidate(entry.config)) return false;
    if (!(await cache.isFresh(entry.name))) return false;
    entry.status = 'needs-auth';
    entry.error = needsAuthMessage(entry.name);
    this.emit(entry);
    return true;
  }

  private async connectAndDiscoverTools(
    client: RuntimeMcpClient,
  ): Promise<{ tools: Tool[]; rawTools: MCPToolDefinition[]; instructions?: string }> {
    await client.connect();
    const mcpTools = await client.listTools();
    return {
      rawTools: mcpTools,
      tools: mcpTools.map((mcpTool) => ({
        name: mcpTool.name,
        // Cap at registration (rawTools stay verbatim for the discovery
        // record): OpenAPI-derived servers dump 15-60KB of docs into a single
        // description, which would otherwise flood the context window.
        description: truncateMcpDescription(mcpTool.description),
        parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
      })),
      // Captured once at handshake time; immutable for this connection.
      // Instructions go into the system prompt verbatim, so they get the
      // same context-protection cap as tool descriptions.
      instructions: mapUndefined(client.getInstructions(), truncateMcpDescription),
    };
  }

  private async closeClient(entry: InternalEntry): Promise<void> {
    if (entry.client === undefined) return;
    const client = entry.client;
    entry.client = undefined;
    await this.closeRuntimeClient(client);
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // Suppress close errors — the server is going away regardless and we
      // don't want them masking the original startup failure.
    }
  }

  private isCurrent(entry: InternalEntry, attemptId: number): boolean {
    return this.entries.get(entry.name) === entry && entry.attemptId === attemptId;
  }

  private emit(entry: InternalEntry): void {
    const view = toPublicEntry(entry);
    if (view.status === 'failed' || view.status === 'needs-auth') {
      this.log.error('mcp server unavailable', {
        server: view.name,
        transport: view.transport,
        status: view.status,
        reason: view.error,
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Listener faults must not break the connection manager.
      }
    }
  }
}

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount:
      entry.status === 'connected' && entry.enabledNames !== undefined
        ? entry.enabledNames.size
        : 0,
    error: entry.error,
  };
}

function computeEnabledNames(config: McpServerConfig, tools: readonly Tool[]): Set<string> {
  const all = tools.map((t) => t.name);
  const enabledFilter =
    config.enabledTools !== undefined ? new Set(config.enabledTools) : undefined;
  const disabledFilter =
    config.disabledTools !== undefined ? new Set(config.disabledTools) : undefined;
  const allowed = new Set<string>();
  for (const name of all) {
    if (enabledFilter !== undefined && !enabledFilter.has(name)) continue;
    if (disabledFilter !== undefined && disabledFilter.has(name)) continue;
    allowed.add(name);
  }
  return allowed;
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  // SDK transport errors typically expose the HTTP status as `.code`.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  // Fall back to a message sniff so server-specific error shapes still flip
  // us into needs-auth instead of failed.
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function needsAuthMessage(serverName: string): string {
  return `${serverName} requires OAuth — run /mcp-config login ${serverName}`;
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const base = error instanceof Error ? error.message : String(error);
  const tail = stderrTail(client);
  if (tail === undefined) return base;
  return `${base}\nstderr: ${tail}`;
}

function formatUnexpectedCloseError(name: string, reason: UnexpectedCloseReason): string {
  const parts = [`MCP server "${name}" closed unexpectedly`];
  if (reason.error !== undefined) {
    parts.push(reason.error.message);
  }
  if (reason.stderr !== undefined && reason.stderr.length > 0) {
    parts.push(`stderr: ${reason.stderr.trimEnd()}`);
  }
  return parts.join('\n');
}

function stderrTail(client: RuntimeMcpClient | undefined): string | undefined {
  if (client === undefined) return undefined;
  if (!(client instanceof StdioMcpClient)) return undefined;
  const snapshot = client.stderrSnapshot();
  if (snapshot.length === 0) return undefined;
  return snapshot.trimEnd();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mapUndefined<T, U>(value: T | undefined, fn: (value: T) => U): U | undefined {
  return value === undefined ? undefined : fn(value);
}
