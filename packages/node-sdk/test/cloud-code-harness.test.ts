import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCloudCodeHarness, ImageLimits, CloudCodeHarness, SDKRpcClientBase } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The recursive RPC surface CloudCodeHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts.
 */
class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error('no core calls expected');
  }
}

describe('CloudCodeHarness imageLimits', () => {
  it('exposes the in-process core [image] limits loaded from config.toml', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[image]
max_edge_px = 1200
read_byte_budget = 65536
`,
      'utf-8',
    );

    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      // The core was constructed in-process; its owner-scoped [image] limits
      // must be readable on the harness for prompt-ingestion paths.
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(1200);
      expect(harness.imageLimits?.readByteBudget()).toBe(65536);
    } finally {
      await harness.close();
    }
  });

  it('falls back to built-in defaults when no [image] section is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);

    const harness = createCloudCodeHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(2000);
      expect(harness.imageLimits?.readByteBudget()).toBe(256 * 1024);
    } finally {
      await harness.close();
    }
  });

  it('a hand-built harness returns the injected ImageLimits as-is', () => {
    const limits = new ImageLimits(process.env, { maxEdgePx: 900 });
    const harness = new CloudCodeHarness(new StubRpc(), {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx()).toBe(900);
  });
});

describe('CloudCodeHarness.close', () => {
  /** Stub core: sessions close fine except `sess-2`, whose close rejects. */
  class CloseStubRpc extends SDKRpcClientBase {
    private nextId = 0;
    readonly closedSessionIds: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async getRpc(): Promise<any> {
      return {
        createSession: (input: { workDir?: string }) => ({
          id: `sess-${String(++this.nextId)}`,
          workDir: input.workDir ?? '/tmp',
        }),
        closeSession: ({ sessionId }: { sessionId: string }) => {
          this.closedSessionIds.push(sessionId);
          if (sessionId === 'sess-2') {
            return Promise.reject(new Error('connection dead'));
          }
          return Promise.resolve();
        },
      };
    }
  }

  function makeHarness(rpc: SDKRpcClientBase, onClose: () => void): CloudCodeHarness {
    return new CloudCodeHarness(rpc, {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      ensureConfigFile: async () => undefined,
      onClose,
    });
  }

  it('still runs closeImpl when a session fails to close, then surfaces the failure', async () => {
    const rpc = new CloseStubRpc();
    let closeImplCalls = 0;
    const harness = makeHarness(rpc, () => {
      closeImplCalls += 1;
    });
    await harness.createSession({ workDir: '/tmp' });
    await harness.createSession({ workDir: '/tmp' });

    // The single session failure is rethrown as-is — but only after every
    // session close was attempted and closeImpl ran (for stdio remote
    // transport that is what kills the `cloud-code serve` child process).
    await expect(harness.close()).rejects.toThrow('connection dead');
    expect(rpc.closedSessionIds.toSorted()).toEqual(['sess-1', 'sess-2']);
    expect(closeImplCalls).toBe(1);
  });

  it('propagates a closeImpl failure after all sessions closed', async () => {
    const rpc = new CloseStubRpc();
    const harness = makeHarness(rpc, () => {
      throw new Error('child kill failed');
    });
    await harness.createSession({ workDir: '/tmp' });

    await expect(harness.close()).rejects.toThrow('child kill failed');
    expect(rpc.closedSessionIds).toEqual(['sess-1']);
  });
});
