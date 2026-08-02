import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore, isBlobRef } from '../../../src/agent/records/blobref';
import type { AgentRecord } from '../../../src/agent/records';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function firstImageUrl(record: AgentRecord): string {
  return (record as unknown as { input: [{ imageUrl: { url: string } }] }).input[0].imageUrl.url;
}

async function makeStore(options?: { maxCacheSize?: number; threshold?: number }): Promise<{ store: BlobStore; blobsDir: string }> {
  const blobsDir = join(tmpdir(), `blobref-test-${randomBytes(6).toString('hex')}`);
  await mkdir(blobsDir, { recursive: true });
  cleanups.push(blobsDir);
  return {
    store: new BlobStore({
      blobsDir,
      threshold: options?.threshold ?? 4096,
      maxCacheSize: options?.maxCacheSize,
    }),
    blobsDir,
  };
}

describe('blobref', () => {
  it('offloads large data URIs and replaces with blobref', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'A'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);

    const url = (offloaded as unknown as { input: [{ imageUrl: { url: string } }] }).input[0]
      .imageUrl.url;
    expect(isBlobRef(url)).toBe(true);
    expect(url.startsWith('blobref:')).toBe(true);
    expect(url.startsWith('blobref:image/png;')).toBe(true);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    expect((await readFile(join(blobsDir, files[0]!))).toString('base64')).toBe(payload);
  });

  it('does not mutate the input record or its content parts', async () => {
    const { store } = await makeStore();
    const payload = 'M'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;
    const innerImageUrl = { url: dataUri };
    const part = { type: 'image_url', imageUrl: innerImageUrl } as const;
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [part as unknown as { type: 'image_url'; imageUrl: { url: string } }],
      origin: { kind: 'user' },
    } as unknown as AgentRecord;

    const offloaded = await store.offload(record);

    // The original record/parts must remain untouched.
    expect(
      (record as unknown as { input: unknown[] }).input[0],
    ).toBe(part);
    expect(part.imageUrl).toBe(innerImageUrl);
    expect(innerImageUrl.url).toBe(dataUri);

    // The returned record carries the blobref URL.
    expect(offloaded).not.toBe(record);
    const returnedUrl = (
      offloaded as unknown as { input: [{ imageUrl: { url: string } }] }
    ).input[0].imageUrl.url;
    expect(returnedUrl.startsWith('blobref:image/png;')).toBe(true);
  });

  it('offloads tool.result media parts in context.append_loop_event records', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'X'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;
    const innerImageUrl = { url: dataUri };
    const part = { type: 'image_url', imageUrl: innerImageUrl } as const;
    const record: AgentRecord = {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'p',
        toolCallId: 'tc',
        result: { isError: false, output: [part] },
      },
    } as unknown as AgentRecord;

    const offloaded = await store.offload(record);

    // Input record/part untouched — same path that the agent's in-memory
    // history shares with this record reference.
    expect(innerImageUrl.url).toBe(dataUri);
    expect(part.imageUrl).toBe(innerImageUrl);

    // Returned record has blobref URL on a fresh imageUrl object.
    const returned = offloaded as unknown as {
      event: { result: { output: [{ imageUrl: { url: string } }] } };
    };
    expect(returned.event.result.output[0].imageUrl).not.toBe(innerImageUrl);
    expect(returned.event.result.output[0].imageUrl.url.startsWith('blobref:image/png;')).toBe(true);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
  });

  it('returns the same record reference when nothing needs offloading', async () => {
    const { store } = await makeStore();
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'just text' }],
      origin: { kind: 'user' },
    } as unknown as AgentRecord;

    const offloaded = await store.offload(record);
    expect(offloaded).toBe(record);
  });

  it('skips small data URIs below threshold', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'short';
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);

    // Below threshold: nothing happens; original record is returned as-is.
    expect(offloaded).toBe(record);
    const files = await readdir(blobsDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('skips existing blobrefs during offload', async () => {
    const { store } = await makeStore();
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;abc' } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);

    // Already a blobref: nothing to do; the same reference is returned.
    expect(offloaded).toBe(record);
  });

  it('rehydrates blobrefs back to data URIs', async () => {
    const { store } = await makeStore();
    const payload = 'B'.repeat(5000);
    const dataUri = `data:image/jpeg;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);
    await store.rehydrate(offloaded);

    const url = (offloaded as unknown as { input: [{ imageUrl: { url: string } }] }).input[0]
      .imageUrl.url;
    expect(url).toBe(dataUri);
  });

  it('degrades missing blobs to a text marker part', async () => {
    const { store } = await makeStore();
    // Valid-shaped but nonexistent hash: exercises the blob-missing path.
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `blobref:image/png;${'d'.repeat(64)}` } }],
      origin: { kind: 'user' },
    };

    await store.rehydrate(record);

    // The whole part degrades to text — keeping the media shape with a
    // placeholder URL would 400 on strict providers every request.
    expect((record as unknown as { input: unknown[] }).input[0]).toEqual({
      type: 'text',
      text: '[media missing]',
    });
  });

  it('rejects blobref hashes that could traverse out of the blobs directory', async () => {
    const { store, blobsDir } = await makeStore();
    // A secret-shaped file next to the blobs dir: a naive join() would read it
    // and inline it as a data URI, exfiltrating it into the model context.
    const parentDir = join(blobsDir, '..');
    const secretName = `secret-${randomBytes(4).toString('hex')}`;
    await writeFile(join(parentDir, secretName), 'TOP SECRET');
    cleanups.push(join(parentDir, secretName));

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [
        {
          type: 'image_url',
          imageUrl: { url: `blobref:image/png;../${secretName}` },
        },
      ],
      origin: { kind: 'user' },
    } as unknown as AgentRecord;

    await store.rehydrate(record);

    const part = (record as unknown as { input: unknown[] }).input[0];
    expect(part).toEqual({ type: 'text', text: '[media missing]' });
  });

  it('rejects malformed hashes without touching the filesystem', async () => {
    const { store } = await makeStore();
    const badHashes = [
      'deadbeef', // too short
      'A'.repeat(64), // uppercase — the write side only emits lowercase
      'g'.repeat(64), // not hex
      `${'a'.repeat(63)}/a`, // 64 chars with a separator
      `${'a'.repeat(64)};extra`, // trailing garbage
    ];
    for (const hash of badHashes) {
      const record: AgentRecord = {
        type: 'turn.prompt',
        input: [{ type: 'image_url', imageUrl: { url: `blobref:image/png;${hash}` } }],
        origin: { kind: 'user' },
      } as unknown as AgentRecord;

      await store.rehydrate(record);

      expect((record as unknown as { input: unknown[] }).input[0]).toEqual({
        type: 'text',
        text: '[media missing]',
      });
    }
  });

  it('rejects a non-media mime even when the blob file exists', async () => {
    const { store, blobsDir } = await makeStore();
    const hash = 'a'.repeat(64);
    await writeFile(join(blobsDir, hash), Buffer.from('<script>alert(1)</script>'));

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `blobref:text/html;${hash}` } }],
      origin: { kind: 'user' },
    } as unknown as AgentRecord;

    await store.rehydrate(record);

    expect((record as unknown as { input: unknown[] }).input[0]).toEqual({
      type: 'text',
      text: '[media missing]',
    });
  });

  it('deduplicates identical payloads by hash', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'C'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record1: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };
    const record2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    await store.offload(record1);
    await store.offload(record2);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
  });

  it('rehydrates from write-through cache after blob file is deleted', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'E'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);
    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    await rm(join(blobsDir, files[0]!));

    // Should still rehydrate because offload populated the cache.
    await store.rehydrate(offloaded);
    const url = (offloaded as unknown as { input: [{ imageUrl: { url: string } }] }).input[0]
      .imageUrl.url;
    expect(url).toBe(dataUri);
  });

  it('rehydrates from read cache after first disk read', async () => {
    const { store, blobsDir } = await makeStore();
    const payload = 'F'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    const offloaded = await store.offload(record);
    await store.rehydrate(offloaded);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    await rm(join(blobsDir, files[0]!));

    // Second rehydrate (of a fresh record pointing to the same blobref)
    // should still succeed because the first rehydrate populated the read cache.
    // After the rehydrate above, `offloaded` carries the data URI again — pull
    // the blobref back out by re-offloading or re-using the original offload run.
    const offloadedFresh = await store.offload(record);
    const record2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedFresh) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(record2);
    expect(firstImageUrl(record2)).toBe(dataUri);
  });

  it('evicts least-recently-used entries when cache size limit is exceeded', async () => {
    const limit = 8; // bytes
    const { store, blobsDir } = await makeStore({ maxCacheSize: limit, threshold: 1 });

    const payloadA = 'A'.repeat(4); // 3 bytes after base64 decode
    const payloadB = 'B'.repeat(4); // 3 bytes after base64 decode
    const payloadC = 'C'.repeat(4); // 3 bytes after base64 decode

    const recordA: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${payloadA}` } }],
      origin: { kind: 'user' },
    };
    const recordB: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${payloadB}` } }],
      origin: { kind: 'user' },
    };
    const recordC: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${payloadC}` } }],
      origin: { kind: 'user' },
    };

    const offloadedA = await store.offload(recordA);
    const offloadedB = await store.offload(recordB);

    // Touch A so it becomes more recent than B.
    const recordA_touch: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedA) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordA_touch);

    // Adding C should evict B (the least-recently-used), not A.
    const offloadedC = await store.offload(recordC);

    // Delete all files so only cache can satisfy rehydration.
    const files = await readdir(blobsDir);
    for (const f of files) {
      await rm(join(blobsDir, f));
    }

    // A should still be cached because it was touched after B.
    const recordA2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedA) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordA2);
    expect(firstImageUrl(recordA2)).toBe(`data:image/png;base64,${payloadA}`);

    // B should have been evicted — its part degrades to the text marker.
    const recordB2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedB) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordB2);
    expect((recordB2.input as unknown as unknown[])[0]).toEqual({
      type: 'text',
      text: '[media missing]',
    });

    // C should still be cached.
    const recordC2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedC) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordC2);
    expect(firstImageUrl(recordC2)).toBe(`data:image/png;base64,${payloadC}`);
  });

  it('skips caching a blob larger than the entire cache cap', async () => {
    const limit = 8; // bytes
    const { store, blobsDir } = await makeStore({ maxCacheSize: limit, threshold: 1 });

    const small = 'S'.repeat(4);
    const large = 'L'.repeat(16);

    const recordSmall: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${small}` } }],
      origin: { kind: 'user' },
    };
    const recordLarge: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${large}` } }],
      origin: { kind: 'user' },
    };

    const offloadedSmall = await store.offload(recordSmall);
    const offloadedLarge = await store.offload(recordLarge);

    // Delete all files so only cache can satisfy rehydration.
    const files = await readdir(blobsDir);
    for (const f of files) {
      await rm(join(blobsDir, f));
    }

    // The small blob is still cached.
    const recordSmall2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedSmall) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordSmall2);
    expect(firstImageUrl(recordSmall2)).toBe(`data:image/png;base64,${small}`);

    // The large blob was never cached, so rehydration degrades it to text.
    const recordLarge2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: firstImageUrl(offloadedLarge) } }],
      origin: { kind: 'user' },
    };
    await store.rehydrate(recordLarge2);
    expect((recordLarge2.input as unknown as unknown[])[0]).toEqual({
      type: 'text',
      text: '[media missing]',
    });
  });
});
