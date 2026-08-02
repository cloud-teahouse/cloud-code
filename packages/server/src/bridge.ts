import {
  toCloudCodeErrorPayload,
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type CloudCodeCore,
  type QuestionRequest,
  type QuestionResult,
  type ToolCallRequest,
  type ToolCallResponse,
} from '@cloud-code/agent-core';
import {
  CLOUD_CODE_PROTOCOL_VERSION,
  INITIALIZE_METHOD,
  JSON_RPC_ERROR,
  RESYNC_REQUIRED_NOTIFICATION,
  initializeParamsSchema,
  type InitializeResult,
  type ResyncRequiredParams,
} from '@cloud-code/protocol';

import { JsonRpcConnection, JsonRpcError } from './jsonrpc/connection';
import type { JournalCursor } from './event-journal';
import type { ReverseRpcConnection, SdkMultiplexer } from './sdk-multiplexer';

/**
 * The forward CoreAPI surface exposed as JSON-RPC methods (1:1 mechanical
 * mapping — method name = CoreAPI method name, params = its payload). This
 * explicit whitelist is the protocol boundary: nothing else on `CloudCodeCore`
 * (overrides, internals) is reachable from the wire.
 */
export const CORE_API_METHODS = [
  // AgentAPI (WithAgentId)
  'prompt',
  'runShellCommand',
  'cancelShellCommand',
  'steer',
  'cancel',
  'undoHistory',
  'rewindFiles',
  'setThinking',
  'setPermission',
  'setModel',
  'getModel',
  'enterPlan',
  'cancelPlan',
  'clearPlan',
  'enterSwarm',
  'exitSwarm',
  'getSwarmMode',
  'enterCoordinator',
  'exitCoordinator',
  'getCoordinatorMode',
  'beginCompaction',
  'cancelCompaction',
  'registerTool',
  'unregisterTool',
  'setActiveTools',
  'stopBackground',
  'detachBackground',
  'clearContext',
  'importContext',
  'activateSkill',
  'activatePluginCommand',
  'startBtw',
  'createGoal',
  'getGoal',
  'pauseGoal',
  'resumeGoal',
  'cancelGoal',
  'getCronTasks',
  'getBackgroundOutput',
  'getContext',
  'getConfig',
  'getPermission',
  'getSandboxStatus',
  'getPlan',
  'getUsage',
  'getTools',
  'getBackground',
  // SessionAPI (WithSessionId)
  'renameSession',
  'updateSessionMetadata',
  'getSessionMetadata',
  'listSkills',
  'listOutputStyles',
  'setOutputStyle',
  'listPluginCommands',
  'listMcpServers',
  'getMcpStartupMetrics',
  'reconnectMcpServer',
  'generateAgentsMd',
  'getSessionWarnings',
  'waitForBackgroundTasksOnPrint',
  'handlePrintMainTurnCompleted',
  'addAdditionalDir',
  // CoreAPI
  'getCoreInfo',
  'getExperimentalFeatures',
  'getCloudCodeConfig',
  'getConfigDiagnostics',
  'setCloudCodeConfig',
  'removeCloudCodeProvider',
  'setCloudCodeSecondaryModel',
  'listGlobalMcpServers',
  'addGlobalMcpServer',
  'updateGlobalMcpServer',
  'removeGlobalMcpServer',
  'beginGlobalMcpServerAuth',
  'completeGlobalMcpServerAuth',
  'cancelGlobalMcpServerAuth',
  'resetGlobalMcpServerAuth',
  'testGlobalMcpServer',
  'createSession',
  'closeSession',
  'archiveSession',
  'deleteSession',
  'resumeSession',
  'reloadSession',
  'forkSession',
  'listSessions',
  'exportSession',
  'listWorkspaceSkills',
  'listPlugins',
  'installPlugin',
  'setPluginEnabled',
  'setPluginMcpServerEnabled',
  'removePlugin',
  'reloadPlugins',
  'getPluginInfo',
] as const;

export type CoreApiMethod = (typeof CORE_API_METHODS)[number];

/** Methods whose successful result claims the session for the calling connection. */
const SESSION_CLAIM_METHODS: ReadonlySet<string> = new Set([
  'createSession',
  'resumeSession',
  'reloadSession',
  'forkSession',
]);

/**
 * Methods that end a session. Their `sessionId` comes from the params (both
 * return void), and afterwards the multiplexer drops the session's ownership,
 * subscriptions and journal buffer — otherwise those grow for the lifetime of
 * the serve process.
 */
const SESSION_RELEASE_METHODS: ReadonlySet<string> = new Set(['closeSession', 'deleteSession']);

export type CoreDispatcher = (method: string, params: unknown) => Promise<unknown>;

/**
 * Build a dispatcher from a live `CloudCodeCore`, restricted to
 * {@link CORE_API_METHODS} and mapping thrown errors onto the wire error
 * shape: `CloudCodeErrorPayload` rides in `error.data`; the numeric code is
 * `-32602` for parameter-class failures, `-32000` for server-class ones.
 */
export function createCoreDispatcher(core: CloudCodeCore): CoreDispatcher {
  const host = core as unknown as Record<string, unknown>;
  const table = new Map<string, (payload: unknown) => unknown>();
  for (const name of CORE_API_METHODS) {
    const fn = host[name];
    if (typeof fn === 'function') {
      table.set(name, (fn as (payload: unknown) => unknown).bind(core));
    }
  }
  return async (method, params) => {
    const fn = table.get(method);
    if (fn === undefined) {
      throw new JsonRpcError({
        code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
        message: `Method not found: ${method}`,
      });
    }
    try {
      return await fn(params);
    } catch (error) {
      throw toWireError(error);
    }
  };
}

/** Map an arbitrary thrown value onto the JSON-RPC error object shape. */
export function toWireError(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcError) return error;
  const payload = toCloudCodeErrorPayload(error);
  return new JsonRpcError({
    code: isParamClassCode(payload.code) ? JSON_RPC_ERROR.INVALID_PARAMS : JSON_RPC_ERROR.SERVER_ERROR,
    message: payload.message,
    data: payload,
  });
}

/** Parameter-class business codes map to -32602; everything else to -32000. */
function isParamClassCode(code: string): boolean {
  return (
    code.startsWith('request.') ||
    code.endsWith('.invalid') ||
    code.endsWith('_invalid') ||
    code.endsWith('_empty') ||
    code.endsWith('_required')
  );
}

export interface BridgeConnectionOptions {
  readonly connection: JsonRpcConnection;
  readonly multiplexer: SdkMultiplexer;
  readonly dispatch: CoreDispatcher;
  readonly serverInfo: InitializeResult['serverInfo'];
  readonly homeDir: string;
  readonly onClose?: ((bridge: BridgeConnection) => void) | undefined;
}

interface PendingReverseCall {
  readonly resolve: (value: never) => void;
  readonly failClosed: unknown;
}

/**
 * One client connection bound to the shared core:
 *
 *  - forward: handshake gate, then dispatch to the CoreAPI whitelist; the
 *    session-creating methods claim the session for this connection;
 *  - reverse: hosts `requestApproval`/`requestQuestion`/`toolCall` toward the
 *    client and `event` notifications from it;
 *  - close: synthesizes fail-closed answers for every pending reverse call
 *    (approval→cancelled, question→null, toolCall→isError — aligned with the
 *    in-process "no handler" semantics) and best-effort cancels in-flight
 *    `runShellCommand`s.
 */
export class BridgeConnection implements ReverseRpcConnection {
  private initialized = false;
  private readonly pendingReverse = new Set<PendingReverseCall>();
  private readonly inFlightShellCommands = new Map<
    string,
    { sessionId: string; agentId: string; commandId: string }
  >();

  constructor(private readonly options: BridgeConnectionOptions) {
    this.connection.setRequestHandlerFallback((method, params) =>
      this.handleForward(method, params),
    );
    this.connection.onClose(() => this.handleClose());
  }

  get connection(): JsonRpcConnection {
    return this.options.connection;
  }

  get closed(): boolean {
    return this.connection.closed;
  }

  // ── ReverseRpcConnection (core → client) ────────────────────────────────

  sendEvent(event: Event, cursor?: JournalCursor): void {
    // The cursor rides as an envelope-level extra member so `params` stays a
    // pristine `Event` (volatile events never carry one — §6.2 / ws-control).
    this.connection.notify('event', event, cursor !== undefined ? { cursor } : undefined);
  }

  sendResyncRequired(params: ResyncRequiredParams): void {
    this.connection.notify(RESYNC_REQUIRED_NOTIFICATION, params);
  }

  requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    return this.reverseCall('requestApproval', request, {
      decision: 'cancelled',
      feedback: 'Client disconnected.',
    });
  }

  requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    return this.reverseCall('requestQuestion', request, null);
  }

  toolCall(
    request: ToolCallRequest & { sessionId: string; agentId: string },
  ): Promise<ToolCallResponse> {
    return this.reverseCall('toolCall', request, {
      output: 'Client disconnected.',
      isError: true,
    });
  }

  // ── Forward path (client → core) ────────────────────────────────────────

  private async handleForward(method: string, params: unknown): Promise<unknown> {
    if (method === INITIALIZE_METHOD) {
      return this.handleInitialize(params);
    }
    if (!this.initialized) {
      throw new JsonRpcError({
        code: JSON_RPC_ERROR.NOT_INITIALIZED,
        message: `Not initialized: send ${INITIALIZE_METHOD} before any other request`,
      });
    }
    if (method === 'runShellCommand') {
      this.trackShellCommand(params);
    }
    try {
      const result = await this.options.dispatch(method, params);
      if (SESSION_CLAIM_METHODS.has(method)) {
        const id = extractSessionId(result);
        if (id !== undefined) {
          this.options.multiplexer.claimSession(id, this);
        }
      }
      // Only on success: a rejected close leaves the session (and its
      // journal) alive.
      if (SESSION_RELEASE_METHODS.has(method)) {
        const id = extractSessionIdParam(params);
        if (id !== undefined) {
          this.options.multiplexer.forgetSession(id);
        }
      }
      return result;
    } finally {
      if (method === 'runShellCommand') {
        this.untrackShellCommand(params);
      }
    }
  }

  private handleInitialize(params: unknown): InitializeResult {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new JsonRpcError({
        code: JSON_RPC_ERROR.INVALID_PARAMS,
        message: `Invalid initialize params: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      });
    }
    const requestedVersion = parsed.data.protocolVersion ?? CLOUD_CODE_PROTOCOL_VERSION;
    if (requestedVersion !== CLOUD_CODE_PROTOCOL_VERSION) {
      throw new JsonRpcError({
        code: JSON_RPC_ERROR.INVALID_PARAMS,
        message: `Unsupported protocolVersion ${requestedVersion} (server speaks ${CLOUD_CODE_PROTOCOL_VERSION})`,
      });
    }
    this.initialized = true;
    const capabilities = parsed.data.capabilities;
    // Union of explicit subscriptions and cursor-bearing sessions: a
    // reconnecting client may send only `cursors` (v2 resume path).
    const sessionIds = new Set(capabilities?.sessionIds ?? []);
    for (const sessionId of Object.keys(capabilities?.cursors ?? {})) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of sessionIds) {
      this.options.multiplexer.subscribe(sessionId, this, capabilities?.cursors?.[sessionId]);
    }
    return {
      serverInfo: this.options.serverInfo,
      protocolVersion: CLOUD_CODE_PROTOCOL_VERSION,
      homeDir: this.options.homeDir,
    };
  }

  // ── Reverse path helpers ────────────────────────────────────────────────

  /**
   * Server→client request with fail-closed semantics: a client error or a
   * disconnect resolves with the synthetic value instead of rejecting, so a
   * dying client can never wedge a turn inside the core.
   */
  private reverseCall<T>(method: string, params: unknown, failClosed: T): Promise<T> {
    if (this.connection.closed) {
      return Promise.resolve(failClosed);
    }
    return new Promise<T>((resolve) => {
      const entry: PendingReverseCall = {
        resolve: resolve as (value: never) => void,
        failClosed,
      };
      this.pendingReverse.add(entry);
      this.connection.request<T>(method, params).then(
        (value) => {
          this.pendingReverse.delete(entry);
          resolve(value);
        },
        () => {
          this.pendingReverse.delete(entry);
          resolve(failClosed);
        },
      );
    });
  }

  private handleClose(): void {
    for (const entry of this.pendingReverse) {
      entry.resolve(entry.failClosed as never);
    }
    this.pendingReverse.clear();
    this.options.multiplexer.releaseConnection(this);
    for (const shell of this.inFlightShellCommands.values()) {
      void this.options
        .dispatch('cancelShellCommand', shell)
        .catch(() => undefined);
    }
    this.inFlightShellCommands.clear();
    this.options.onClose?.(this);
  }

  private trackShellCommand(params: unknown): void {
    const key = shellCommandKey(params);
    if (key !== undefined) {
      this.inFlightShellCommands.set(
        key,
        params as { sessionId: string; agentId: string; commandId: string },
      );
    }
  }

  private untrackShellCommand(params: unknown): void {
    const key = shellCommandKey(params);
    if (key !== undefined) {
      this.inFlightShellCommands.delete(key);
    }
  }
}

function shellCommandKey(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const commandId = record['commandId'];
  if (typeof sessionId !== 'string' || typeof commandId !== 'string') return undefined;
  return `${sessionId}${commandId}`;
}

function extractSessionId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const id = (result as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** `sessionId` out of a request's params (session-release methods return void). */
function extractSessionIdParam(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const id = (params as Record<string, unknown>)['sessionId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
