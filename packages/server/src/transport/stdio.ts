import type { Readable, Writable } from 'node:stream';

import { JsonRpcConnection } from '../jsonrpc/connection';
import { JsonlFraming } from '../jsonrpc/framing';
import { MergingWriteQueue } from '../jsonrpc/write-queue';

export interface StdioConnectionOptions {
  /** Incoming byte stream (server: child/parent stdin; client: child stdout). */
  readonly input: Readable;
  /** Outgoing byte stream. Writes are awaited, so stream backpressure applies. */
  readonly output: Writable;
  /** Malformed inbound frames land here instead of throwing. */
  readonly onProtocolError?: ((error: Error) => void) | undefined;
  /** Called once when the input ends/errors or the connection is closed. */
  readonly onClose?: (() => void) | undefined;
}

/**
 * v1 transport: newline-delimited JSON over stdio pipes.
 *
 * Outbound frames go through a {@link MergingWriteQueue} so high-frequency
 * volatile deltas coalesce under backpressure (design §6.2).
 */
export function createStdioConnection(options: StdioConnectionOptions): JsonRpcConnection {
  const queue = new MergingWriteQueue(
    (frame) => writeToStream(options.output, frame),
    (error) => options.onProtocolError?.(error),
  );
  const connection = new JsonRpcConnection(queue);
  const framing = new JsonlFraming(
    (message) => connection.handleMessage(message),
    (error) => options.onProtocolError?.(error),
  );

  options.input.on('data', (chunk: Buffer | string) => {
    framing.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  options.input.on('end', () => {
    framing.end();
    connection.close();
  });
  options.input.on('error', () => {
    connection.close(new Error('stdio input stream error'));
  });
  // A dead reader (client exit/crash) surfaces as an async 'error' event
  // (EPIPE) on the output stream — without a listener Node turns it into an
  // uncaughtException that kills the process. Fold it into the connection
  // lifecycle instead: closing stops further frames from being written.
  options.output.on('error', (error: Error) => {
    connection.close(error);
  });
  if (options.onClose !== undefined) {
    connection.onClose(options.onClose);
  }
  return connection;
}

/** Write a frame, resolving when the stream has flushed it (backpressure-safe). */
function writeToStream(stream: Writable, data: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(data, (error: Error | null | undefined) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
