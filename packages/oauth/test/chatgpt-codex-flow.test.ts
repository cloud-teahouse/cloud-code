/**
 * ChatGPT authorization-code + PKCE flow tests.
 *
 * Everything runs against a local fake OpenAI issuer server (token exchange
 * / refresh / revoke) and the real localhost callback server bound to
 * test-chosen ports — no real network access.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_CODEX_CLIENT_ID,
  CHATGPT_CODEX_ISSUER,
  CHATGPT_CODEX_SCOPE,
} from '../src/chatgpt-codex';
import {
  buildChatGptAuthorizeUrl,
  exchangeChatGptAuthorizationCode,
  generateOAuthState,
  generatePkce,
  jwtExpiresAt,
  parseChatGptAuthorizationInput,
  parseChatGptIdTokenClaims,
  refreshChatGptAccessToken,
  revokeChatGptToken,
  runChatGptCodexLoginFlow,
  startChatGptCallbackServer,
} from '../src/chatgpt-codex-flow';
import { OAuthError, OAuthUnauthorizedError, RetryableRefreshError } from '../src/errors';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.test-signature`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
}

class FakeOpenAIServer {
  private server: Server | undefined;
  readonly recorded: RecordedRequest[] = [];
  issuer = '';

  /** Queue of responses per `POST <path>`; the last one repeats when drained. */
  private readonly responses = new Map<string, Array<{ status: number; body: unknown }>>();
  /** Optional hook invoked per request before the queued response is sent. */
  onRequest: ((req: RecordedRequest) => void) | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          contentType: req.headers['content-type'] ?? '',
          body,
        };
        this.recorded.push(recorded);
        this.onRequest?.(recorded);
        const key = `${recorded.method} ${recorded.path}`;
        const queue = this.responses.get(key);
        const next = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
        const status = next?.status ?? 404;
        const payload = next?.body ?? { error: 'not_found' };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  enqueue(method: string, path: string, status: number, body: unknown): void {
    const key = `${method} ${path}`;
    const queue = this.responses.get(key) ?? [];
    queue.push({ status, body });
    this.responses.set(key, queue);
  }

  reset(): void {
    this.recorded.length = 0;
    this.responses.clear();
    this.onRequest = undefined;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });
  }
}

describe('generatePkce / generateOAuthState', () => {
  it('produces a base64url verifier and its S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    // 64 random bytes → 86 base64url chars, unpadded.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // SHA-256 → 43 base64url chars, unpadded.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = Buffer.from(createHash('sha256').update(verifier).digest()).toString(
      'base64url',
    );
    expect(challenge).toBe(expected);
  });

  it('generates unique pairs per call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('generates a 32-byte base64url state', () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toBe(generateOAuthState());
  });
});

describe('buildChatGptAuthorizeUrl', () => {
  it('contains the full §1.1 parameter set', () => {
    const url = new URL(
      buildChatGptAuthorizeUrl({
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 'state-123',
        codeChallenge: 'challenge-abc',
      }),
    );
    expect(url.origin).toBe(CHATGPT_CODEX_ISSUER);
    expect(url.pathname).toBe('/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CHATGPT_CODEX_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(p.get('scope')).toBe(CHATGPT_CODEX_SCOPE);
    expect(p.get('scope')).toBe(
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    );
    expect(p.get('code_challenge')).toBe('challenge-abc');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('id_token_add_organizations')).toBe('true');
    expect(p.get('codex_cli_simplified_flow')).toBe('true');
    expect(p.get('state')).toBe('state-123');
    expect(p.get('originator')).toBe('codex_cli_rs');
    expect(p.get('allowed_workspace_id')).toBeNull();
    expect(p.get('audience')).toBeNull();
  });

  it('passes allowed_workspace_id through when given', () => {
    const url = new URL(
      buildChatGptAuthorizeUrl({
        redirectUri: 'http://localhost:1457/auth/callback',
        state: 's',
        codeChallenge: 'c',
        allowedWorkspaceId: 'ws-1,ws-2',
      }),
    );
    expect(url.searchParams.get('allowed_workspace_id')).toBe('ws-1,ws-2');
  });
});

describe('JWT claim parsing', () => {
  it('extracts ChatGPT claims from the auth namespace', () => {
    const idToken = makeJwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-123',
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'user-456',
      },
    });
    expect(parseChatGptIdTokenClaims(idToken)).toEqual({
      accountId: 'acct-123',
      planType: 'pro',
      userId: 'user-456',
      email: 'user@example.com',
    });
  });

  it('falls back to profile-namespace email and user_id', () => {
    const idToken = makeJwt({
      'https://api.openai.com/profile': { email: 'profile@example.com' },
      'https://api.openai.com/auth': { user_id: 'user-789' },
    });
    const claims = parseChatGptIdTokenClaims(idToken);
    expect(claims.email).toBe('profile@example.com');
    expect(claims.userId).toBe('user-789');
    expect(claims.accountId).toBeUndefined();
  });

  it('returns empty claims for malformed tokens', () => {
    expect(parseChatGptIdTokenClaims('not-a-jwt')).toEqual({});
    expect(parseChatGptIdTokenClaims('a.b.c')).toEqual({});
  });

  it('parses exp from a JWT access token', () => {
    const token = makeJwt({ exp: 1_900_000_000 });
    expect(jwtExpiresAt(token)).toBe(1_900_000_000);
    expect(jwtExpiresAt(makeJwt({ sub: 'x' }))).toBeUndefined();
    expect(jwtExpiresAt('opaque-token')).toBeUndefined();
  });
});

describe('parseChatGptAuthorizationInput', () => {
  it('parses a full callback URL', () => {
    expect(
      parseChatGptAuthorizationInput(
        'http://localhost:1455/auth/callback?code=code-1&state=state-1',
      ),
    ).toEqual({ code: 'code-1', state: 'state-1' });
  });

  it('accepts a bare authorization code', () => {
    expect(parseChatGptAuthorizationInput('  code-xyz  ')).toEqual({
      code: 'code-xyz',
      state: undefined,
    });
  });

  it('surfaces provider errors embedded in the URL', () => {
    expect(() =>
      parseChatGptAuthorizationInput(
        'http://localhost:1455/auth/callback?error=access_denied&error_description=nope',
      ),
    ).toThrow(OAuthError);
  });

  it('rejects URLs without a code and free-form garbage', () => {
    expect(() => parseChatGptAuthorizationInput('http://localhost:1455/auth/callback')).toThrow(
      OAuthError,
    );
    expect(() => parseChatGptAuthorizationInput('two words')).toThrow(OAuthError);
    expect(() => parseChatGptAuthorizationInput('   ')).toThrow(OAuthError);
  });
});

describe('startChatGptCallbackServer', () => {
  let servers: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close().catch(() => {});
    }
  });

  it('serves the callback and resolves with the code', async () => {
    const port = await freePort();
    const server = await startChatGptCallbackServer({ state: 'state-ok', ports: [port] });
    servers.push(server);
    expect(server.port).toBe(port);
    expect(server.redirectUri).toBe(`http://localhost:${port}/auth/callback`);

    const waiting = server.waitForCallback();
    const response = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=code-42&state=state-ok`,
    );
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'code-42', state: 'state-ok' });
  });

  it('rejects a mismatched state with 400 but keeps waiting', async () => {
    const port = await freePort();
    const server = await startChatGptCallbackServer({ state: 'expected', ports: [port] });
    servers.push(server);
    const waiting = server.waitForCallback();

    const bad = await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=WRONG`);
    expect(bad.status).toBe(400);

    const good = await fetch(`http://127.0.0.1:${port}/auth/callback?code=ok&state=expected`);
    expect(good.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'ok', state: 'expected' });
  });

  it('falls back to the next port when the first is occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const blockedPort = (blocker.address() as AddressInfo).port;
    const fallback = await freePort();
    try {
      const server = await startChatGptCallbackServer({
        state: 's',
        ports: [blockedPort, fallback],
      });
      servers.push(server);
      expect(server.port).toBe(fallback);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
        resolve();
      });
      });
    }
  });

  it('fails when every allow-listed port is occupied', async () => {
    const blockerA = createServer();
    const blockerB = createServer();
    await new Promise<void>((resolve) => blockerA.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => blockerB.listen(0, '127.0.0.1', resolve));
    const portA = (blockerA.address() as AddressInfo).port;
    const portB = (blockerB.address() as AddressInfo).port;
    try {
      await expect(startChatGptCallbackServer({ state: 's', ports: [portA, portB] })).rejects.toBeInstanceOf(
        OAuthError,
      );
    } finally {
      await new Promise<void>((resolve) => blockerA.close(() => {
          resolve();
        }));
      await new Promise<void>((resolve) => blockerB.close(() => {
          resolve();
        }));
    }
  });

  it('rejects the wait when /cancel is hit', async () => {
    const port = await freePort();
    const server = await startChatGptCallbackServer({ state: 's', ports: [port] });
    servers.push(server);
    const waiting = server.waitForCallback();
    waiting.catch(() => {});
    const response = await fetch(`http://127.0.0.1:${port}/cancel`);
    expect(response.status).toBe(200);
    await expect(waiting).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects the wait when the caller aborts', async () => {
    const port = await freePort();
    const server = await startChatGptCallbackServer({ state: 's', ports: [port] });
    servers.push(server);
    const controller = new AbortController();
    const waiting = server.waitForCallback({ signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
  });
});

describe('exchangeChatGptAuthorizationCode', () => {
  const fake = new FakeOpenAIServer();

  beforeEach(async () => {
    fake.reset();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('posts the form-encoded exchange and maps all three tokens', async () => {
    fake.enqueue('POST', '/oauth/token', 200, {
      id_token: makeJwt({ sub: 'u' }),
      access_token: makeJwt({ exp: 1_900_000_000 }),
      refresh_token: 'refresh-1',
    });
    const bundle = await exchangeChatGptAuthorizationCode({
      issuer: fake.issuer,
      code: 'code-1',
      redirectUri: 'http://localhost:1455/auth/callback',
      codeVerifier: 'verifier-1',
    });
    expect(bundle.refreshToken).toBe('refresh-1');

    const request = fake.recorded[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/oauth/token');
    expect(request.contentType).toContain('application/x-www-form-urlencoded');
    const params = new URLSearchParams(request.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('code-1');
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(params.get('client_id')).toBe(CHATGPT_CODEX_CLIENT_ID);
    expect(params.get('code_verifier')).toBe('verifier-1');
  });

  it('rejects responses missing any of the three tokens', async () => {
    fake.enqueue('POST', '/oauth/token', 200, {
      access_token: 'a',
      refresh_token: 'r',
    });
    await expect(
      exchangeChatGptAuthorizationCode({
        issuer: fake.issuer,
        code: 'c',
        redirectUri: 'http://localhost:1455/auth/callback',
        codeVerifier: 'v',
      }),
    ).rejects.toThrow(/id_token/);
  });

  it('surfaces provider error details on non-200', async () => {
    fake.enqueue('POST', '/oauth/token', 400, {
      error: 'invalid_grant',
      error_description: 'code expired',
    });
    await expect(
      exchangeChatGptAuthorizationCode({
        issuer: fake.issuer,
        code: 'c',
        redirectUri: 'http://localhost:1455/auth/callback',
        codeVerifier: 'v',
      }),
    ).rejects.toThrow(/code expired/);
  });
});

describe('refreshChatGptAccessToken', () => {
  const fake = new FakeOpenAIServer();
  const noSleep = (): Promise<void> => Promise.resolve();

  beforeEach(async () => {
    fake.reset();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('sends a JSON (not form) refresh request', async () => {
    fake.enqueue('POST', '/oauth/token', 200, {
      access_token: makeJwt({ exp: 1_900_000_000 }),
      refresh_token: 'rotated',
    });
    const result = await refreshChatGptAccessToken({
      issuer: fake.issuer,
      refreshToken: 'old-refresh',
      sleep: noSleep,
    });
    expect(result.refreshToken).toBe('rotated');
    expect(result.accessToken).toBeDefined();

    const request = fake.recorded[0]!;
    expect(request.contentType).toContain('application/json');
    expect(JSON.parse(request.body)).toEqual({
      client_id: CHATGPT_CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it('maps the all-optional response fields', async () => {
    fake.enqueue('POST', '/oauth/token', 200, {});
    const result = await refreshChatGptAccessToken({
      issuer: fake.issuer,
      refreshToken: 'r',
      sleep: noSleep,
    });
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    expect(result.idToken).toBeUndefined();
  });

  it.each([
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
  ])('treats %s as a permanent unauthorized failure', async (code) => {
    fake.enqueue('POST', '/oauth/token', 400, { error: code });
    await expect(
      refreshChatGptAccessToken({ issuer: fake.issuer, refreshToken: 'r', sleep: noSleep }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('also reads the error code from a nested error object', async () => {
    fake.enqueue('POST', '/oauth/token', 400, {
      error: { code: 'refresh_token_reused', message: 'rotation race' },
    });
    await expect(
      refreshChatGptAccessToken({ issuer: fake.issuer, refreshToken: 'r', sleep: noSleep }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('treats 401/403 as unauthorized', async () => {
    fake.enqueue('POST', '/oauth/token', 401, { error: 'unauthorized' });
    await expect(
      refreshChatGptAccessToken({ issuer: fake.issuer, refreshToken: 'r', sleep: noSleep }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('retries 5xx with backoff before surfacing RetryableRefreshError', async () => {
    fake.enqueue('POST', '/oauth/token', 500, { error: 'boom' });
    fake.enqueue('POST', '/oauth/token', 500, { error: 'boom' });
    fake.enqueue('POST', '/oauth/token', 500, { error: 'boom' });
    await expect(
      refreshChatGptAccessToken({
        issuer: fake.issuer,
        refreshToken: 'r',
        sleep: noSleep,
        backoffMs: () => 0,
      }),
    ).rejects.toBeInstanceOf(RetryableRefreshError);
    expect(fake.recorded).toHaveLength(3);
  });
});

describe('revokeChatGptToken', () => {
  const fake = new FakeOpenAIServer();

  beforeEach(async () => {
    fake.reset();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('posts the revocation as JSON and reports success', async () => {
    fake.enqueue('POST', '/oauth/revoke', 200, {});
    await expect(
      revokeChatGptToken({
        issuer: fake.issuer,
        token: 'refresh-1',
        tokenTypeHint: 'refresh_token',
      }),
    ).resolves.toBe(true);
    const request = fake.recorded[0]!;
    expect(request.contentType).toContain('application/json');
    expect(JSON.parse(request.body)).toEqual({
      token: 'refresh-1',
      token_type_hint: 'refresh_token',
      client_id: CHATGPT_CODEX_CLIENT_ID,
    });
  });

  it('reports failure without throwing (best-effort)', async () => {
    fake.enqueue('POST', '/oauth/revoke', 500, { error: 'boom' });
    await expect(
      revokeChatGptToken({ issuer: fake.issuer, token: 't', tokenTypeHint: 'access_token' }),
    ).resolves.toBe(false);
  });
});

describe('runChatGptCodexLoginFlow', () => {
  const fake = new FakeOpenAIServer();

  beforeEach(async () => {
    fake.reset();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  const loginIdToken = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-login',
      chatgpt_plan_type: 'plus',
    },
  });

  function enqueueExchange(): void {
    fake.enqueue('POST', '/oauth/token', 200, {
      id_token: loginIdToken,
      access_token: makeJwt({ exp: 1_900_000_000 }),
      refresh_token: 'login-refresh',
    });
  }

  it('drives the browser flow end-to-end', async () => {
    enqueueExchange();
    const port = await freePort();
    let authorizeUrl = '';
    const flowPromise = runChatGptCodexLoginFlow({
      issuer: fake.issuer,
      ports: [port],
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
    });

    // Wait for the callback server to be up, then play the browser.
    await vi.waitFor(() => {
      expect(authorizeUrl).not.toBe('');
    });
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${port}/auth/callback`,
    );
    const state = url.searchParams.get('state')!;
    const callbackResponse = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=browser-code&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);

    const result = await flowPromise;
    expect(result.token.refreshToken).toBe('login-refresh');
    expect(result.token.idToken).toBe(loginIdToken);
    expect(result.token.accountId).toBe('acct-login');
    expect(result.accountId).toBe('acct-login');
    expect(result.planType).toBe('plus');
    expect(result.token.expiresAt).toBe(1_900_000_000);
    expect(result.port).toBe(port);

    // The exchange used the PKCE verifier matching the advertised challenge.
    const exchangeRequest = fake.recorded.find((r) => r.path === '/oauth/token')!;
    const params = new URLSearchParams(exchangeRequest.body);
    const expectedChallenge = Buffer.from(
      createHash('sha256').update(params.get('code_verifier')!).digest(),
    ).toString('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
  });

  it('accepts a manually pasted code (headless fallback)', async () => {
    enqueueExchange();
    const port = await freePort();
    const result = await runChatGptCodexLoginFlow({
      issuer: fake.issuer,
      ports: [port],
      onAuthorizeUrl: () => {},
      waitForManualCode: () => Promise.resolve('manual-code'),
    });
    expect(result.token.refreshToken).toBe('login-refresh');
    const exchangeRequest = fake.recorded.find((r) => r.path === '/oauth/token')!;
    expect(new URLSearchParams(exchangeRequest.body).get('code')).toBe('manual-code');
  });

  it('rejects a pasted callback URL whose state does not match', async () => {
    const port = await freePort();
    await expect(
      runChatGptCodexLoginFlow({
        issuer: fake.issuer,
        ports: [port],
        onAuthorizeUrl: () => {},
        waitForManualCode: () =>
          Promise.resolve(`http://localhost:${port}/auth/callback?code=x&state=WRONG`),
      }),
    ).rejects.toThrow(/state/);
    expect(fake.recorded.find((r) => r.path === '/oauth/token')).toBeUndefined();
  });

  it('aborts cleanly when the caller cancels', async () => {
    const port = await freePort();
    const controller = new AbortController();
    const flow = runChatGptCodexLoginFlow({
      issuer: fake.issuer,
      ports: [port],
      signal: controller.signal,
      onAuthorizeUrl: () => {
        controller.abort();
      },
    });
    await expect(flow).rejects.toThrow(/aborted/);
  });
});
