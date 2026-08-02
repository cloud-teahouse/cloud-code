/**
 * LocalPtyProcess EOF guard: node-pty does not guarantee onData/onExit
 * ordering — residual bytes in the kernel pty buffer can be delivered after
 * onExit already pushed EOF onto `output`. The late data must be dropped:
 * pushing past EOF emits ERR_STREAM_PUSH_AFTER_EOF on the stream, and once
 * the consumer cleaned up its listeners that 'error' becomes an uncaught
 * exception.
 *
 * node-pty is mocked so the onData/onExit ordering is scripted by hand.
 * (The real-node-pty coverage lives in pty.test.ts; this file pins the
 * out-of-order delivery regression.)
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalKaos } from '#/local';

// vi.mock factories run before imports resolve, so the fake handle is built
// inside vi.hoisted with no dependency on imported modules.
const { fake } = vi.hoisted(() => {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  return {
    fake: {
      handle: {
        pid: 4242,
        onData: (cb: (data: string) => void): void => {
          dataCallbacks.push(cb);
        },
        onExit: (cb: (event: { exitCode: number; signal?: number }) => void): void => {
          exitCallbacks.push(cb);
        },
        write: (): void => {},
        resize: (): void => {},
        kill: (): void => {},
      },
      emitData: (data: string): void => {
        for (const cb of dataCallbacks) cb(data);
      },
      emitExit: (exitCode: number): void => {
        for (const cb of exitCallbacks) cb({ exitCode });
      },
    },
  };
});

vi.mock('node-pty', () => ({
  spawn: () => fake.handle,
}));

describe('LocalPtyProcess EOF guard (mocked node-pty)', () => {
  it('drops onData delivered after onExit pushed EOF — no push-after-EOF error', async () => {
    const kaos = await LocalKaos.create();
    const proc = await kaos.ptyExec(['bash']);

    const received: string[] = [];
    const errors: Error[] = [];
    proc.output.on('data', (chunk: string | Buffer) => received.push(String(chunk)));
    proc.output.on('error', (error: Error) => errors.push(error));

    fake.emitData('before exit\n');
    fake.emitExit(0);
    // Residual kernel-buffer bytes arriving after the exit callback.
    fake.emitData('late\n');

    expect(await proc.wait()).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(received.join('')).toBe('before exit\n');
    expect(errors).toEqual([]);
    await proc.dispose();
  });

  it('still streams data delivered before the exit', async () => {
    const kaos = await LocalKaos.create();
    const proc = await kaos.ptyExec(['bash']);

    const received: string[] = [];
    proc.output.on('data', (chunk: string | Buffer) => received.push(String(chunk)));

    fake.emitData('chunk-1\n');
    fake.emitData('chunk-2\n');
    fake.emitExit(3);

    expect(await proc.wait()).toBe(3);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.join('')).toBe('chunk-1\nchunk-2\n');
    await proc.dispose();
  });
});
