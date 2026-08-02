import { mkdtemp, rm } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createServer, type RunningServer } from '../src/index';

const TOKEN = 'ws-auth-test-token';

/** Attempt a ws upgrade; resolves with the HTTP status of the outcome. */
function attemptUpgrade(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; socket?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve({ status: 101, socket }));
    socket.once('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
    });
    socket.once('error', (error) => reject(error));
  });
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('ws transport auth (design §2.3)', () => {
  const tempDirs: string[] = [];
  let server: RunningServer;
  let url: string;

  beforeAll(async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-ws-auth-home-'));
    tempDirs.push(homeDir);
    server = await createServer({ transport: 'ws', homeDir, port: 0, token: TOKEN });
    url = server.ws!.url;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('binds to loopback by default', () => {
    expect(server.ws!.host).toBe('127.0.0.1');
  });

  it('serves /healthz without auth', async () => {
    const health = await httpGet(`http://127.0.0.1:${server.ws!.port}/healthz`);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
  });

  it('answers 404 to other plain HTTP requests', async () => {
    const other = await httpGet(`http://127.0.0.1:${server.ws!.port}/anything`);
    expect(other.status).toBe(404);
  });

  it('rejects upgrades without a token', async () => {
    expect((await attemptUpgrade(url)).status).toBe(401);
  });

  it('rejects upgrades with a wrong token', async () => {
    expect(
      (await attemptUpgrade(url, { Authorization: 'Bearer wrong-token' })).status,
    ).toBe(401);
  });

  it('rejects upgrades carrying an Origin header (browser protection)', async () => {
    expect(
      (
        await attemptUpgrade(url, {
          Authorization: `Bearer ${TOKEN}`,
          Origin: 'http://evil.example',
        })
      ).status,
    ).toBe(403);
  });

  it('accepts the correct token and completes the JSON-RPC handshake', async () => {
    const { status, socket } = await attemptUpgrade(url, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(101);
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timed out')), 10_000);
      socket!.once('message', (data: Buffer) => {
        clearTimeout(timer);
        const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        resolve(message);
      });
      socket!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'auth-test', version: '0' }, protocolVersion: 1 },
        }),
      );
    });
    expect(result['id']).toBe(1);
    expect(result['error']).toBeUndefined();
    const payload = result['result'] as Record<string, unknown>;
    expect(payload['protocolVersion']).toBe(1);
    socket!.close();
  }, 15_000);

  it('keeps rejecting after a malformed bearer scheme', async () => {
    expect((await attemptUpgrade(url, { Authorization: `Basic ${TOKEN}` })).status).toBe(401);
  });
});
