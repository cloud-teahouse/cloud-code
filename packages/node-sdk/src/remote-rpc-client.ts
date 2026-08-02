import { spawn, type ChildProcess } from 'node:child_process';

import {
  ErrorCodes,
  ensureConfigFile,
  fromCloudCodeErrorPayload,
  getRootLogger,
  CloudCodeError,
  resolveConfigPath,
  resolveCloudCodeHome,
  resolveLoggingConfig,
  type CoreAPI,
  type Event,
  type RPCMethods,
} from '@cloud-code/agent-core';
import type { Kaos } from '@cloud-code/kaos';
import { assertCloudCodeHostIdentity } from '@cloud-code/oauth';
import {
  CLOUD_CODE_PROTOCOL_VERSION,
  INITIALIZE_METHOD,
  INITIALIZED_NOTIFICATION,
  JSON_RPC_VERSION,
  type InitializeResult,
  type JsonRpcId,
} from '@cloud-code/protocol';
import WebSocket from 'ws';

import { CloudCodeAuthFacade } from '#/auth';
import type {
  CreateSessionOptions,
  CloudCodeHostIdentity,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  StdioServerTransport,
  WsServerTransport,
} from '#/types';

import type { SDKRpcClientOptions } from './sdk-rpc-client';
import { SDKRpcClientBase } from './rpc';

export interface RemoteRpcClientOptions extends SDKRpcClientOptions {
  readonly transport: StdioServerTransport | WsServerTransport;
}

const DEFAULT_SERVE_ARGS = ['serve', '--transport', 'stdio'] as const;

/**
 * `SDKRpcClientBase` over a JSON-RPC transport (design §3): the same CoreAPI
 * surface as `SDKRpcClient`, but every call is framed onto the wire and the
 * SDKAPI reverse methods (`emitEvent`/`requestApproval`/`requestQuestion`/
 * `toolCall`) are hosted on the connection and delegated to the base class —
 * its handler registries are untouched, so `CloudCodeHarness`/`Session`/TUI see no
 * difference.
 *
 * Transports: stdio spawn mode (v1) and ws attach mode (v2). The ws client
 * does not auto-reconnect: after a drop the harness fails fast, and recovery
 * is a fresh client + `resumeSession` snapshot (design §4 v2).
 */
export class RemoteRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: CloudCodeHostIdentity | undefined;
  readonly auth: CloudCodeAuthFacade;

  private readonly transport: StdioServerTransport | WsServerTransport;
  private readonly uiMode: string | undefined;
  private child: ChildProcess | undefined;
  private connection: BaseClientConnection | undefined;
  private ready: Promise<RPCMethods<CoreAPI>> | undefined;

  constructor(options: RemoteRpcClientOptions) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertCloudCodeHostIdentity(options.identity);
    this.homeDir = resolveCloudCodeHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.auth = new CloudCodeAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });
    // The client keeps its own diagnostic log file; the server child logs to
    // its own (serve mode never lets logs touch its stdout).
    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));
    this.transport = options.transport;
    this.uiMode = options.uiMode;
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  protected getRpc(): Promise<RPCMethods<CoreAPI>> {
    this.ready ??= this.start();
    return this.ready;
  }

  private async start(): Promise<RPCMethods<CoreAPI>> {
    const connection =
      this.transport.type === 'stdio' ? this.startStdio(this.transport) : await this.startWs(this.transport);
    this.connection = connection;
    connection.onReverseRequest = (method, params) => this.handleReverseRequest(method, params);
    connection.onEvent = (event) => this.receiveEvent(event);

    const result = (await withTimeout(
      connection.request(INITIALIZE_METHOD, {
        clientInfo: {
          name: this.identity?.userAgentProduct ?? 'cloud-code-sdk',
          version: this.identity?.version ?? '0.0.0',
        },
        capabilities: {},
        protocolVersion: CLOUD_CODE_PROTOCOL_VERSION,
      }),
      30_000,
      'Timed out waiting for cloud-code server handshake',
    )) as InitializeResult;
    if (result.protocolVersion !== CLOUD_CODE_PROTOCOL_VERSION) {
      throw new CloudCodeError(
        ErrorCodes.INTERNAL,
        `Server protocolVersion ${result.protocolVersion} is incompatible with client ${CLOUD_CODE_PROTOCOL_VERSION}`,
      );
    }
    connection.notify(INITIALIZED_NOTIFICATION);
    return createRemoteCoreProxy(connection);
  }

  /** stdio: spawn a `cloud-code serve` child and speak JSONL over its pipes. */
  private startStdio(transport: StdioServerTransport): BaseClientConnection {
    const command = transport.command ?? 'cloud-code';
    const args = [...(transport.args ?? DEFAULT_SERVE_ARGS)];
    if (this.uiMode !== undefined) {
      // Print-mode hosts need the child's core to apply print-mode config
      // defaults; the flag is forwarded so the spawned server matches what an
      // in-process core would have seen.
      args.push('--ui-mode', this.uiMode);
    }
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        CLOUD_CODE_HOME: this.homeDir,
        ...transport.env,
      },
    });
    this.child = child;
    const connection = new StdioClientConnection(child.stdin!, child.stdout!);
    child.on('error', (error) => {
      connection.close(
        new Error(
          `Failed to spawn cloud-code server ("${command}"): ${error.message}. ` +
            'Install cloud-code on PATH or pass an explicit transport command.',
        ),
      );
    });
    child.on('exit', () => connection.close());
    return connection;
  }

  /** ws (v2): attach to a running daemon with its bearer token (§2.3). */
  private async startWs(transport: WsServerTransport): Promise<BaseClientConnection> {
    return WsClientConnection.connect(transport.url, transport.token);
  }

  private handleReverseRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'requestApproval':
        return this.requestApproval(
          params as Parameters<SDKRpcClientBase['requestApproval']>[0],
        );
      case 'requestQuestion':
        return this.requestQuestion(
          params as Parameters<SDKRpcClientBase['requestQuestion']>[0],
        );
      case 'toolCall':
        return this.toolCall(params as Parameters<SDKRpcClientBase['toolCall']>[0]);
      default:
        throw new CloudCodeError(
          ErrorCodes.NOT_IMPLEMENTED,
          `Unsupported reverse method: ${method}`,
        );
    }
  }

  /** Remote Kaos injection is not meaningful across a process boundary. */
  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    void input;
    void kaos;
    void persistenceKaos;
    throw new CloudCodeError(
      ErrorCodes.NOT_IMPLEMENTED,
      'createSessionWithKaos is not supported on a remote transport.',
    );
  }

  /** Remote Kaos injection is not meaningful across a process boundary. */
  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    void input;
    void kaos;
    void persistenceKaos;
    throw new CloudCodeError(
      ErrorCodes.NOT_IMPLEMENTED,
      'resumeSessionWithKaos is not supported on a remote transport.',
    );
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null && !child.killed) {
      child.kill();
      const exited = await waitForExit(child, 2_000);
      if (!exited && child.exitCode === null) {
        // SIGTERM was ignored (a core wedged in a synchronous section never
        // runs its handler). Escalate so close() cannot leave an orphan
        // serve process behind; the short second wait lets the OS reap it.
        child.kill('SIGKILL');
        await waitForExit(child, 1_000);
      }
    }
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }
}

/** CoreAPI proxy: every method call becomes a JSON-RPC request (1:1 mapping). */
function createRemoteCoreProxy(connection: BaseClientConnection): RPCMethods<CoreAPI> {
  // Memoized so repeated property access does not allocate a fresh closure.
  const dispatchers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return new Proxy({} as RPCMethods<CoreAPI>, {
    get(_target, method: string | symbol) {
      // 'then' must stay undefined: promise resolution (the base class does
      // `await this.getRpc()`) probes for a thenable, and a trap that turns
      // every key into an RPC call would send a `then` request on the wire.
      if (typeof method !== 'string' || method === 'then') return undefined;
      let dispatcher = dispatchers.get(method);
      if (dispatcher === undefined) {
        dispatcher = (payload: unknown) => connection.request(method, payload);
        dispatchers.set(method, dispatcher);
      }
      return dispatcher;
    },
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Client side of the JSON-RPC connection: sends forward requests, hosts the
 * reverse SDKAPI methods and the `event` notification. Self-contained in the
 * SDK so protocol clients do not depend on `@cloud-code/server`.
 *
 * Transport-agnostic core; subclasses own framing and the wire.
 */
abstract class BaseClientConnection {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private closedError: Error | undefined;

  onReverseRequest: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  onEvent: ((event: Event) => void) | undefined;

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closedError !== undefined) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(String(id), {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.writeMessage({ jsonrpc: JSON_RPC_VERSION, id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError !== undefined) return;
    this.writeMessage({ jsonrpc: JSON_RPC_VERSION, method, params });
  }

  close(error?: Error): void {
    if (this.closedError !== undefined) return;
    this.closedError = error ?? new Error('Connection to cloud-code server closed');
    for (const pending of this.pending.values()) {
      pending.reject(this.closedError);
    }
    this.pending.clear();
    this.closeTransport();
  }

  /** Serialize and send one outgoing message. */
  protected abstract writeMessage(message: unknown): void;
  /** Close the underlying transport (idempotent). */
  protected abstract closeTransport(): void;

  /** Route one decoded inbound message. */
  protected handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if ('id' in record && ('result' in record || 'error' in record)) {
      this.handleResponse(record);
      return;
    }
    if (typeof record['method'] !== 'string') return;
    if ('id' in record) {
      void this.handleReverseRequest(record);
      return;
    }
    if (record['method'] === 'event') {
      this.onEvent?.(record['params'] as Event);
    }
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record['id'] as JsonRpcId;
    if (id === null) return;
    const pending = this.pending.get(String(id));
    if (pending === undefined) return;
    this.pending.delete(String(id));
    const error = record['error'];
    if (typeof error === 'object' && error !== null) {
      const data = (error as Record<string, unknown>)['data'];
      const message = (error as Record<string, unknown>)['message'];
      pending.reject(restoreWireError(data, message));
      return;
    }
    pending.resolve(record['result']);
  }

  private async handleReverseRequest(record: Record<string, unknown>): Promise<void> {
    const id = record['id'] as JsonRpcId;
    const method = record['method'] as string;
    try {
      if (this.onReverseRequest === undefined) {
        throw new CloudCodeError(ErrorCodes.NOT_IMPLEMENTED, `No reverse handler for ${method}`);
      }
      const result = await this.onReverseRequest(method, record['params']);
      this.writeMessage({ jsonrpc: JSON_RPC_VERSION, id, result: result ?? null });
    } catch (error) {
      this.writeMessage({
        jsonrpc: JSON_RPC_VERSION,
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

/** stdio transport: newline-delimited JSON over the child process pipes. */
class StdioClientConnection extends BaseClientConnection {
  private buffer = '';

  constructor(
    private readonly input: NodeJS.WritableStream,
    output: NodeJS.ReadableStream,
  ) {
    super();
    output.on('data', (chunk: Buffer | string) => {
      this.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    output.on('end', () => this.close());
    output.on('error', () => this.close(new Error('server stdout stream error')));
  }

  protected writeMessage(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  protected closeTransport(): void {
    // The child is terminated by RemoteRpcClient.close(); ending stdin here
    // would race protocol responses already in flight.
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    // Scan with a cursor and slice the remainder once per exit path; slicing
    // per line copies the remaining buffer once per line under bursts.
    let pos = 0;
    for (;;) {
      const newline = this.buffer.indexOf('\n', pos);
      if (newline === -1) break;
      let line = this.buffer.slice(pos, newline);
      pos = newline + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.buffer = this.buffer.slice(pos);
        this.close(new Error('Malformed JSON frame from cloud-code server'));
        return;
      }
      this.handleMessage(message);
      if (this.closed) {
        this.buffer = this.buffer.slice(pos);
        return;
      }
    }
    this.buffer = this.buffer.slice(pos);
  }
}

/**
 * ws transport (v2): one JSON-RPC message per WebSocket frame. The bearer
 * token rides the `Authorization` header on the upgrade request (§2.3).
 */
class WsClientConnection extends BaseClientConnection {
  private constructor(private readonly socket: WebSocket) {
    super();
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.close(new Error('Binary ws message from cloud-code server'));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        this.close(new Error('Malformed JSON frame from cloud-code server'));
        return;
      }
      this.handleMessage(message);
    });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close(new Error('ws transport error')));
  }

  /** Dial and wait for the upgrade; auth failures surface the HTTP status. */
  static connect(url: string, token: string): Promise<WsClientConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      socket.once('open', () => {
        socket.removeAllListeners('unexpected-response');
        socket.removeAllListeners('error');
        resolve(new WsClientConnection(socket));
      });
      socket.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0;
        reject(
          new Error(
            `cloud-code server rejected the ws upgrade (HTTP ${status})${
              status === 401 ? ': bad or missing bearer token' : ''
            }`,
          ),
        );
      });
      socket.once('error', (error) => {
        reject(
          new Error(`Failed to connect to cloud-code server at ${url}: ${error.message}`),
        );
      });
    });
  }

  protected writeMessage(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  protected closeTransport(): void {
    this.socket.close();
  }
}

/**
 * Rehydrate a wire error: `error.data` carrying a CloudCodeErrorPayload becomes a
 * real `CloudCodeError` again (TUI `isCloudCodeError` handling is transport-agnostic).
 */
function restoreWireError(data: unknown, fallbackMessage: unknown): Error {
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (typeof record['code'] === 'string' && typeof record['message'] === 'string') {
      try {
        return fromCloudCodeErrorPayload(data as Parameters<typeof fromCloudCodeErrorPayload>[0]);
      } catch {
        // fall through to the generic error below
      }
    }
  }
  return new Error(typeof fallbackMessage === 'string' ? fallbackMessage : 'Remote call failed');
}

/** Resolve true when `child` exits within `timeoutMs`, false on timeout. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(exited);
    };
    const timer = setTimeout(() => {
      settle(false);
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      settle(true);
    });
  });
}
