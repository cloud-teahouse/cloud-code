import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { JsonRpcConnection } from '../jsonrpc/connection';
import { MergingWriteQueue } from '../jsonrpc/write-queue';

/** Default bind address: loopback only (design §2.3). */
export const WS_DEFAULT_HOST = '127.0.0.1';

/** Default liveness probe cadence; a socket that misses one pong is culled. */
export const WS_DEFAULT_HEARTBEAT_MS = 30_000;

/** Generate a bearer token for `serve --transport ws` (design §2.3). */
export function generateWsToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface WsConnectionOptions {
  /** Malformed inbound messages land here instead of throwing. */
  readonly onProtocolError?: ((error: Error) => void) | undefined;
  /** Called once when the socket closes/errors or the connection is closed. */
  readonly onClose?: (() => void) | undefined;
}

/**
 * One JSON-RPC connection over an established WebSocket.
 *
 * A ws message is already a frame, so outbound messages are plain
 * `JSON.stringify` (no JSONL delimiter). They still go through a
 * {@link MergingWriteQueue}: the sink resolves on the socket's send
 * callback, so socket backpressure applies and same-turn volatile deltas
 * coalesce exactly like on stdio (design §6.2).
 */
export function createWsConnection(
  socket: WebSocket,
  options: WsConnectionOptions = {},
): JsonRpcConnection {
  const queue = new MergingWriteQueue(
    (frame) => sendFrame(socket, frame),
    (error) => options.onProtocolError?.(error),
    (message) => JSON.stringify(message),
  );
  const connection = new JsonRpcConnection(queue);

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      options.onProtocolError?.(new Error('binary ws messages are not supported'));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      options.onProtocolError?.(new Error('malformed JSON ws message'));
      return;
    }
    connection.handleMessage(message);
  });
  socket.on('close', () => connection.close());
  socket.on('error', (error: Error) => connection.close(error));
  connection.onClose(() => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    options.onClose?.();
  });
  return connection;
}

/** Write a frame, resolving when the socket has flushed it (backpressure-safe). */
function sendFrame(socket: WebSocket, frame: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('ws socket is not open'));
      return;
    }
    // ws@8 invokes the send callback with `null` (not undefined) on success —
    // treat both as success or every flush would look like a failure and the
    // write queue would drop frames queued behind it.
    socket.send(frame, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export interface WsTransportOptions {
  /** Bind address. Defaults to {@link WS_DEFAULT_HOST} (loopback only). */
  readonly host?: string | undefined;
  /** Port to bind; 0 picks an ephemeral port (see `RunningWsTransport.port`). */
  readonly port: number;
  /** Bearer token required on the upgrade request. */
  readonly token: string;
  /** Called with each authenticated, upgraded connection. */
  readonly onConnection: (connection: JsonRpcConnection) => void;
  readonly onProtocolError?: ((error: Error) => void) | undefined;
  /** Liveness probe cadence; 0 disables it. Defaults to 30s (design §6.1). */
  readonly heartbeatIntervalMs?: number | undefined;
}

export interface RunningWsTransport {
  readonly host: string;
  /** Actual bound port (resolved when `port: 0` was requested). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * v2 transport: WebSocket with local-daemon auth hardening (design §2.3):
 *
 *  - binds to 127.0.0.1 by default;
 *  - upgrade requires `Authorization: Bearer <token>` (timing-safe compare);
 *  - upgrade requests carrying an `Origin` header are rejected outright
 *    (browser protection — a web page must never reach the local daemon);
 *  - `GET /healthz` answers 200 without auth; all other plain HTTP is 404;
 *  - protocol-level ping/pong culls dead sockets, which the bridge treats
 *    like any other disconnect (fail-closed reverse calls, design §6.1).
 */
export function startWsTransport(options: WsTransportOptions): Promise<RunningWsTransport> {
  const host = options.host ?? WS_DEFAULT_HOST;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const heartbeatMs = options.heartbeatIntervalMs ?? WS_DEFAULT_HEARTBEAT_MS;

  const httpServer = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      // Liveness probe: deliberately unauthenticated (design §2.3).
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  // Liveness state: ping every cadence; a socket that missed the previous
  // ping is terminated (its bridge then applies disconnect semantics).
  const alive = new WeakMap<WebSocket, boolean>();

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rejection = checkUpgradeAuth(request, options.token);
    if (rejection !== undefined) {
      socket.write(
        `HTTP/1.1 ${rejection.status} ${rejection.message}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('close', () => sockets.delete(ws));
      options.onConnection(
        createWsConnection(ws, { onProtocolError: options.onProtocolError }),
      );
    });
  });

  const timer =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const socket of sockets) {
            if (alive.get(socket) === false) {
              socket.terminate();
              continue;
            }
            alive.set(socket, false);
            socket.ping();
          }
        }, heartbeatMs)
      : undefined;
  timer?.unref();

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(options.port, host, () => {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind ws transport'));
        return;
      }
      resolve({
        host,
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            if (timer !== undefined) clearInterval(timer);
            for (const socket of sockets) {
              socket.terminate();
            }
            wss.close(() => {
              httpServer.close(() => resolveClose());
            });
          }),
      });
    });
  });
}

interface AuthRejection {
  readonly status: number;
  readonly message: string;
}

/** Upgrade gate: Origin-header rejection, then Bearer token (design §2.3). */
function checkUpgradeAuth(request: IncomingMessage, expectedToken: string): AuthRejection | undefined {
  if (request.headers['origin'] !== undefined) {
    return { status: 403, message: 'Forbidden' };
  }
  const header = request.headers['authorization'];
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  const presented = match?.[1]?.trim();
  if (presented === undefined || !tokenMatches(presented, expectedToken)) {
    return { status: 401, message: 'Unauthorized' };
  }
  return undefined;
}

/** Timing-safe token compare (same pattern as apps/vis/server). */
function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
