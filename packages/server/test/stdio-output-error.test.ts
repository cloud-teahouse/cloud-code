import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createStdioConnection } from '../src/transport/stdio';

/**
 * A dead reader (client exit/crash mid-turn) surfaces as an async 'error'
 * (EPIPE) on the output stream. Without a listener Node turns that into an
 * uncaughtException and kills the serve process; the transport must instead
 * fold it into the connection lifecycle.
 */
describe('stdio output stream errors', () => {
  it('closes the connection when the output stream errors', async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const connection = createStdioConnection({ input, output });
    const closed = new Promise<void>((resolve) => connection.onClose(resolve));

    output.emit('error', new Error('write EPIPE'));

    await closed;
    expect(connection.closed).toBe(true);
  });

  it('reports a failing frame write as a protocol error and closes', async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('write EPIPE'));
      },
    });
    const protocolErrors: string[] = [];
    const connection = createStdioConnection({
      input,
      output,
      onProtocolError: (error) => protocolErrors.push(error.message),
    });
    const closed = new Promise<void>((resolve) => connection.onClose(resolve));

    connection.notify('event', { type: 'assistant.delta', delta: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The rejected write reached the sink-error path (no unhandled
    // rejection), and the stream 'error' closed the connection.
    expect(protocolErrors).toEqual(['write EPIPE']);
    await closed;
    expect(connection.closed).toBe(true);
  });
});
