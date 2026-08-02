/**
 * Multi-client attach acceptance (design §4 v1 验收 3): one server, two
 * connections. Client A creates and drives the session; client B attaches
 * via resumeSession, receives its events, and — as the latest claimant —
 * answers the next approval.
 */
import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ServerHost } from '../src/host';
import { JsonRpcConnection } from '../src/jsonrpc/connection';

function linkedPair(): [JsonRpcConnection, JsonRpcConnection] {
  let serverSide!: JsonRpcConnection;
  let clientSide!: JsonRpcConnection;
  serverSide = new JsonRpcConnection({
    write: (message) => queueMicrotask(() => clientSide.handleMessage(message)),
  });
  clientSide = new JsonRpcConnection({
    write: (message) => queueMicrotask(() => serverSide.handleMessage(message)),
  });
  return [serverSide, clientSide];
}

class TestClient {
  readonly events: Array<Record<string, unknown>> = [];
  readonly approvalRequests: Array<Record<string, unknown>> = [];
  approvalDecision: Record<string, unknown> = { decision: 'approved' };

  constructor(private readonly connection: JsonRpcConnection) {
    connection.onNotification('event', (params) =>
      this.events.push(params as Record<string, unknown>),
    );
    connection.onRequest('requestApproval', (params) => {
      this.approvalRequests.push(params as Record<string, unknown>);
      return this.approvalDecision;
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    return this.connection.request<T>(method, params);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'test', version: '0' },
      capabilities: {},
      protocolVersion: 1,
    });
  }

  eventsOfType(type: string): Array<Record<string, unknown>> {
    return this.events.filter((event) => event['type'] === type);
  }

  async waitForEvent(type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.eventsOfType(type)[0];
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await delay(10);
    }
  }
}

function makeChunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-multi',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function textSse(text: string): string {
  return sse([makeChunk({ content: text }), makeChunk({}, 'stop')]);
}

function bashSse(command: string): string {
  return sse([
    makeChunk({
      tool_calls: [{ index: 0, id: 'call_attach', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }],
    }),
    makeChunk({}, 'tool_calls'),
  ]);
}

describe('multi-client attach', () => {
  const tempDirs: string[] = [];
  let provider: http.Server;
  let host: ServerHost;
  let workDir: string;

  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        const messages = parsed.messages ?? [];
        const systemText = JSON.stringify(messages[0]?.content ?? '');
        const conversationText = JSON.stringify(messages);
        let payload: string;
        if (systemText.includes('sentence-case title')) {
          // Session-title generation: always answer with plain text.
          payload = textSse('multi attach title');
        } else if (messages.some((m) => m.role === 'tool')) {
          payload = textSse('attach turn complete');
        } else if (conversationText.includes('run the attach echo')) {
          payload = bashSse('echo attach-approval-marker');
        } else {
          payload = textSse('plain reply');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-multi-home-'));
    tempDirs.push(homeDir);
    workDir = await mkdtemp(join(tmpdir(), 'cloud-code-multi-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "multi"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'api_key = "sk-fake"',
        '',
        '[models.multi]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 128000',
        '',
      ].join('\n'),
    );
    host = new ServerHost({ homeDir });
  }, 60_000);

  afterAll(async () => {
    await host?.close();
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('lets a second connection attach, receive events, and answer approvals', async () => {
    // Client A: attach + create the session.
    const [serverA, clientA] = linkedPair();
    host.attach(serverA);
    const a = new TestClient(clientA);
    await a.initialize();
    const created = await a.request<{ id: string }>('createSession', {
      workDir,
      permission: 'auto',
    });
    const sessionId = created.id;

    // Turn 1 from A: plain text reply, no approvals.
    await a.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'hello' }],
    });
    await a.waitForEvent('turn.ended');

    // Client B attaches to the same session (claims ownership).
    const [serverB, clientB] = linkedPair();
    host.attach(serverB);
    const b = new TestClient(clientB);
    await b.initialize();
    const resumed = await b.request<{ id: string }>('resumeSession', { sessionId });
    expect(resumed.id).toBe(sessionId);

    // B switches the session to manual so the next tool call needs approval.
    await b.request('setPermission', { sessionId, agentId: 'main', mode: 'manual' });

    // Turn 2 from A: triggers a Bash call whose approval must land on B.
    await a.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'run the attach echo' }],
    });
    await b.waitForEvent('turn.ended');
    await a.waitForEvent('turn.ended');

    // B (latest claimant) got the approval request; A (first connection) did
    // not, and both received the session's event stream.
    expect(b.approvalRequests).toHaveLength(1);
    expect(b.approvalRequests[0]).toMatchObject({ toolName: 'Bash', sessionId });
    expect(a.approvalRequests).toHaveLength(0);
    expect(b.eventsOfType('turn.started').length).toBeGreaterThan(0);
    expect(JSON.stringify(b.events)).toContain('attach-approval-marker');

    clientA.close();
    clientB.close();
  }, 60_000);
});
