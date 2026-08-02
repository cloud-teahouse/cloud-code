/**
 * ChatGptOAuthManager tests — JSON refresh with JWT-exp expiry, refresh_token
 * rotation errors → tombstone, peer-rotation recovery, revoke-on-logout.
 *
 * All HTTP goes to a local fake OpenAI issuer; storage is a real
 * FileTokenStorage in a temp dir (with the real lockfile path) so the
 * cross-process coordination semantics are exercised end-to-end.
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGptOAuthManager } from '../src/chatgpt-codex-manager';
import { OAuthUnauthorizedError } from '../src/errors';
import { FileTokenStorage } from '../src/storage';
import type { TokenInfo } from '../src/types';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.test-signature`;
}

function idTokenWithAccount(accountId: string): string {
  return makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  });
}

/** Shape mirrors the real `/wham/usage` 200 payload (snake_case windows). */
const USAGE_PAYLOAD = {
  user_id: 'user-abc123',
  account_id: 'acct-1',
  email: 'user@example.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 120,
      reset_at: 1_735_689_720,
    },
    secondary_window: {
      used_percent: 5,
      limit_window_seconds: 604_800,
      reset_after_seconds: 43_200,
      reset_at: 1_735_759_200,
    },
  },
  credits: { has_credits: false, unlimited: false, balance: null },
  rate_limit_reached_type: { type: null, details: null },
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 2 },
};

/** Shape mirrors the real wham reset-credits list payload. */
const RESET_CREDITS_PAYLOAD = {
  credits: [
    {
      id: 'credit-1',
      reset_type: 'codex_rate_limits',
      status: 'available',
      granted_at: '2027-01-01T00:00:00Z',
      expires_at: '2027-01-02T03:04:05Z',
      title: 'Full reset',
      description: 'Reset your current usage limits.',
    },
  ],
  available_count: 1,
  total_earned_count: 2,
};

interface RecordedRequest {
  readonly path: string;
  readonly contentType: string;
  readonly authorization: string;
  readonly accountId: string;
  readonly userAgent: string;
  readonly body: string;
}

class FakeIssuer {
  private server: Server | undefined;
  readonly recorded: RecordedRequest[] = [];
  issuer = '';
  onTokenRequest: (() => void) | undefined;
  private tokenResponses: Array<{ status: number; body: unknown }> = [];
  revokeStatus = 200;
  usageStatus = 200;
  usageBody: unknown = USAGE_PAYLOAD;
  resetCreditsStatus = 200;
  resetCreditsBody: unknown = RESET_CREDITS_PAYLOAD;
  consumeStatus = 200;
  consumeBody: unknown = { code: 'reset', windows_reset: 2 };

  enqueueToken(status: number, body: unknown): void {
    this.tokenResponses.push({ status, body });
  }

  reset(): void {
    this.recorded.length = 0;
    this.tokenResponses = [];
    this.onTokenRequest = undefined;
    this.revokeStatus = 200;
    this.usageStatus = 200;
    this.usageBody = USAGE_PAYLOAD;
    this.resetCreditsStatus = 200;
    this.resetCreditsBody = RESET_CREDITS_PAYLOAD;
    this.consumeStatus = 200;
    this.consumeBody = { code: 'reset', windows_reset: 2 };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        this.recorded.push({
          path: req.url ?? '',
          contentType: req.headers['content-type'] ?? '',
          authorization: req.headers['authorization'] ?? '',
          accountId: (req.headers['chatgpt-account-id'] as string | undefined) ?? '',
          userAgent: req.headers['user-agent'] ?? '',
          body,
        });
        if (req.url === '/oauth/token') {
          this.onTokenRequest?.();
          const next =
            this.tokenResponses.length > 1 ? this.tokenResponses.shift() : this.tokenResponses[0];
          res.writeHead(next?.status ?? 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(next?.body ?? { error: 'no_response_queued' }));
          return;
        }
        if (req.url === '/oauth/revoke') {
          res.writeHead(this.revokeStatus, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (req.url === '/wham/usage') {
          res.writeHead(this.usageStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.usageBody));
          return;
        }
        if (req.url === '/wham/rate-limit-reset-credits') {
          res.writeHead(this.resetCreditsStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.resetCreditsBody));
          return;
        }
        if (req.url === '/wham/rate-limit-reset-credits/consume') {
          res.writeHead(this.consumeStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.consumeBody));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });
  }
}

const NOW = 1_800_000_000;

function tokenFixture(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: makeJwt({ exp: NOW + 3600 }),
    refreshToken: 'refresh-1',
    expiresAt: NOW + 3600,
    scope: 'openid',
    tokenType: 'Bearer',
    expiresIn: 3600,
    accountId: 'acct-1',
    idToken: idTokenWithAccount('acct-1'),
    ...overrides,
  };
}

describe('ChatGptOAuthManager', () => {
  let dir: string;
  let storage: FileTokenStorage;
  const fake = new FakeIssuer();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chatgpt-oauth-manager-test-'));
    storage = new FileTokenStorage(join(dir, 'credentials'));
    fake.reset();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function manager(overrides: Partial<ConstructorParameters<typeof ChatGptOAuthManager>[0]> = {}) {
    return new ChatGptOAuthManager({
      storage,
      configDir: dir,
      issuer: fake.issuer,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      ...overrides,
    });
  }

  async function seedToken(token: TokenInfo): Promise<void> {
    await storage.save('chatgpt-codex', token);
  }

  async function readWire(): Promise<Record<string, unknown>> {
    const raw = await readFile(join(dir, 'credentials', 'chatgpt-codex.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('returns the cached token when the JWT exp is outside the 5-minute window', async () => {
    await seedToken(tokenFixture());
    const access = await manager().ensureFresh();
    expect(access).toBe(makeJwt({ exp: NOW + 3600 }));
    expect(fake.recorded).toHaveLength(0);
  });

  it('refreshes inside the 5-minute window and derives expiresAt from the new JWT exp', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    fake.enqueueToken(200, {
      access_token: makeJwt({ exp: NOW + 7200 }),
      refresh_token: 'refresh-2',
    });

    const access = await manager().ensureFresh();
    expect(access).toBe(makeJwt({ exp: NOW + 7200 }));

    const request = fake.recorded[0]!;
    expect(request.contentType).toContain('application/json');
    expect(JSON.parse(request.body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });

    const wire = await readWire();
    expect(wire['refresh_token']).toBe('refresh-2');
    expect(wire['expires_at']).toBe(NOW + 7200);
    // No new id_token in the response → stored account claims carry over.
    expect(wire['account_id']).toBe('acct-1');
    expect(wire['id_token']).toBe(idTokenWithAccount('acct-1'));
  });

  it('overlays only the returned fields (refresh_token-only response)', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    fake.enqueueToken(200, { refresh_token: 'refresh-rotated' });

    const access = await manager().ensureFresh();
    expect(access).toBe(makeJwt({ exp: NOW + 3600 }));
    const wire = await readWire();
    expect(wire['access_token']).toBe(makeJwt({ exp: NOW + 3600 }));
    expect(wire['refresh_token']).toBe('refresh-rotated');
    expect(wire['expires_at']).toBe(NOW + 100);
  });

  it('refreshes the cached account id when a new id_token arrives', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    fake.enqueueToken(200, {
      id_token: idTokenWithAccount('acct-2'),
      refresh_token: 'refresh-2',
    });

    const m = manager();
    await m.ensureFresh();
    expect(await m.getAccountId()).toBe('acct-2');
    await expect(m.getAuthHeaders()).resolves.toEqual({ 'ChatGPT-Account-ID': 'acct-2' });
  });

  it('tombstones the stored token on refresh_token_reused', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    fake.enqueueToken(400, { error: 'refresh_token_reused' });

    const m = manager();
    await expect(m.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);

    const wire = await readWire();
    expect(wire['access_token']).toBe('');
    expect(wire['refresh_token']).toBe('');
    expect(wire['expires_at']).toBe(0);
    expect(await m.hasToken()).toBe(false);
    // A fresh process sees the tombstone and refuses without hitting the network.
    await expect(manager().ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    expect(fake.recorded.filter((r) => r.path === '/oauth/token')).toHaveLength(1);
  });

  it('recovers from a 401 when a peer process rotated the refresh_token mid-flight', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    let peerWrite: Promise<void> = Promise.resolve();
    fake.onTokenRequest = () => {
      // A peer refreshed while we were in flight: it persisted a rotated
      // refresh_token before our doomed request landed.
      peerWrite = storage.save(
        'chatgpt-codex',
        tokenFixture({
          accessToken: 'peer-access',
          refreshToken: 'peer-refresh',
          expiresAt: NOW + 7200,
        }),
      );
    };
    fake.enqueueToken(401, { error: 'refresh_token_reused' });

    // The manager sleeps between the 401 and the recovery re-read; route that
    // sleep through the peer write so the re-read deterministically observes it.
    const m = manager({
      sleep: async () => {
        await peerWrite;
      },
    });
    const access = await m.ensureFresh();
    expect(access).toBe('peer-access');
    const wire = await readWire();
    expect(wire['refresh_token']).toBe('peer-refresh');
  });

  it('coalesces concurrent refreshes into one HTTP request', async () => {
    await seedToken(tokenFixture({ expiresAt: NOW + 100, expiresIn: 100 }));
    fake.enqueueToken(200, {
      access_token: makeJwt({ exp: NOW + 7200 }),
      refresh_token: 'refresh-2',
    });
    const m = manager();
    const [a, b] = await Promise.all([m.ensureFresh(), m.ensureFresh()]);
    expect(a).toBe(b);
    expect(fake.recorded.filter((r) => r.path === '/oauth/token')).toHaveLength(1);
  });

  it('throws login-required when no token is stored', async () => {
    await expect(manager().ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('does not proactively refresh when the access token carries no exp', async () => {
    await seedToken(tokenFixture({ accessToken: 'opaque', expiresAt: 0, expiresIn: 0 }));
    const access = await manager().ensureFresh();
    expect(access).toBe('opaque');
    expect(fake.recorded).toHaveLength(0);
  });

  it('login persists the exchanged tokens (browser flow against the fake issuer)', async () => {
    fake.enqueueToken(200, {
      id_token: idTokenWithAccount('acct-login'),
      access_token: makeJwt({ exp: NOW + 3600 }),
      refresh_token: 'login-refresh',
    });
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const port = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portServer.close(() => {
        resolve();
      }));

    const m = manager();
    let authorizeUrl = '';
    const loginPromise = m.login({
      ports: [port],
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
    });
    await vi.waitFor(() => {
      expect(authorizeUrl).not.toBe('');
    });
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=${state}`);

    const token = await loginPromise;
    expect(token.refreshToken).toBe('login-refresh');
    expect(token.accountId).toBe('acct-login');
    expect(await m.hasToken()).toBe(true);
    await expect(m.getAuthHeaders()).resolves.toEqual({ 'ChatGPT-Account-ID': 'acct-login' });
  });

  it('logout revokes the refresh_token (best-effort) and deletes the credential file', async () => {
    await seedToken(tokenFixture());
    const m = manager();
    await m.logout();

    const revoke = fake.recorded.find((r) => r.path === '/oauth/revoke')!;
    expect(JSON.parse(revoke.body)).toMatchObject({
      token: 'refresh-1',
      token_type_hint: 'refresh_token',
    });
    expect(await m.hasToken()).toBe(false);
  });

  it('logout still deletes the credential file when revocation fails', async () => {
    await seedToken(tokenFixture());
    fake.revokeStatus = 500;
    const m = manager();
    await m.logout();
    expect(await m.hasToken()).toBe(false);
  });

  it('getAuthHeaders is undefined without a stored account id', async () => {
    await seedToken(tokenFixture({ accountId: undefined, idToken: undefined }));
    await expect(manager().getAuthHeaders()).resolves.toBeUndefined();
  });

  describe('getAccountSnapshot', () => {
    it('reports not-logged-in when no credential is stored', async () => {
      await expect(manager().getAccountSnapshot()).resolves.toEqual({
        state: 'not-logged-in',
      });
    });

    it('extracts email/plan/account from the stored id_token (top-level email)', async () => {
      await seedToken(
        tokenFixture({
          idToken: makeJwt({
            email: 'user@example.com',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-9',
              chatgpt_plan_type: 'plus',
            },
          }),
        }),
      );
      await expect(manager().getAccountSnapshot()).resolves.toEqual({
        state: 'logged-in',
        email: 'user@example.com',
        planType: 'plus',
        accountId: 'acct-9',
      });
    });

    it('falls back to the profile-namespace email claim', async () => {
      await seedToken(
        tokenFixture({
          idToken: makeJwt({
            'https://api.openai.com/profile': { email: 'namespaced@example.com' },
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
          }),
        }),
      );
      const snapshot = await manager().getAccountSnapshot();
      expect(snapshot.state).toBe('logged-in');
      expect(snapshot.email).toBe('namespaced@example.com');
      expect(snapshot.planType).toBeUndefined();
    });

    it('reports logged-in without claims when no id_token is stored', async () => {
      await seedToken(tokenFixture({ accountId: 'acct-legacy', idToken: undefined }));
      await expect(manager().getAccountSnapshot()).resolves.toEqual({
        state: 'logged-in',
        email: undefined,
        planType: undefined,
        accountId: 'acct-legacy',
      });
    });

    it('reports expired for a revoked tombstone', async () => {
      await seedToken(
        tokenFixture({ accessToken: '', refreshToken: '', expiresAt: 0, expiresIn: 0 }),
      );
      await expect(manager().getAccountSnapshot()).resolves.toEqual({ state: 'expired' });
    });
  });

  describe('fetchCodexUsage', () => {
    function usageManager(
      overrides: Partial<ConstructorParameters<typeof ChatGptOAuthManager>[0]> = {},
    ) {
      return manager({
        usageUrl: `${fake.issuer}/wham/usage`,
        userAgent: 'cloud-code-cli/1.2.3',
        ...overrides,
      });
    }

    it('fetches fresh plan usage with the stored bearer, account id, and product UA', async () => {
      await seedToken(tokenFixture());

      const usage = await usageManager().fetchCodexUsage();

      expect(usage.planType).toBe('pro');
      expect(usage.primary).toEqual({
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: 1_735_689_720,
      });
      expect(usage.secondary).toEqual({
        usedPercent: 5,
        windowMinutes: 10_080,
        resetsAt: 1_735_759_200,
      });
      expect(usage.credits).toEqual({ hasCredits: false, unlimited: false, balance: null });
      // The account-applicable count wins over the raw available_count.
      expect(usage.resetCreditsAvailable).toBe(2);
      expect(usage.capturedAt).toBeGreaterThan(0);

      const request = fake.recorded.find((r) => r.path === '/wham/usage');
      expect(request).toBeDefined();
      expect(request!.authorization).toBe(`Bearer ${makeJwt({ exp: NOW + 3600 })}`);
      expect(request!.accountId).toBe('acct-1');
      expect(request!.userAgent).toBe('cloud-code-cli/1.2.3');
      // A valid token short-circuits the refresh path entirely.
      expect(fake.recorded.some((r) => r.path === '/oauth/token')).toBe(false);
    });

    it('refreshes an expired token before fetching, and fetches with the new bearer', async () => {
      await seedToken(tokenFixture({ expiresAt: NOW - 10, expiresIn: 0 }));
      fake.enqueueToken(200, {
        access_token: makeJwt({ exp: NOW + 7200 }),
        refresh_token: 'refresh-2',
      });

      const usage = await usageManager().fetchCodexUsage();
      expect(usage.resetCreditsAvailable).toBe(2);

      const paths = fake.recorded.map((r) => r.path);
      expect(paths).toEqual(['/oauth/token', '/wham/usage']);
      expect(fake.recorded[1]!.authorization).toBe(`Bearer ${makeJwt({ exp: NOW + 7200 })}`);
      // The rotated refresh_token persisted via the normal refresh path.
      const wire = await readWire();
      expect(wire['refresh_token']).toBe('refresh-2');
    });

    it('propagates endpoint failures without touching the stored credential', async () => {
      await seedToken(tokenFixture());
      fake.usageStatus = 403;
      fake.usageBody = { error: 'cloudflare_challenge' };

      const m = usageManager();
      await expect(m.fetchCodexUsage()).rejects.toThrow('cloudflare_challenge');
      // A usage-endpoint failure is not an auth failure: no tombstone.
      await expect(m.hasToken()).resolves.toBe(true);
    });

    it('throws unauthorized when no token is stored', async () => {
      await expect(usageManager().fetchCodexUsage()).rejects.toBeInstanceOf(
        OAuthUnauthorizedError,
      );
      expect(fake.recorded.some((r) => r.path === '/wham/usage')).toBe(false);
    });
  });

  describe('reset credits', () => {
    function resetManager(
      overrides: Partial<ConstructorParameters<typeof ChatGptOAuthManager>[0]> = {},
    ) {
      return manager({
        usageUrl: `${fake.issuer}/wham/usage`,
        userAgent: 'cloud-code-cli/1.2.3',
        ...overrides,
      });
    }

    it('lists reset credits with the stored bearer and account id', async () => {
      await seedToken(tokenFixture());

      const list = await resetManager().listResetCredits();

      expect(list.availableCount).toBe(1);
      expect(list.credits).toEqual([
        {
          id: 'credit-1',
          resetType: 'codex_rate_limits',
          status: 'available',
          title: 'Full reset',
          description: 'Reset your current usage limits.',
          expiresAt: Date.parse('2027-01-02T03:04:05Z'),
        },
      ]);
      const request = fake.recorded.find((r) => r.path === '/wham/rate-limit-reset-credits');
      expect(request).toBeDefined();
      expect(request!.authorization).toBe(`Bearer ${makeJwt({ exp: NOW + 3600 })}`);
      expect(request!.accountId).toBe('acct-1');
      expect(request!.userAgent).toBe('cloud-code-cli/1.2.3');
    });

    it('consumes a credit with the exact redeem_request_id and credit_id', async () => {
      await seedToken(tokenFixture());

      const result = await resetManager().consumeResetCredit('req-uuid-1', 'credit-1');

      expect(result).toEqual({ code: 'reset', rawCode: null, windowsReset: 2 });
      const request = fake.recorded.find(
        (r) => r.path === '/wham/rate-limit-reset-credits/consume',
      );
      expect(request).toBeDefined();
      expect(request!.contentType).toContain('application/json');
      expect(JSON.parse(request!.body)).toEqual({
        redeem_request_id: 'req-uuid-1',
        credit_id: 'credit-1',
      });
    });

    it('omits credit_id when consuming without a specific credit', async () => {
      await seedToken(tokenFixture());

      await resetManager().consumeResetCredit('req-uuid-2');

      const request = fake.recorded.find(
        (r) => r.path === '/wham/rate-limit-reset-credits/consume',
      );
      expect(JSON.parse(request!.body)).toEqual({ redeem_request_id: 'req-uuid-2' });
    });

    it('propagates endpoint failures without touching the stored credential', async () => {
      await seedToken(tokenFixture());
      fake.consumeStatus = 409;
      fake.consumeBody = { error: 'no_credit' };

      const m = resetManager();
      await expect(m.consumeResetCredit('req-uuid-3')).rejects.toThrow('no_credit');
      // A consume-endpoint failure is not an auth failure: no tombstone.
      await expect(m.hasToken()).resolves.toBe(true);
    });

    it('throws unauthorized when no token is stored', async () => {
      await expect(resetManager().listResetCredits()).rejects.toBeInstanceOf(
        OAuthUnauthorizedError,
      );
      await expect(resetManager().consumeResetCredit('req-uuid-4')).rejects.toBeInstanceOf(
        OAuthUnauthorizedError,
      );
      expect(
        fake.recorded.some((r) => r.path.startsWith('/wham/rate-limit-reset-credits')),
      ).toBe(false);
    });
  });
});
