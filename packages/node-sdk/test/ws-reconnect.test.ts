/**
 * SDK-level ws reconnect acceptance (design §4 v2): a harness attached over
 * ws drops; a NEW harness attached to the same daemon resumes the session —
 * the resumeSession snapshot carries the terminal state (不丢终态) and the
 * new connection takes over approvals (订阅/审批恢复).
 *
 * Run: pnpm exec vitest run packages/node-sdk/test/ws-reconnect.test.ts
 */
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCloudCodeHarness, type Event, type CloudCodeHarness, type Session } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const WS_TOKEN = 'ws-reconnect-sdk-token';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const SERVER_CLI = join(REPO_ROOT, 'packages', 'server', 'src', 'cli.ts');
const RAW_TEXT_LOADER = join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs');

// ---------------------------------------------------------------------------
// Fake provider (title / approval-tool / plain-text scripting)
// ---------------------------------------------------------------------------

function makeChunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-sdk-reconnect',
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
          id: 'call_sdk_reconnect',
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

describe('ws reconnect at the harness level (design §4 v2)', () => {
  const tempDirs: string[] = [];
  let provider: http.Server;
  let serverChild: ChildProcess;
  let serverUrl: string;
  let workDir: string;
  let homeDir: string;

  function makeHarness(): CloudCodeHarness {
    return createCloudCodeHarness({
      homeDir,
      identity: TEST_IDENTITY,
      transport: { type: 'ws', url: serverUrl, token: WS_TOKEN },
    });
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
          payload = textSse('sdk reconnect title');
        } else if (messages.some((m) => m.role === 'tool')) {
          payload = textSse('approval turn done');
        } else if (conversationText.includes('approval turn')) {
          payload = bashSse('echo sdk-reconnect-marker');
        } else {
          payload = textSse('first turn final text');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    const providerPort = typeof address === 'object' && address !== null ? address.port : 0;

    homeDir = await mkdtemp(join(tmpdir(), 'cloud-code-sdk-reconnect-home-'));
    tempDirs.push(homeDir);
    workDir = await mkdtemp(join(tmpdir(), 'cloud-code-sdk-reconnect-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "reconnect"',
        '',
        '[providers.fake]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${providerPort}/v1"`,
        'api_key = "sk-fake"',
        '',
        '[models.reconnect]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 128000',
        '',
      ].join('\n'),
    );

    serverChild = spawn(
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
        WS_TOKEN,
        '--home-dir',
        homeDir,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json') },
      },
    );
    let stderr = '';
    serverUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ws server banner: ${stderr}`)),
        150_000,
      );
      serverChild.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const match = /ws listening on (ws:\/\/\S+)/.exec(stderr);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      serverChild.on('exit', (code) => {
        reject(new Error(`ws server exited early (code ${String(code)}): ${stderr}`));
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (serverChild !== undefined && serverChild.exitCode === null && !serverChild.killed) {
      serverChild.kill();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      serverChild?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  function waitForTurnEnd(session: Session): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for turn.ended'));
      }, 60_000);
      const unsubscribe = session.onEvent((event) => {
        if (event.type !== 'turn.ended') return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  it('recovers a dropped client via a fresh harness + resumeSession', async () => {
    // Harness 1: run turn 1 to completion, then drop the connection.
    const harness1 = makeHarness();
    const session1 = await harness1.createSession({ workDir, permission: 'auto' });
    const firstTurnEnded = waitForTurnEnd(session1);
    await session1.prompt('first turn please');
    await firstTurnEnded;
    const sessionId = session1.id;
    await harness1.close();

    // Harness 2 (the "reconnect"): resumeSession re-claims the session and
    // its snapshot carries the terminal state accumulated before the drop.
    const harness2 = makeHarness();
    const session2 = await harness2.resumeSession({ id: sessionId });
    const state = session2.getResumeState();
    expect(JSON.stringify(state)).toContain('first turn final text');

    // Subscription + approval routing are restored on the new connection.
    await session2.setPermission('manual');
    const approvals: string[] = [];
    session2.setApprovalHandler((request) => {
      approvals.push(request.toolName);
      return Promise.resolve({ decision: 'approved' as const });
    });
    const secondTurnEnded = waitForTurnEnd(session2);
    await session2.prompt('approval turn please');
    await secondTurnEnded;
    expect(approvals).toEqual(['Bash']);

    await harness2.close();
  }, 120_000);
});
