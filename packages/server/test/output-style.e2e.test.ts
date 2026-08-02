/**
 * Output-style effectiveness over the exact RPC path the TUI drives
 * (`setOutputStyle` for the live switch, `setCloudCodeConfig` for
 * persistence), with the system prompt captured on the wire by a loopback
 * provider — the answer to "I switched styles and nothing changed":
 *
 *   - the very next request after a switch carries the style's replacement
 *     bodies and the `Output style: <name>` marker, with the stock bodies
 *     gone (replace, never append);
 *   - a different style produces different bytes;
 *   - the persisted `output_style` in config.toml seeds new sessions, so the
 *     choice survives a restart.
 */
import * as http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { ServerHost } from '../src/host';
import { JsonRpcConnection } from '../src/jsonrpc/connection';

const STOCK_COMMUNICATING_ANCHOR = 'teammate who stepped away';
const STOCK_DELIVERING_ANCHOR = 'Do ordinary work as asked';
const CONCISE_ANCHOR = 'as few words as clarity allows';
const REVIEWER_ANCHOR = 'code review addressed to the author';

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
  private eventCursor = 0;

  constructor(private readonly connection: JsonRpcConnection) {
    connection.onNotification('event', (params) =>
      this.events.push(params as Record<string, unknown>),
    );
    connection.onRequest('requestApproval', () => ({ decision: 'approved' }));
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

  async nextEvent(type: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex(
        (event, i) => i >= this.eventCursor && event['type'] === type,
      );
      if (index !== -1) {
        this.eventCursor = index + 1;
        return this.events[index]!;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await delay(10);
    }
  }
}

interface WireMessage {
  readonly role?: string;
  readonly content?: unknown;
}

function makeChunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: 'chatcmpl-style',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('output style over the wire', () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('replaces the style surface on the next request, differs per style, and persists for new sessions', async () => {
    // Every request gets a plain reply; the captured bodies are the subject.
    const systemPrompts: string[] = [];
    const provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: WireMessage[] };
        const system = parsed.messages?.find((message) => message.role === 'system');
        systemPrompts.push(JSON.stringify(system?.content ?? ''));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse([makeChunk({ content: 'ack' }, null), makeChunk({}, 'stop')]));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-style-home-'));
    const workDir = await mkdtemp(join(tmpdir(), 'cloud-code-style-work-'));
    tempDirs.push(homeDir, workDir);
    const configPath = join(homeDir, 'config.toml');
    await writeFile(
      configPath,
      [
        'default_model = "fake"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${String(port)}/v1"`,
        'api_key = "sk-fake"',
        '',
        '[models.fake]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 1000000',
        '',
      ].join('\n'),
    );
    const host = new ServerHost({ homeDir });
    try {
      const [serverSide, clientSide] = linkedPair();
      host.attach(serverSide);
      const client = new TestClient(clientSide);
      await client.initialize();

      const created = await client.request<{ id: string }>('createSession', { workDir });
      const sessionId = created.id;

      const promptOnce = async (text: string): Promise<string> => {
        const before = systemPrompts.length;
        await client.request('prompt', {
          sessionId,
          agentId: 'main',
          input: [{ type: 'text', text }],
        });
        await client.nextEvent('turn.ended');
        // The main request is the last one (title generation may precede it).
        const fresh = systemPrompts.slice(before);
        expect(fresh.length).toBeGreaterThan(0);
        return fresh.at(-1)!;
      };

      // Baseline: the stock prompt goes out before any switch.
      const stock = await promptOnce('hello');
      expect(stock).toContain(STOCK_COMMUNICATING_ANCHOR);
      expect(stock).toContain(STOCK_DELIVERING_ANCHOR);
      expect(stock).not.toContain('Output style:');

      // The live switch RPC: the very next request carries the concise
      // replacement body and the marker, with the stock communicating body
      // gone (concise defines no delivering-work replacement, so that
      // section stays stock for it).
      await client.request('setOutputStyle', { sessionId, style: 'concise' });
      const concise = await promptOnce('after concise');
      expect(concise).toContain(CONCISE_ANCHOR);
      expect(concise).toContain('Output style: concise');
      expect(concise).not.toContain(STOCK_COMMUNICATING_ANCHOR);

      // A different style produces different bytes again — reviewer replaces
      // both style-surface sections.
      await client.request('setOutputStyle', { sessionId, style: 'reviewer' });
      const reviewer = await promptOnce('after reviewer');
      expect(reviewer).toContain(REVIEWER_ANCHOR);
      expect(reviewer).toContain('Output style: reviewer');
      expect(reviewer).not.toContain(CONCISE_ANCHOR);
      expect(reviewer).not.toContain(STOCK_COMMUNICATING_ANCHOR);
      expect(reviewer).not.toContain(STOCK_DELIVERING_ANCHOR);

      // The persist RPC (what the TUI picker calls after the live switch):
      // output_style lands in config.toml and reads back through the reload.
      await client.request('setCloudCodeConfig', { outputStyle: 'reviewer' });
      const onDisk = await readFile(configPath, 'utf8');
      expect(onDisk).toContain('output_style = "reviewer"');
      const reloaded = await client.request<{ outputStyle?: string }>('getCloudCodeConfig', {});
      expect(reloaded.outputStyle).toBe('reviewer');

      // A session created after the persist starts on the stored style — no
      // picker round-trip needed.
      const second = await client.request<{ id: string }>('createSession', { workDir });
      const secondPrompt = await (async () => {
        const before = systemPrompts.length;
        await client.request('prompt', {
          sessionId: second.id,
          agentId: 'main',
          input: [{ type: 'text', text: 'fresh session' }],
        });
        await client.nextEvent('turn.ended');
        return systemPrompts.slice(before).at(-1)!;
      })();
      expect(secondPrompt).toContain(REVIEWER_ANCHOR);
      expect(secondPrompt).toContain('Output style: reviewer');
      expect(secondPrompt).not.toContain(STOCK_COMMUNICATING_ANCHOR);
    } finally {
      await host.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 120_000);
});
