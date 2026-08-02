import { Writable } from 'node:stream';

import { log } from '@cloud-code/agent-core';

import { ServerHost, type ServerHostOptions } from './host';
import { createStdioConnection } from './transport/stdio';
import {
  WS_DEFAULT_HOST,
  generateWsToken,
  startWsTransport,
  type RunningWsTransport,
} from './transport/ws';

export interface CreateServerOptions extends ServerHostOptions {
  readonly transport: 'stdio' | 'ws';
  /** Test seams for stdio: defaults are `process.stdin` / `process.stdout`. */
  readonly input?: NodeJS.ReadableStream | undefined;
  readonly output?: NodeJS.WritableStream | undefined;
  /** ws only: bind address (default 127.0.0.1, design §2.3). */
  readonly host?: string | undefined;
  /** ws only: port to bind; 0 picks an ephemeral port. */
  readonly port?: number | undefined;
  /** ws only: bearer token; a random one is generated when omitted. */
  readonly token?: string | undefined;
}

export interface WsServerAddress {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly url: string;
}

export interface RunningServer {
  readonly host: ServerHost;
  /** Present on the ws transport: actual bound address + effective token. */
  readonly ws?: WsServerAddress | undefined;
  /** Resolves when the transport ends (stdin EOF) or `close()` is called. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Start a protocol server (design §2).
 *
 * stdio mode contract: stdout carries JSONL protocol frames ONLY. The startup
 * self-check below intercepts any foreign `process.stdout.write` and reroutes
 * it to stderr, so a stray `console.log` anywhere in the process can never
 * corrupt the frame stream (design §2.3 / §6.4).
 *
 * ws mode (v2): binds 127.0.0.1 by default, requires a bearer token, and
 * rejects Origin-carrying (browser) upgrade requests (design §2.3).
 */
export async function createServer(options: CreateServerOptions): Promise<RunningServer> {
  if (options.transport === 'ws') {
    return createWsServer(options);
  }
  if (options.transport !== 'stdio') {
    throw new Error(`Unsupported transport: ${String(options.transport)}`);
  }
  const host = new ServerHost(options);
  const useProtocolGuard = options.output === undefined;
  const output = useProtocolGuard
    ? installStdoutProtocolGuard()
    : (options.output as Writable);
  const connection = createStdioConnection({
    input: (options.input ?? process.stdin) as never,
    output,
    onProtocolError: (error) => {
      process.stderr.write(`[cloud-code serve] protocol error: ${error.message}\n`);
      log.warn('jsonrpc protocol error', { error: error.message });
    },
  });
  if (useProtocolGuard) {
    // The guard writes protocol frames straight to the real process.stdout,
    // so a dead reader turns into an async EPIPE 'error' on it — an
    // uncaughtException without a listener. Diagnose and close the
    // connection (which resolves `closed` and lets the process shut down)
    // instead of crashing.
    process.stdout.on('error', (error: Error) => {
      process.stderr.write(`[cloud-code serve] stdout write failed: ${error.message}\n`);
      log.warn('stdio output stream error', { error: error.message });
      connection.close(error);
    });
  }
  host.attach(connection);
  process.stderr.write('[cloud-code serve] stdio transport ready\n');

  const closed = new Promise<void>((resolve) => {
    connection.onClose(() => resolve());
  });
  let closePromise: Promise<void> | undefined;
  return {
    host,
    closed,
    close() {
      closePromise ??= (async () => {
        connection.close();
        await host.close();
        await closed;
      })();
      return closePromise;
    },
  };
}

/** ws transport: one host, many authenticated socket connections (§4 v2). */
async function createWsServer(options: CreateServerOptions): Promise<RunningServer> {
  const host = new ServerHost(options);
  const token = options.token ?? generateWsToken();
  const transport: RunningWsTransport = await startWsTransport({
    host: options.host ?? WS_DEFAULT_HOST,
    port: options.port ?? 0,
    token,
    onConnection: (connection) => {
      host.attach(connection);
    },
    onProtocolError: (error) => {
      process.stderr.write(`[cloud-code serve] protocol error: ${error.message}\n`);
      log.warn('jsonrpc protocol error', { error: error.message });
    },
  });
  const url = `ws://${transport.host}:${transport.port}`;
  process.stderr.write(`[cloud-code serve] ws transport ready on ${url}\n`);

  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  function close(): Promise<void> {
    closePromise ??= (async () => {
      await host.close();
      await transport.close();
      resolveClosed();
    })();
    return closePromise;
  }
  return {
    host,
    ws: { host: transport.host, port: transport.port, token, url },
    closed,
    close,
  };
}

/**
 * Startup self-check: after this runs, the only bytes that may reach stdout
 * are protocol frames written through the captured original `write` (which is
 * what the returned Writable uses). Anything else is rerouted to stderr.
 */
function installStdoutProtocolGuard(): Writable {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const transportOutput = new Writable({
    write(chunk, _encoding, callback) {
      // Propagate write failures (e.g. EPIPE once the client is gone): the
      // transport's own 'error' handling folds them into connection close.
      protocolWrite(chunk, (error) => callback(error));
    },
  });
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    process.stderr.write(`[cloud-code serve] intercepted non-protocol stdout write: ${text}`);
    const callback = args.find((arg) => typeof arg === 'function') as
      | ((error?: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  }) as typeof process.stdout.write;
  return transportOutput;
}

export { BridgeConnection, CORE_API_METHODS, createCoreDispatcher, toWireError } from './bridge';
export type { CoreDispatcher } from './bridge';
export { ServerHost } from './host';
export type { ServerHostOptions } from './host';
export { SdkMultiplexer } from './sdk-multiplexer';
export type { ReverseRpcConnection } from './sdk-multiplexer';
export {
  JsonRpcConnection,
  JsonRpcError,
  JsonRpcRemoteError,
} from './jsonrpc/connection';
export { JsonlFraming, encodeJsonlFrame } from './jsonrpc/framing';
export { MergingWriteQueue, tryMergeEventMessages } from './jsonrpc/write-queue';
export { createStdioConnection } from './transport/stdio';
export type { StdioConnectionOptions } from './transport/stdio';
export {
  WS_DEFAULT_HOST,
  WS_DEFAULT_HEARTBEAT_MS,
  createWsConnection,
  generateWsToken,
  startWsTransport,
} from './transport/ws';
export type {
  RunningWsTransport,
  WsConnectionOptions,
  WsTransportOptions,
} from './transport/ws';
export { EventJournal } from './event-journal';
export type { JournalCursor, JournalEntry, ReplayResult } from './event-journal';
