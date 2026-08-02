/**
 * PTY-session output ceilings in BackgroundManager (RFC unified-exec-pty §3.3):
 *  - sessions are EXEMPT from the 16 MiB kill ceiling (`MAX_TASK_OUTPUT_BYTES`)
 *    that force-terminates one-shot process tasks;
 *  - instead, `output.log` appends stop at the 64 MiB disk cap while the
 *    process keeps running;
 *  - terminal notifications say "shell session exited", not "background
 *    command completed".
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import type { BackgroundManager } from '../../../src/agent/background';
import { ShellSessionTask } from '../../../src/agent/background';
import { createBackgroundManager, waitForTerminal } from '../background/helpers';
import { fakePtyProcess, waitUntil } from '../shell-session/helpers';

const MiB = 1024 * 1024;

/** Poll the manager's output accounting until it reaches `minBytes`. */
async function waitForOutputSize(
  manager: BackgroundManager,
  taskId: string,
  minBytes: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await manager.getOutputSnapshot(taskId, 0)).outputSizeBytes < minBytes) {
    if (Date.now() > deadline) throw new Error('timed out waiting for output accounting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createSessionTask(fake: ReturnType<typeof fakePtyProcess>) {
  return new ShellSessionTask(
    fake.proc,
    'yes',
    'Session: yes',
    () => {},
    () => {},
  );
}

describe('BackgroundManager pty-session output ceilings', () => {
  it('does NOT kill a pty-session task past the 16 MiB process ceiling', async () => {
    const { manager } = createBackgroundManager();
    const fake = fakePtyProcess();
    const taskId = manager.registerTask(createSessionTask(fake));

    // Push well past the 16 MiB one-shot ceiling.
    for (let i = 0; i < 17; i++) {
      fake.emit('x'.repeat(MiB));
    }
    await waitForOutputSize(manager, taskId, 16 * MiB);

    const info = manager.getTask(taskId);
    expect(info?.status).toBe('running');
    expect(info?.stopReason).toBeUndefined();
    expect(fake.killSpy).not.toHaveBeenCalled();

    fake.exit(0);
    const terminal = await waitForTerminal(manager, taskId);
    expect(terminal?.status).toBe('completed');
  });

  it('stops output.log appends at the 64 MiB disk cap but keeps the process alive', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'pty-disk-cap-'));
    try {
      const { manager, persistence } = createBackgroundManager({ sessionDir });
      const fake = fakePtyProcess();
      const taskId = manager.registerTask(createSessionTask(fake));

      // 65 MiB > 64 MiB cap.
      for (let i = 0; i < 65; i++) {
        fake.emit('y'.repeat(MiB));
      }
      await waitForOutputSize(manager, taskId, 65 * MiB);
      // Let the output write queue drain, then measure the on-disk log.
      await manager.getOutputSnapshot(taskId, 0);
      const sizeOnDisk = await persistence!.taskOutputSizeBytes(taskId);
      expect(sizeOnDisk).toBeGreaterThan(0);
      expect(sizeOnDisk).toBeLessThanOrEqual(64 * MiB + MiB);

      const info = manager.getTask(taskId);
      expect(info?.status).toBe('running');
      expect(fake.killSpy).not.toHaveBeenCalled();

      fake.exit(0);
      await waitForTerminal(manager, taskId);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('words the terminal notification as an interactive session exit', async () => {
    const { agent, manager } = createBackgroundManager();
    const fake = fakePtyProcess();
    const taskId = manager.registerTask(createSessionTask(fake));

    fake.emit('done\n');
    fake.exit(0);
    await waitForTerminal(manager, taskId);
    await waitUntil(() => agent.turn.steer.mock.calls.length > 0, 5_000, 'terminal notification');

    const texts = agent.turn.steer.mock.calls
      .map((call) => (call[0] as readonly { type: string; text: string }[]).map((p) => p.text).join('\n'))
      .join('\n');
    expect(texts).toContain('Shell session completed');
    expect(texts).toContain('Interactive shell session');
    expect(texts).not.toContain('Background process completed');
  });
});
