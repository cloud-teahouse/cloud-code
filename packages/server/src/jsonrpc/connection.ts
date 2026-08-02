import {
  JSON_RPC_ERROR,
  JSON_RPC_VERSION,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  type JsonRpcErrorObject,
  type JsonRpcId,
} from '@cloud-code/protocol';

/**
 * Error with an explicit JSON-RPC error object. Throw this from a request
 * handler to control the wire error; anything else maps to INTERNAL_ERROR.
 */
export class JsonRpcError extends Error {
  constructor(
    readonly errorObject: JsonRpcErrorObject,
  ) {
    super(errorObject.message);
    this.name = 'JsonRpcError';
  }

  get code(): number {
    return this.errorObject.code;
  }

  get data(): unknown {
    return this.errorObject.data;
  }
}

/** Error thrown on the caller side when the peer responds with `error`. */
export class JsonRpcRemoteError extends Error {
  constructor(
    readonly errorObject: JsonRpcErrorObject,
  ) {
    super(errorObject.message);
    this.name = 'JsonRpcRemoteError';
  }

  get code(): number {
    return this.errorObject.code;
  }

  get data(): unknown {
    return this.errorObject.data;
  }
}

export interface JsonRpcWriter {
  write(message: unknown): void;
}

type RequestHandler = (params: unknown) => unknown;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Transport-agnostic bidirectional JSON-RPC 2.0 connection.
 *
 * Symmetric: both peers can `request`/`notify`; inbound requests are routed
 * through `onRequest` handlers (with a dynamic-dispatch fallback), inbound
 * notifications through `onNotification`. Responses are correlated by id.
 *
 * Closing the connection rejects every pending outbound request.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly closeListeners = new Set<() => void>();
  private fallbackRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  private closedWith: Error | undefined;

  constructor(private readonly writer: JsonRpcWriter) {}

  get closed(): boolean {
    return this.closedWith !== undefined;
  }

  /** Send a request and await its response. Rejects once the connection closes. */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closedWith !== undefined) {
      return Promise.reject(this.closedWith);
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.writer.write({ jsonrpc: JSON_RPC_VERSION, id, method, params });
      } catch (error) {
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Send a fire-and-forget notification. Dropped silently once closed. */
  notify(method: string, params?: unknown, extra?: Record<string, unknown>): void {
    if (this.closedWith !== undefined) return;
    this.writer.write({ jsonrpc: JSON_RPC_VERSION, method, params, ...extra });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Dynamic-dispatch fallback for methods without a registered handler. */
  setRequestHandlerFallback(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.fallbackRequestHandler = handler;
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Route one decoded frame. Malformed frames are answered/dropped per spec. */
  handleMessage(raw: unknown): void {
    if (this.closedWith !== undefined) return;
    if (isRecord(raw) && 'id' in raw && ('result' in raw || 'error' in raw)) {
      this.handleResponse(raw);
      return;
    }
    if (isRecord(raw) && 'method' in raw) {
      if ('id' in raw) {
        void this.handleRequest(raw);
      } else {
        this.handleNotification(raw);
      }
      return;
    }
    // Not a request, notification, or response: nothing to correlate to.
    // The transport-level framer already reported JSON parse errors; a
    // well-formed but shapeless message is simply ignored.
  }

  /** Close locally or because the transport ended. Idempotent. */
  close(error?: Error): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = error ?? new Error('JSON-RPC connection closed');
    for (const pending of this.pending.values()) {
      pending.reject(this.closedWith);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      listener();
    }
    this.closeListeners.clear();
  }

  private handleResponse(raw: Record<string, unknown>): void {
    const parsed = jsonRpcResponseSchema.safeParse(raw);
    if (!parsed.success) return;
    const response = parsed.data;
    if (response.id === null) return;
    const pending = this.pending.get(String(response.id));
    if (pending === undefined) return;
    this.pending.delete(String(response.id));
    if (response.error !== undefined) {
      pending.reject(new JsonRpcRemoteError(response.error));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleRequest(raw: Record<string, unknown>): Promise<void> {
    const parsed = jsonRpcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const id = extractId(raw);
      if (id !== undefined) {
        this.writeResponse({
          jsonrpc: JSON_RPC_VERSION,
          id,
          error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: 'Invalid JSON-RPC request' },
        });
      }
      return;
    }
    const request = parsed.data;
    const handler =
      this.requestHandlers.get(request.method) ??
      (this.fallbackRequestHandler !== undefined
        ? (params: unknown) => this.fallbackRequestHandler!(request.method, params)
        : undefined);
    if (handler === undefined) {
      this.writeResponse({
        jsonrpc: JSON_RPC_VERSION,
        id: request.id,
        error: {
          code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(request.params);
      this.writeResponse({
        jsonrpc: JSON_RPC_VERSION,
        id: request.id,
        // JSON has no `undefined`: void methods go on the wire as null.
        result: result === undefined ? null : result,
      });
    } catch (error) {
      const errorObject =
        error instanceof JsonRpcError
          ? error.errorObject
          : {
              code: JSON_RPC_ERROR.INTERNAL_ERROR,
              message: error instanceof Error ? error.message : String(error),
            };
      this.writeResponse({ jsonrpc: JSON_RPC_VERSION, id: request.id, error: errorObject });
    }
  }

  /**
   * Response write with the same protection `request()` gives its own write:
   * `handleRequest` runs as a floating promise (`void this.handleRequest`),
   * so a writer that throws synchronously would otherwise surface as an
   * unhandled rejection. The production `MergingWriteQueue` never throws, but
   * this class is exported for arbitrary writers.
   */
  private writeResponse(message: unknown): void {
    try {
      this.writer.write(message);
    } catch {
      // A dead writer means the peer is gone; there is nobody to answer.
    }
  }

  private handleNotification(raw: Record<string, unknown>): void {
    const method = raw['method'];
    if (typeof method !== 'string') return;
    const handlers = this.notificationHandlers.get(method);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      try {
        handler(raw['params']);
      } catch {
        // A broken notification listener must not take down the connection.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractId(raw: Record<string, unknown>): JsonRpcId | undefined {
  const id = raw['id'];
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return undefined;
}
