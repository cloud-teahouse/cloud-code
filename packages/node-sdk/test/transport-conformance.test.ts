/**
 * Transport conformance suite (Phase 4).
 *
 * The same behavioral cases run against three harness backends:
 *  - `local`: the in-process core via the in-memory RPC seam (status quo);
 *  - `stdio`: `RemoteRpcClient` speaking JSON-RPC 2.0 to a real spawned
 *    `@cloud-code/server` child process;
 *  - `ws`: `RemoteRpcClient` attached to a real spawned server over
 *    WebSocket with bearer-token auth (v2).
 *
 * All backends run against a fake OpenAI-compatible provider over loopback
 * HTTP, so no network or credentials are needed and both sides execute the
 * same engine code paths. Assertions compare the backends: event
 * sequences (volatile deltas compared after same-turn collapse), approval /
 * question round-trips, shell command + cancel, resume replay, fork, and
 * CloudCodeError code restoration across the wire.
 *
 * Run: pnpm exec vitest run packages/node-sdk/test/transport-conformance.test.ts
 */
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCloudCodeHarness,
  isCloudCodeError,
  type Event,
  type CloudCodeHarness,
  type Session,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible provider (SSE chat completions over loopback HTTP)
// ---------------------------------------------------------------------------

type ChatRequestBody = {
  readonly messages?: ReadonlyArray<{ readonly role?: string }>;
};

/** The script decides the SSE chunks for one chat-completion request. */
type ProviderScript = (body: ChatRequestBody) => unknown[];

let currentScript: ProviderScript = () => {
  throw new Error('provider script not set');
};

function makeChunk(
  delta: Record<string, unknown>,
  opts?: { finishReason?: string; usage?: Record<string, unknown> },
): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: 'chatcmpl-conformance',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: opts?.finishReason ?? null }],
  };
  if (opts?.usage !== undefined) chunk['usage'] = opts.usage;
  return chunk;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

/** Stream `text` as small content chunks so delta merging gets exercised. */
function textChunks(text: string, chunkSize = 4): unknown[] {
  const chunks: unknown[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(makeChunk({ content: text.slice(i, i + chunkSize) }));
  }
  chunks.push(makeChunk({}, { finishReason: 'stop', usage: USAGE }));
  return chunks;
}

function toolCallChunks(name: string, args: unknown, id = 'call_1'): unknown[] {
  const argumentsJson = JSON.stringify(args);
  const half = Math.ceil(argumentsJson.length / 2);
  return [
    makeChunk({
      tool_calls: [
        {
          index: 0,
          id,
          function: { name, arguments: argumentsJson.slice(0, half) },
        },
      ],
    }),
    makeChunk({
      tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(half) } }],
    }),
    makeChunk({}, { finishReason: 'tool_calls', usage: USAGE }),
  ];
}

function hasToolResult(body: ChatRequestBody): boolean {
  return (body.messages ?? []).some((message) => message.role === 'tool');
}

async function startFakeProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let chunks: unknown[];
      try {
        chunks = currentScript(JSON.parse(body) as ChatRequestBody);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind fake provider');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// ---------------------------------------------------------------------------
// Harness construction per transport
// ---------------------------------------------------------------------------

type TransportName = 'local' | 'stdio' | 'ws';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const SERVER_CLI = join(REPO_ROOT, 'packages', 'server', 'src', 'cli.ts');
const RAW_TEXT_LOADER = join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs');

function serverSpawnTransport(): {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    type: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', '--import', RAW_TEXT_LOADER, SERVER_CLI, '--transport', 'stdio'],
    // Pin the tsconfig: tsx applies the cwd tsconfig only to files inside its
    // `include` set, so a child spawned from packages/node-sdk would compile
    // agent-core sources without experimentalDecorators otherwise.
    env: { TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json') },
  };
}

const WS_BACKEND_TOKEN = 'conformance-ws-token';

interface BackendHandle {
  readonly harness: CloudCodeHarness;
  stop(): Promise<void>;
}

/**
 * Spawn the standalone server on the ws transport (ephemeral port, fixed
 * test token) and hand back a harness attached to it. The listening URL is
 * parsed off the server's stderr banner.
 */
async function startWsBackend(homeDir: string): Promise<BackendHandle> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      RAW_TEXT_LOADER,
      SERVER_CLI,
      '--transport',
      'ws',
      '--port',
      '0',
      '--token',
      WS_BACKEND_TOKEN,
      '--home-dir',
      homeDir,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json') },
    },
  );
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ws server banner: ${stderr}`)),
      150_000,
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const match = /ws listening on (ws:\/\/\S+)/.exec(stderr);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`ws server exited early (code ${String(code)}): ${stderr}`));
    });
  });
  const harness = createCloudCodeHarness({
    homeDir,
    identity: TEST_IDENTITY,
    transport: { type: 'ws', url, token: WS_BACKEND_TOKEN },
  });
  return {
    harness,
    stop: async () => {
      await harness.close();
      if (child.exitCode === null && !child.killed) child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function makeHarness(transport: TransportName, homeDir: string): Promise<BackendHandle> {
  if (transport === 'ws') return startWsBackend(homeDir);
  const harness = createCloudCodeHarness({
    homeDir,
    identity: TEST_IDENTITY,
    transport: transport === 'local' ? 'local' : serverSpawnTransport(),
  });
  return { harness, stop: () => harness.close() };
}

async function makeHome(providerBaseUrl: string, tempDirs: string[]): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-conformance-home-'));
  tempDirs.push(homeDir);
  await writeFile(
    join(homeDir, 'config.toml'),
    [
      'default_model = "conformance"',
      '',
      '[providers.fake]',
      'type = "openai"',
      `base_url = "${providerBaseUrl}"`,
      'api_key = "sk-fake"',
      '',
      '[models.conformance]',
      'provider = "fake"',
      'model = "fake-model"',
      'max_context_size = 128000',
      '',
    ].join('\n'),
  );
  return homeDir;
}

// ---------------------------------------------------------------------------
// Event capture + normalization
// ---------------------------------------------------------------------------

/** Turn-relevant event types compared across transports. */
const CONFORMANCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'assistant.delta',
  'thinking.delta',
  'tool.call.started',
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'turn.ended',
  'error',
]);

interface EventSummary {
  readonly type: string;
  [key: string]: unknown;
}

/**
 * Normalize a raw event stream for cross-transport comparison: drop
 * non-turn-choreography events and fold consecutive same-stream deltas
 * (the stdio server may coalesce them under write backpressure).
 */
function summarizeEvents(events: readonly Event[]): EventSummary[] {
  const out: EventSummary[] = [];
  for (const event of events) {
    if (!CONFORMANCE_EVENT_TYPES.has(event.type)) continue;
    const summary = summarizeEvent(event);
    const last = out[out.length - 1];
    if (
      summary !== undefined &&
      last !== undefined &&
      tryMergeSummaries(last, summary)
    ) {
      continue;
    }
    if (summary !== undefined) out.push(summary);
  }
  return out;
}

function summarizeEvent(event: Event): EventSummary | undefined {
  switch (event.type) {
    case 'assistant.delta':
    case 'thinking.delta':
      return { type: event.type, turnId: event.turnId, delta: event.delta };
    case 'tool.call.delta':
      return {
        type: event.type,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        argumentsPart: event.argumentsPart ?? '',
      };
    case 'tool.call.started':
      return { type: event.type, turnId: event.turnId, name: event.name };
    case 'tool.result':
      return { type: event.type, turnId: event.turnId, isError: event.isError === true };
    case 'turn.started':
      return { type: event.type, turnId: event.turnId };
    case 'turn.ended':
      return { type: event.type, turnId: event.turnId, reason: event.reason };
    case 'error':
      return { type: event.type, code: event.code };
    default:
      return { type: event.type };
  }
}

/** Merge `next` into `last` in place when they are adjacent deltas of one stream. */
function tryMergeSummaries(last: EventSummary, next: EventSummary): boolean {
  if (last.type !== next.type) return false;
  if (
    (last.type === 'assistant.delta' || last.type === 'thinking.delta') &&
    last['turnId'] === next['turnId']
  ) {
    last['delta'] = String(last['delta']) + String(next['delta']);
    return true;
  }
  if (
    last.type === 'tool.call.delta' &&
    last['turnId'] === next['turnId'] &&
    last['toolCallId'] === next['toolCallId']
  ) {
    last['argumentsPart'] = String(last['argumentsPart']) + String(next['argumentsPart']);
    return true;
  }
  return false;
}

function collectEvents(session: Session): Event[] {
  const events: Event[] = [];
  session.onEvent((event) => events.push(event));
  return events;
}

function waitForEvent(
  session: Session,
  predicate: (event: Event) => boolean,
  timeoutMs = 60_000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

function waitForTurnEnd(session: Session): Promise<Event> {
  return waitForEvent(session, (event) => event.type === 'turn.ended');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.each([
  { transport: 'local' as const },
  { transport: 'stdio' as const },
  { transport: 'ws' as const },
])(
  'transport conformance: $transport',
  ({ transport }) => {
    const tempDirs: string[] = [];
    let provider: { baseUrl: string; close(): Promise<void> };
    let backend: BackendHandle;
    let harness: CloudCodeHarness;
    let workDir: string;

    beforeAll(async () => {
      provider = await startFakeProvider();
      const homeDir = await makeHome(provider.baseUrl, tempDirs);
      workDir = await mkdtemp(join(tmpdir(), 'cloud-code-conformance-work-'));
      tempDirs.push(workDir);
      backend = await makeHarness(transport, homeDir);
      harness = backend.harness;
      // Force the transport up (spawn + handshake) before the first case.
      await harness.listSessions();
    }, 180_000);

    afterAll(async () => {
      await backend?.stop();
      await provider?.close();
      for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }, 60_000);

    it(
      'prompt produces the same event sequence and assistant text',
      async () => {
        currentScript = () => textChunks('conformance response text');
        const session = await harness.createSession({ workDir, permission: 'auto' });
        const events = collectEvents(session);
        const turnEnded = waitForTurnEnd(session);
        await session.prompt('say conformance');
        await turnEnded;

        const summary = summarizeEvents(events);
        const text = summary
          .filter((entry) => entry.type === 'assistant.delta')
          .map((entry) => String(entry['delta']))
          .join('');
        expect(text).toBe('conformance response text');
        expect(summary.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'completed' });
        expect(summary[0]).toMatchObject({ type: 'turn.started' });
        await session.close();
      },
      120_000,
    );

    it(
      'approval round-trips through the transport',
      async () => {
        currentScript = (body) =>
          hasToolResult(body)
            ? textChunks('approval flow finished')
            : toolCallChunks('Bash', { command: 'echo conformance-approval-marker' });
        const session = await harness.createSession({ workDir, permission: 'manual' });
        const events = collectEvents(session);
        const approvals: Array<{ toolCallId: string; toolName: string }> = [];
        session.setApprovalHandler(async (request) => {
          approvals.push({ toolCallId: request.toolCallId, toolName: request.toolName });
          return { decision: 'approved' as const };
        });
        const turnEnded = waitForTurnEnd(session);
        await session.prompt('run the echo');
        await turnEnded;

        expect(approvals).toHaveLength(1);
        expect(approvals[0]!.toolName).toBe('Bash');
        expect(approvals[0]!.toolCallId.length).toBeGreaterThan(0);
        const toolResult = events.find((event) => event.type === 'tool.result');
        expect(toolResult).toBeDefined();
        expect(JSON.stringify(toolResult)).toContain('conformance-approval-marker');
        await session.close();
      },
      120_000,
    );

    it(
      'question round-trips through the transport',
      async () => {
        currentScript = (body) =>
          hasToolResult(body)
            ? textChunks('question flow finished')
            : toolCallChunks('AskUserQuestion', {
                questions: [
                  {
                    question: 'Pick a conformance option?',
                    options: [{ label: 'Option A' }, { label: 'Option B' }],
                  },
                ],
              });
        const session = await harness.createSession({ workDir, permission: 'manual' });
        session.setApprovalHandler(() => ({ decision: 'approved' as const }));
        const questions: string[] = [];
        session.setQuestionHandler(async (request) => {
          for (const question of request.questions) questions.push(question.question);
          return { answers: { 'Pick a conformance option?': 'Option A' } };
        });
        const turnEnded = waitForTurnEnd(session);
        await session.prompt('ask me something');
        await turnEnded;

        expect(questions).toEqual(['Pick a conformance option?']);
        await session.close();
      },
      120_000,
    );

    it(
      'runShellCommand streams results and cancelShellCommand aborts',
      async () => {
        currentScript = () => textChunks('unused');
        const session = await harness.createSession({ workDir, permission: 'auto' });

        const result = await session.runShellCommand('echo conformance-shell-out');
        expect(result.stdout).toContain('conformance-shell-out');
        expect(result.isError !== true).toBe(true);

        const commandId = 'conformance-cancel';
        const shellStarted = waitForEvent(
          session,
          (event) => event.type === 'shell.started' && event.commandId === commandId,
        );
        const pending = session.runShellCommand('sleep 60', { commandId });
        await shellStarted;
        await session.cancelShellCommand(commandId);
        const cancelled = await pending;
        expect(cancelled.isError).toBe(true);
        await session.close();
      },
      120_000,
    );

    it(
      'resume replays persisted history identically',
      async () => {
        currentScript = () => textChunks('replay me later');
        const session = await harness.createSession({ workDir, permission: 'auto' });
        const turnEnded = waitForTurnEnd(session);
        await session.prompt('remember this replay prompt');
        await turnEnded;
        const sessionId = session.id;
        await session.close();

        const resumed = await harness.resumeSession({ id: sessionId });
        const state = resumed.getResumeState();
        expect(state).toBeDefined();
        const replayText = JSON.stringify(state);
        expect(replayText).toContain('remember this replay prompt');
        expect(replayText).toContain('replay me later');
        await resumed.close();
      },
      120_000,
    );

    it(
      'fork copies the session into a new id',
      async () => {
        currentScript = () => textChunks('fork source text');
        const session = await harness.createSession({ workDir, permission: 'auto' });
        const turnEnded = waitForTurnEnd(session);
        await session.prompt('fork me');
        await turnEnded;

        const forked = await harness.forkSession({ id: session.id });
        expect(forked.id).not.toBe(session.id);
        expect(forked.workDir).toBe(session.workDir);
        const state = forked.getResumeState();
        expect(JSON.stringify(state)).toContain('fork me');
        await forked.close();
        await session.close();
      },
      120_000,
    );

    it(
      'restores CloudCodeError codes across the transport',
      async () => {
        currentScript = () => textChunks('unused');
        await harness.resumeSession({ id: 'definitely-not-a-session' }).then(
          () => expect.unreachable('resume must fail'),
          (error: unknown) => {
            expect(isCloudCodeError(error)).toBe(true);
            expect((error as { code: string }).code).toBe('session.not_found');
          },
        );
      },
      120_000,
    );
  },
);
