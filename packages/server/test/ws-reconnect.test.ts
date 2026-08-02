/**
 * ws reconnect acceptance (design §4 v2): a client drops mid-session, a new
 * connection re-subscribes with its last cursor and the journal replays the
 * missed durable events; `resumeSession` then re-claims the session and its
 * snapshot carries the terminal state (不丢终态). Stale cursors (foreign
 * epoch / seq fallen out of the ring) get `resync_required`.
 */
import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { ServerHost } from '../src/host';
import { startWsTransport, type RunningWsTransport } from '../src/transport/ws';

const TOKEN = 'ws-reconnect-test-token';

// ---------------------------------------------------------------------------
// Raw JSON-RPC-over-ws test client
// ---------------------------------------------------------------------------

interface CapturedEvent {
  readonly params: Record<string, unknown>;
  readonly cursor?: { seq: number; epoch?: string | undefined };
}

class WsTestClient {
  readonly events: CapturedEvent[] = [];
  readonly resyncs: Array<Record<string, unknown>> = [];
  readonly approvals: Array<Record<string, unknown>> = [];
  approvalDecision: Record<string, unknown> = { decision: 'approved' };

  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  static connect(url: string): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      socket.once('open', () => resolve(new WsTestClient(socket)));
      socket.once('unexpected-response', (_request, response) => {
        reject(new Error(`upgrade rejected: HTTP ${String(response.statusCode)}`));
      });
      socket.once('error', reject);
    });
  }

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      this.handle(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
  }

  private handle(message: Record<string, unknown>): void {
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(String(message['id']));
      if (pending === undefined) return;
      this.pending.delete(String(message['id']));
      if (message['error'] !== undefined) {
        pending.reject(new Error(JSON.stringify(message['error'])));
      } else {
        pending.resolve(message['result']);
      }
      return;
    }
    if (message['method'] === 'event') {
      this.events.push({
        params: message['params'] as Record<string, unknown>,
        cursor: message['cursor'] as CapturedEvent['cursor'],
      });
      return;
    }
    if (message['method'] === 'resync_required') {
      this.resyncs.push(message['params'] as Record<string, unknown>);
      return;
    }
    if (message['method'] === 'requestApproval' && 'id' in message) {
      this.approvals.push(message['params'] as Record<string, unknown>);
      this.socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: this.approvalDecision }),
      );
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(String(id), {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async initialize(capabilities?: Record<string, unknown>): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'ws-reconnect-test', version: '0' },
      capabilities: capabilities ?? {},
      protocolVersion: 1,
    });
  }

  eventsOfType(type: string): CapturedEvent[] {
    return this.events.filter((event) => event.params['type'] === type);
  }

  /** Seq values of cursor-bearing (durable) events, in arrival order. */
  durableSeqs(): number[] {
    return this.events
      .filter((event) => event.cursor !== undefined)
      .map((event) => event.cursor!.seq);
  }

  /** Newest cursor seen so far (the reconnect resume point). */
  lastCursor(): { seq: number; epoch?: string | undefined } | undefined {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const cursor = this.events[i]!.cursor;
      if (cursor !== undefined) return cursor;
    }
    return undefined;
  }

  async waitForEvent(type: string, timeoutMs = 20_000): Promise<CapturedEvent> {
    return this.waitForNewEvent(type, 0, timeoutMs);
  }

  /** Wait for an event arriving AFTER the current end of the event log. */
  async waitForNewEvent(type: string, afterIndex?: number, timeoutMs = 20_000): Promise<CapturedEvent> {
    const start = afterIndex ?? this.events.length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.slice(start).find((event) => event.params['type'] === type);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  terminate(): void {
    this.socket.terminate();
  }

  close(): void {
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible provider
// ---------------------------------------------------------------------------

function makeChunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-reconnect',
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
      tool_calls: [
        {
          index: 0,
          id: 'call_reconnect',
          function: { name: 'Bash', arguments: JSON.stringify({ command }) },
        },
      ],
    }),
    makeChunk({}, 'tool_calls'),
  ]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ws reconnect + journal replay (design §4 v2)', () => {
  const tempDirs: string[] = [];
  let provider: http.Server;
  let host: ServerHost;
  let transport: RunningWsTransport;
  let workDir: string;
  let url: string;

  async function startServer(homeDir: string, journalCapacity?: number): Promise<void> {
    host = new ServerHost({
      homeDir,
      eventJournalCapacity: journalCapacity,
    });
    transport = await startWsTransport({
      port: 0,
      token: TOKEN,
      onConnection: (connection) => host.attach(connection),
    });
    url = `ws://127.0.0.1:${transport.port}`;
  }

  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        const messages = parsed.messages ?? [];
        const systemText = JSON.stringify(messages[0]?.content ?? '');
        const conversationText = JSON.stringify(messages);
        let payload: string;
        if (systemText.includes('sentence-case title')) {
          payload = textSse('reconnect title');
        } else if (messages.some((m) => m.role === 'tool')) {
          payload = textSse('reconnect echo done');
        } else if (conversationText.includes('run the reconnect echo')) {
          payload = bashSse('echo reconnect-echo-marker');
        } else if (conversationText.includes('second turn')) {
          payload = textSse('reconnect turn two text');
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

    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-ws-reconnect-home-'));
    tempDirs.push(homeDir);
    workDir = await mkdtemp(join(tmpdir(), 'cloud-code-ws-reconnect-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "reconnect"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'api_key = "sk-fake"',
        '',
        '[models.reconnect]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 128000',
        '',
      ].join('\n'),
    );
    await startServer(homeDir);
  }, 60_000);

  afterAll(async () => {
    await transport?.close();
    await host?.close();
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('replays missed durable events on re-subscribe and recovers via resumeSession', async () => {
    // Client A: create the session, run turn 1, remember the last cursor.
    const a = await WsTestClient.connect(url);
    await a.initialize();
    const created = await a.request<{ id: string }>('createSession', {
      workDir,
      permission: 'auto',
    });
    const sessionId = created.id;
    await a.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'hello' }],
    });
    await a.waitForEvent('turn.ended');
    const cursor = a.lastCursor();
    expect(cursor).toBeDefined();
    expect(cursor!.seq).toBeGreaterThan(0);

    // A drops mid-session; the journal keeps recording.
    a.terminate();

    // Client B subscribes WITHOUT a cursor (live only) and drives turn 2.
    const b = await WsTestClient.connect(url);
    await b.initialize({ sessionIds: [sessionId] });
    await b.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'second turn please' }],
    });
    await b.waitForEvent('turn.ended');
    const turnTwoSeqs = b.durableSeqs();
    expect(turnTwoSeqs.length).toBeGreaterThan(0);
    // The journal continued where A's stream stopped.
    expect(turnTwoSeqs[0]).toBe(cursor!.seq + 1);

    // Client C re-subscribes WITH A's last cursor: the missed turn-2 durable
    // events replay exactly — same seqs as B saw live, no gaps, no dupes.
    const c = await WsTestClient.connect(url);
    await c.initialize({ cursors: { [sessionId]: cursor } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.resyncs).toHaveLength(0);
    expect(c.durableSeqs()).toEqual(turnTwoSeqs);

    // resumeSession re-claims the session for C; its snapshot carries the
    // terminal state accumulated while A was gone (不丢终态).
    const resumed = await c.request<{ id: string }>('resumeSession', { sessionId });
    expect(resumed.id).toBe(sessionId);
    expect(JSON.stringify(resumed)).toContain('reconnect turn two text');

    // Ownership moved to C: the next approval round-trips through C.
    await c.request('setPermission', { sessionId, agentId: 'main', mode: 'manual' });
    const turnThreeMark = c.events.length;
    await c.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'run the reconnect echo' }],
    });
    await c.waitForNewEvent('turn.ended', turnThreeMark);
    expect(c.approvals).toHaveLength(1);
    expect(c.approvals[0]).toMatchObject({ toolName: 'Bash', sessionId });
    expect(JSON.stringify(c.events)).toContain('reconnect-echo-marker');

    b.close();
    c.close();
  }, 90_000);

  it('answers resync_required(epoch_changed) to a cursor from another epoch', async () => {
    const client = await WsTestClient.connect(url);
    await client.initialize({ cursors: { 'any-session': { seq: 0, epoch: 'bogus-epoch' } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.resyncs).toHaveLength(1);
    expect(client.resyncs[0]).toMatchObject({
      sessionId: 'any-session',
      reason: 'epoch_changed',
    });
    client.close();
  }, 30_000);
});

describe('ws resync on ring-buffer overflow', () => {
  const tempDirs: string[] = [];
  let provider: http.Server;
  let host: ServerHost;
  let transport: RunningWsTransport;
  let workDir: string;
  let url: string;

  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(textSse('overflow reply'));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-ws-overflow-home-'));
    tempDirs.push(homeDir);
    workDir = await mkdtemp(join(tmpdir(), 'cloud-code-ws-overflow-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "overflow"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'api_key = "sk-fake"',
        '',
        '[models.overflow]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 128000',
        '',
      ].join('\n'),
    );
    // Capacity 3: one turn journals well over three durable events.
    host = new ServerHost({ homeDir, eventJournalCapacity: 3 });
    transport = await startWsTransport({
      port: 0,
      token: TOKEN,
      onConnection: (connection) => host.attach(connection),
    });
    url = `ws://127.0.0.1:${transport.port}`;
  }, 60_000);

  afterAll(async () => {
    await transport?.close();
    await host?.close();
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('answers resync_required(buffer_overflow) when the cursor fell out of the ring', async () => {
    const a = await WsTestClient.connect(url);
    await a.initialize();
    const created = await a.request<{ id: string }>('createSession', {
      workDir,
      permission: 'auto',
    });
    const sessionId = created.id;
    await a.request('prompt', {
      sessionId,
      agentId: 'main',
      input: [{ type: 'text', text: 'hello' }],
    });
    await a.waitForEvent('turn.ended');
    const epoch = a.lastCursor()?.epoch;
    expect(epoch).toBeDefined();
    a.terminate();

    // seq 1 is long gone from the capacity-3 ring.
    const b = await WsTestClient.connect(url);
    await b.initialize({ cursors: { [sessionId]: { seq: 1, epoch } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.resyncs).toHaveLength(1);
    expect(b.resyncs[0]).toMatchObject({ sessionId, reason: 'buffer_overflow' });
    b.close();
  }, 60_000);
});
