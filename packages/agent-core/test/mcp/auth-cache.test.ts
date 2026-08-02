/**
 * MCP needs-auth TTL cache: a server whose OAuth failed is
 * remembered for 15 minutes; automatic connection attempts short-circuit to
 * `needs-auth` without touching the network, while explicit reconnects
 * always retry for real. Guards the token endpoint against refresh
 * avalanches when N concurrent calls all discover the same dead token.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MCP_AUTH_CACHE_TTL_MS, McpAuthCache } from '../../src/mcp/auth-cache';
import { McpConnectionManager } from '../../src/mcp/connection-manager';
import { JsonFileStore, McpOAuthService } from '../../src/mcp/oauth';

describe('McpAuthCache (fake clock)', () => {
  let dir: string;
  let cachePath: string;
  let now: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloud-code-mcp-auth-cache-'));
    cachePath = join(dir, 'mcp-needs-auth-cache.json');
    now = 1_000_000;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function cache(): McpAuthCache {
    return new McpAuthCache({ path: cachePath, now: () => now });
  }

  it('reports no entry for an unknown server', async () => {
    await expect(cache().isFresh('srv')).resolves.toBe(false);
  });

  it('treats an entry as fresh for the whole TTL, then expires it', async () => {
    const c = cache();
    await c.mark('srv');

    await expect(c.isFresh('srv')).resolves.toBe(true);
    now += MCP_AUTH_CACHE_TTL_MS - 1;
    await expect(c.isFresh('srv')).resolves.toBe(true);
    now += 1; // exactly at the TTL boundary
    await expect(c.isFresh('srv')).resolves.toBe(false);
    now += MCP_AUTH_CACHE_TTL_MS;
    await expect(c.isFresh('srv')).resolves.toBe(false);
  });

  it('clear() drops the entry immediately', async () => {
    const c = cache();
    await c.mark('srv');
    await expect(c.isFresh('srv')).resolves.toBe(true);
    await c.clear('srv');
    await expect(c.isFresh('srv')).resolves.toBe(false);
  });

  it('persists entries across instances (same file)', async () => {
    await cache().mark('srv');
    await expect(cache().isFresh('srv')).resolves.toBe(true);
  });

  it('treats a corrupt cache file as empty instead of throwing', async () => {
    await writeFile(cachePath, '{not json', 'utf-8');
    await expect(cache().isFresh('srv')).resolves.toBe(false);
  });

  it('tracks servers independently', async () => {
    const c = cache();
    await c.mark('a');
    await expect(c.isFresh('a')).resolves.toBe(true);
    await expect(c.isFresh('b')).resolves.toBe(false);
    now += MCP_AUTH_CACHE_TTL_MS + 1;
    await c.mark('b');
    await expect(c.isFresh('a')).resolves.toBe(false);
    await expect(c.isFresh('b')).resolves.toBe(true);
  });
});

describe('McpConnectionManager needs-auth cache', () => {
  let server: HttpServer;
  let port: number;
  let requestCount: number;
  let storeDir: string;
  let cacheDir: string;
  let now: number;
  let authCache: McpAuthCache;

  beforeEach(async () => {
    requestCount = 0;
    server = createHttpServer((_req, res) => {
      requestCount += 1;
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as HttpAddress).port;
    storeDir = await mkdtemp(join(tmpdir(), 'cloud-code-mcp-oauth-store-'));
    cacheDir = await mkdtemp(join(tmpdir(), 'cloud-code-mcp-auth-cm-'));
    now = 5_000_000;
    authCache = new McpAuthCache({
      path: join(cacheDir, 'mcp-needs-auth-cache.json'),
      now: () => now,
    });
  });

  afterEach(async () => {
    // Flush fire-and-forget cache writes (401 re-marks from connect attempts)
    // before removing the cache dir, or a late write lands mid-rm and the
    // rmdir fails ENOTEMPTY.
    await authCache.pendingWrites();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await rm(storeDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
    delete process.env['CLOUD_CODE_TEST_TOKEN'];
  });

  function manager(): McpConnectionManager {
    return new McpConnectionManager({
      oauthService: new McpOAuthService({ store: new JsonFileStore(storeDir) }),
      authCache,
    });
  }

  function serverConfig() {
    return {
      transport: 'http' as const,
      url: `http://127.0.0.1:${String(port)}/mcp`,
      startupTimeoutMs: 5_000,
    };
  }

  it('marks the cache on a 401, then short-circuits the next attempt without network', async () => {
    const first = manager();
    try {
      await first.connectAll({ gated: serverConfig() });
      expect(first.get('gated')?.status).toBe('needs-auth');
      expect(requestCount).toBeGreaterThan(0);
      // The manager marks the cache fire-and-forget; flush before the next
      // manager reads the file.
      await authCache.pendingWrites();
    } finally {
      await first.shutdown();
    }

    // A fresh manager over the same cache file (the next session start)
    // must not touch the network at all.
    const before = requestCount;
    const second = manager();
    try {
      await second.connectAll({ gated: serverConfig() });
      const entry = second.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(requestCount).toBe(before);
    } finally {
      await second.shutdown();
    }
  }, 20000);

  it('retries for real once the TTL has expired', async () => {
    const cm = manager();
    try {
      await cm.connectAll({ gated: serverConfig() });
      expect(cm.get('gated')?.status).toBe('needs-auth');
      const before = requestCount;

      now += MCP_AUTH_CACHE_TTL_MS + 1;
      await cm.connect('gated', serverConfig());
      expect(cm.get('gated')?.status).toBe('needs-auth');
      expect(requestCount).toBeGreaterThan(before);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('reconnect() bypasses the cache (explicit user retry after login)', async () => {
    const cm = manager();
    try {
      await cm.connectAll({ gated: serverConfig() });
      expect(cm.get('gated')?.status).toBe('needs-auth');
      const before = requestCount;

      // The entry is fresh, but /mcp-config login drives an explicit
      // reconnect — it must hit the network (and re-mark on the 401).
      await cm.reconnect('gated');
      expect(cm.get('gated')?.status).toBe('needs-auth');
      expect(requestCount).toBeGreaterThan(before);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('does not consult the cache for servers outside the OAuth flow (static token)', async () => {
    process.env['CLOUD_CODE_TEST_TOKEN'] = 'test-token';
    const cm = manager();
    try {
      await cm.connectAll({ gated: serverConfig() });
      expect(cm.get('gated')?.status).toBe('needs-auth');
      const before = requestCount;

      // A bearer-token server is not an OAuth candidate: even with a fresh
      // cache entry under the same name, the attempt goes through.
      await cm.connect('gated', { ...serverConfig(), bearerTokenEnvVar: 'CLOUD_CODE_TEST_TOKEN' });
      expect(requestCount).toBeGreaterThan(before);
      expect(cm.get('gated')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('without an authCache the manager always hits the network', async () => {
    const plain = new McpConnectionManager({
      oauthService: new McpOAuthService({ store: new JsonFileStore(storeDir) }),
    });
    try {
      await plain.connectAll({ gated: serverConfig() });
      expect(plain.get('gated')?.status).toBe('needs-auth');
      const before = requestCount;
      await plain.connect('gated', serverConfig());
      expect(requestCount).toBeGreaterThan(before);
    } finally {
      await plain.shutdown();
    }
  }, 20000);
});
