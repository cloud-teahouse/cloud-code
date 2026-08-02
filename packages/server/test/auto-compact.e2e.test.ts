/**
 * Auto-compaction end to end over the real server wire path (loopback HTTP
 * provider -> kosong -> agent loop -> JSON-RPC events), pinning the trigger
 * behavior behind the production report "context hits 99% and auto-compaction
 * never fires":
 *
 *   - crossing the strategy trigger fires a full auto-compaction at the next
 *     step boundary, and the summarizer request really goes out;
 *   - with a usage-reporting provider, graduated layers must keep extending
 *     as the history grows. The covered token count is then provider-reported
 *     and already net of the armed rewrites; subtracting the same savings
 *     again (the old behavior) stalled extension and deferred the
     full-compaction escalation past the provider's own window;
 *   - with a usage-blind provider (third-party proxies that strip `usage`),
 *     the stored history can exceed 99% of the window while the projection
 *     the model receives stays managed — the status surface must report the
 *     same effective count the trigger sees instead of the raw stored count.
 */
import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { ServerHost } from '../src/host';
import { JsonRpcConnection } from '../src/jsonrpc/connection';

// ~25KB of model-visible output: folded so no line trips the Bash tool's
// per-line truncation, and well under the 50KB whole-result cap.
const PROBE_COMMAND = "head -c 25000 /dev/zero | tr '\\0' 'a' | fold -w 1000";
const BIG_REPLY_CHARS = 100_000;

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

  /** Wait for the next event of `type` after the previous consumption point. */
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

  eventsOfType(type: string): Array<Record<string, unknown>> {
    return this.events.filter((event) => event['type'] === type);
  }

  lastStatusUsage(): number | undefined {
    const statuses = this.eventsOfType('agent.status.updated');
    const last = statuses.at(-1);
    return last === undefined ? undefined : (last['contextUsage'] as number);
  }
}

interface WireMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

interface CapturedRequest {
  readonly messages: WireMessage[];
  /** Estimated prompt tokens over non-system messages (chars/4). */
  readonly estimate: number;
}

function messageText(message: WireMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content ?? '');
}

function makeChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): Record<string, unknown> {
  return {
    id: 'chatcmpl-auto-compact',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

interface MockProvider {
  readonly requests: CapturedRequest[];
  readonly url: string;
  close(): Promise<void>;
}

async function startMockProvider(options: {
  readonly reportUsage: boolean;
}): Promise<MockProvider> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: WireMessage[] };
      const messages = parsed.messages ?? [];
      // Usage mirrors the trigger's basis: conversation messages only, not
      // the system prompt.
      const nonSystem = messages.filter((message) => message.role !== 'system');
      const estimate = Math.ceil(JSON.stringify(nonSystem).length / 4);
      requests.push({ messages, estimate });

      const systemText = messageText(messages[0]);
      const last = messages.at(-1);
      // Reminder injections append `<system-reminder>` user messages after the
      // real prompt; the meaningful marker rides the last non-reminder one.
      const effectiveLast =
        messages.findLast(
          (message) =>
            message.role === 'user' && !messageText(message).startsWith('<system-reminder>'),
        ) ?? last;
      const lastText = messageText(effectiveLast);
      let replyText: string;
      let toolCall = false;
      if (systemText.includes('sentence-case title')) {
        replyText = 'auto compact title';
      } else if (effectiveLast?.role === 'user' && lastText.includes('out of context')) {
        // The compaction instruction rides the final user message.
        replyText = 'Compacted summary of the work so far.';
      } else if (last?.role === 'tool') {
        replyText = 'probe recorded';
      } else if (effectiveLast?.role === 'user' && lastText.includes('run probe')) {
        toolCall = true;
        replyText = '';
      } else if (effectiveLast?.role === 'user' && lastText === 'start') {
        replyText = 'a'.repeat(BIG_REPLY_CHARS);
      } else if (effectiveLast?.role === 'user' && lastText === 'continue') {
        replyText = 'b'.repeat(BIG_REPLY_CHARS);
      } else {
        replyText = 'plain reply';
      }

      const usage = options.reportUsage
        ? {
            prompt_tokens: estimate,
            completion_tokens: Math.max(1, Math.ceil(replyText.length / 4)),
            total_tokens: estimate + Math.max(1, Math.ceil(replyText.length / 4)),
          }
        : undefined;
      const chunks = toolCall
        ? [
            makeChunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_probe_${String(requests.length)}`,
                    function: { name: 'Bash', arguments: JSON.stringify({ command: PROBE_COMMAND }) },
                  },
                ],
              },
              null,
              usage,
            ),
            makeChunk({}, 'tool_calls', usage),
          ]
        : [makeChunk({ content: replyText }, null, usage), makeChunk({}, 'stop', usage)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    requests,
    url: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Main-conversation requests (session-title generation excluded). */
function mainRequests(provider: MockProvider): CapturedRequest[] {
  return provider.requests.filter(
    (request) => !messageText(request.messages[0]).includes('sentence-case title'),
  );
}

describe('auto-compaction over the wire', () => {
  const tempDirs: string[] = [];

  async function setup(options: {
    readonly maxContextSize: number;
    readonly reportUsage: boolean;
  }): Promise<{ client: TestClient; provider: MockProvider; host: ServerHost; workDir: string }> {
    const provider = await startMockProvider({ reportUsage: options.reportUsage });
    const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-autocompact-home-'));
    const workDir = await mkdtemp(join(tmpdir(), 'cloud-code-autocompact-work-'));
    tempDirs.push(homeDir, workDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "fake"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "${provider.url}"`,
        'api_key = "sk-fake"',
        '',
        '[models.fake]',
        'provider = "fake"',
        'model = "fake-model"',
        `max_context_size = ${String(options.maxContextSize)}`,
        '',
        // Pin the full-compaction trigger to the pure ratio (0.85) so the
        // absolute reserved-output headroom does not pre-empt the cheaper
        // graduated layers at these small test window sizes.
        '[loop_control]',
        'reserved_context_size = 0',
        '',
      ].join('\n'),
    );
    const host = new ServerHost({ homeDir });
    const [serverSide, clientSide] = linkedPair();
    host.attach(serverSide);
    const client = new TestClient(clientSide);
    await client.initialize();
    return { client, provider, host, workDir };
  }

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fires full auto-compaction at a step boundary once context crosses the trigger', async () => {
    const { client, provider, host, workDir } = await setup({
      maxContextSize: 40_000,
      reportUsage: true,
    });
    try {
      const created = await client.request<{ id: string }>('createSession', {
        workDir,
        permission: 'auto',
      });
      const sessionId = created.id;

      // Turn 1 lands at ~25k/40k = 62%: below the 70% arm and the 85% trigger.
      await client.request('prompt', {
        sessionId,
        agentId: 'main',
        input: [{ type: 'text', text: 'start' }],
      });
      await client.nextEvent('turn.ended');
      expect(client.eventsOfType('compaction.started')).toHaveLength(0);

      // Turn 2 carries the count past the trigger, but the crossing only
      // becomes visible at the NEXT step boundary.
      await client.request('prompt', {
        sessionId,
        agentId: 'main',
        input: [{ type: 'text', text: 'continue' }],
      });
      await client.nextEvent('turn.ended');
      expect(client.eventsOfType('compaction.started')).toHaveLength(0);

      // Turn 3's first step boundary must compact before the request goes out.
      await client.request('prompt', {
        sessionId,
        agentId: 'main',
        input: [{ type: 'text', text: 'go' }],
      });
      await client.nextEvent('turn.ended', 60_000);

      const started = client.eventsOfType('compaction.started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ trigger: 'auto' });
      expect(client.eventsOfType('compaction.completed')).toHaveLength(1);

      // The summarizer request really reached the provider, with the
      // handoff instruction as its final message.
      const compactionRequest = provider.requests.find((request) =>
        messageText(request.messages.at(-1)).includes('out of context'),
      );
      expect(compactionRequest).toBeDefined();

      // The wire continued from the compacted context: the summary, not the
      // 100k-char assistant replies, is what later requests carry.
      const finalRequest = mainRequests(provider).at(-1)!;
      const finalText = JSON.stringify(finalRequest.messages);
      expect(finalText).toContain('Compacted summary of the work so far.');
      expect(finalText).not.toContain('a'.repeat(10_000));

      const context = await client.request<{ tokenCount: number }>('getContext', {
        sessionId,
        agentId: 'main',
      });
      expect(context.tokenCount).toBeLessThan(10_000);
    } finally {
      await host.close();
      await provider.close();
    }
  }, 90_000);

  it('keeps the projection managed and the status honest while stored history exceeds the window (usage-reporting provider)', async () => {
    const window = 80_000;
    const { client, provider, host, workDir } = await setup({
      maxContextSize: window,
      reportUsage: true,
    });
    try {
      const created = await client.request<{ id: string }>('createSession', {
        workDir,
        permission: 'auto',
      });
      const sessionId = created.id;

      // 20 probe turns, each adding a ~25KB (~6k token) tool result: stored
      // history grows well past the window while graduated layers rewrite
      // the old results out of the projection.
      for (let round = 1; round <= 20; round++) {
        await client.request('prompt', {
          sessionId,
          agentId: 'main',
          input: [{ type: 'text', text: `run probe ${String(round)}` }],
        });
        await client.nextEvent('turn.ended', 60_000);
      }

      // The cheap layers handled the pressure: no LLM full compaction was
      // needed, and no request ever crossed the window. (With the savings
      // double-counted, extension stalled and requests blew past the window
      // while the escalation point ran away past it too.)
      expect(client.eventsOfType('compaction.started')).toHaveLength(0);
      const requests = mainRequests(provider);
      const peak = Math.max(...requests.map((request) => request.estimate));
      expect(peak).toBeGreaterThan(56_000); // the 70% arm really engaged
      expect(peak).toBeLessThan(window * 0.85); // and the projection stayed managed
      for (const request of requests) {
        expect(request.estimate).toBeLessThan(window);
      }

      // The status surface reports the effective count the trigger sees — it
      // must not park at ~99% while the projection is managed.
      const lastUsage = client.lastStatusUsage();
      expect(lastUsage).toBeDefined();
      expect(lastUsage!).toBeLessThan(0.85);
    } finally {
      await host.close();
      await provider.close();
    }
  }, 180_000);

  it('reports the effective count on the status surface for a usage-blind provider', async () => {
    const window = 80_000;
    const { client, provider, host, workDir } = await setup({
      maxContextSize: window,
      reportUsage: false,
    });
    try {
      const created = await client.request<{ id: string }>('createSession', {
        workDir,
        permission: 'auto',
      });
      const sessionId = created.id;

      for (let round = 1; round <= 20; round++) {
        await client.request('prompt', {
          sessionId,
          agentId: 'main',
          input: [{ type: 'text', text: `run probe ${String(round)}` }],
        });
        await client.nextEvent('turn.ended', 60_000);
      }

      // With no provider-reported usage the stored count is estimate-based
      // and keeps every byte: it legitimately exceeds 99% of the window.
      const context = await client.request<{ tokenCount: number }>('getContext', {
        sessionId,
        agentId: 'main',
      });
      expect(context.tokenCount).toBeGreaterThan(window * 0.99);

      // Full compaction correctly stays out of it — the armed layers keep
      // the projection the model receives far below the trigger...
      expect(client.eventsOfType('compaction.started')).toHaveLength(0);
      for (const request of mainRequests(provider)) {
        expect(request.estimate).toBeLessThan(window);
      }

      // ...and the status surface says so, instead of screaming 99%.
      const lastUsage = client.lastStatusUsage();
      expect(lastUsage).toBeDefined();
      expect(lastUsage!).toBeLessThan(0.85);
    } finally {
      await host.close();
      await provider.close();
    }
  }, 180_000);
});
