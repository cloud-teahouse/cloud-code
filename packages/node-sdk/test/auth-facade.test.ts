import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  CHATGPT_CODEX_PROVIDER_NAME,
  CLOUD_CODE_PROVIDER_NAME,
  CloudCodeOAuthToolkit,
  OAuthConnectionError,
  OAuthError,
  RetryableRefreshError,
  resolveKimiCodeOAuthKey,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@cloud-code/oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCloudCodeHarness, ErrorCodes, CloudCodeError } from '#/index';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { TEST_IDENTITY } from './test-identity';

let homeDir: string;

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function freshToken(): TokenInfo {
  return {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true });
});

describe('CloudCodeHarness.auth', () => {
  it('can construct auth facade without host identity', () => {
    expect(() => createCloudCodeHarness({ homeDir })).not.toThrow();
  });

  it('exposes a cached access token without refreshing auth state', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
  });

  it('reports the Kimi account snapshot from the stored credential', async () => {
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    await expect(harness.auth.getAccountSnapshot()).resolves.toEqual({
      state: 'not-logged-in',
    });

    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await expect(
      harness.auth.getAccountSnapshot(CLOUD_CODE_PROVIDER_NAME),
    ).resolves.toEqual({ state: 'logged-in' });
  });

  it('reports the ChatGPT account snapshot with id_token email claims', async () => {
    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      email: 'codex-user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-1',
        chatgpt_plan_type: 'plus',
      },
    })}.sig`;
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', {
      ...freshToken(),
      accountId: 'acct-1',
      idToken,
    });
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getAccountSnapshot(CHATGPT_CODEX_PROVIDER_NAME)).resolves.toEqual({
      state: 'logged-in',
      email: 'codex-user@example.com',
      planType: 'plus',
      accountId: 'acct-1',
    });
  });

  it('fetches fresh ChatGPT plan usage through the facade', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', {
      ...freshToken(),
      accountId: 'acct-1',
    });
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 42,
              limit_window_seconds: 18_000,
              reset_at: 1_735_689_720,
            },
          },
          rate_limit_reset_credits: { available_count: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    const usage = await harness.auth.fetchCodexUsage(CHATGPT_CODEX_PROVIDER_NAME);

    expect(usage.planType).toBe('pro');
    expect(usage.primary).toEqual({
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: 1_735_689_720,
    });
    expect(usage.resetCreditsAvailable).toBe(3);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchInputUrl(url)).toBe('https://chatgpt.com/backend-api/wham/usage');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer oauth-access-token');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(headers['User-Agent']).toBe('cloud-code-cli/0.0.0-test');
  });

  it('propagates usage-endpoint failures for the caller to fall back on', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', {
      ...freshToken(),
      accountId: 'acct-1',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ error: 'cloudflare_challenge' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.fetchCodexUsage(CHATGPT_CODEX_PROVIDER_NAME)).rejects.toThrow(
      'cloudflare_challenge',
    );
  });

  it('rejects fetchCodexUsage for non-ChatGPT providers', async () => {
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    await expect(harness.auth.fetchCodexUsage(CLOUD_CODE_PROVIDER_NAME)).rejects.toThrow(
      'ChatGPT Codex',
    );
    await expect(harness.auth.fetchCodexUsage()).rejects.toThrow('ChatGPT Codex');
  });

  it('lists ChatGPT reset credits through the facade', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', {
      ...freshToken(),
      accountId: 'acct-1',
    });
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          credits: [
            {
              id: 'credit-1',
              reset_type: 'codex_rate_limits',
              status: 'available',
              granted_at: '2027-01-01T00:00:00Z',
              expires_at: null,
              title: 'Full reset',
              description: 'Reset your current usage limits.',
            },
          ],
          available_count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    const list = await harness.auth.listCodexResetCredits(CHATGPT_CODEX_PROVIDER_NAME);

    expect(list.availableCount).toBe(1);
    expect(list.credits[0]).toMatchObject({ id: 'credit-1', status: 'available' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchInputUrl(url)).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer oauth-access-token');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
  });

  it('consumes a ChatGPT reset credit through the facade with the given idempotency key', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', {
      ...freshToken(),
      accountId: 'acct-1',
    });
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ code: 'reset', windows_reset: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    const result = await harness.auth.consumeCodexResetCredit(
      'req-uuid-1',
      'credit-1',
      CHATGPT_CODEX_PROVIDER_NAME,
    );

    expect(result).toEqual({ code: 'reset', rawCode: null, windowsReset: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchInputUrl(url)).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      redeem_request_id: 'req-uuid-1',
      credit_id: 'credit-1',
    });
  });

  it('rejects the reset-credit calls for non-ChatGPT providers', async () => {
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    await expect(harness.auth.listCodexResetCredits(CLOUD_CODE_PROVIDER_NAME)).rejects.toThrow(
      'ChatGPT Codex',
    );
    await expect(harness.auth.listCodexResetCredits()).rejects.toThrow('ChatGPT Codex');
    await expect(
      harness.auth.consumeCodexResetCredit('req-uuid-1', undefined, CLOUD_CODE_PROVIDER_NAME),
    ).rejects.toThrow('ChatGPT Codex');
    await expect(harness.auth.consumeCodexResetCredit('req-uuid-1')).rejects.toThrow(
      'ChatGPT Codex',
    );
  });

  it('maps missing runtime OAuth tokens to login-required errors', async () => {
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(
      harness.auth.resolveOAuthTokenProvider(CLOUD_CODE_PROVIDER_NAME).getAccessToken(),
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('maps transient OAuth token failures to provider connection errors', async () => {
    const tokenErrors = [
      new OAuthConnectionError('OAuth request failed: fetch failed'),
      new RetryableRefreshError('Token refresh failed (HTTP 503).'),
    ];

    for (const tokenError of tokenErrors) {
      const tokenProviderSpy = vi
        .spyOn(CloudCodeOAuthToolkit.prototype, 'tokenProvider')
        .mockReturnValue({
          async getAccessToken() {
            throw tokenError;
          },
        });
      try {
        const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

        const error = await harness.auth
          .resolveOAuthTokenProvider(CLOUD_CODE_PROVIDER_NAME)
          .getAccessToken()
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CloudCodeError);
        expect(error).toMatchObject({
          code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
          message: expect.stringContaining(tokenError.message),
          cause: tokenError,
        });
      } finally {
        tokenProviderSpy.mockRestore();
      }
    }
  });

  it('preserves non-retryable OAuth refresh failures', async () => {
    const oauthError = new OAuthError('bad client id');
    const tokenProviderSpy = vi
      .spyOn(CloudCodeOAuthToolkit.prototype, 'tokenProvider')
      .mockReturnValue({
        async getAccessToken() {
          throw oauthError;
        },
      });
    try {
      const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

      await expect(
        harness.auth.resolveOAuthTokenProvider(CLOUD_CODE_PROVIDER_NAME).getAccessToken(),
      ).rejects.toBe(oauthError);
    } finally {
      tokenProviderSpy.mockRestore();
    }
  });

  it('resolves managed auth from a partially invalid config without throwing', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
api_key = ""

[loop_control]
max_steps_per_turn = "abc"
`,
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    // Token resolution is a read path: a broken section elsewhere in
    // config.toml must degrade, not break OAuth-backed sessions.
    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
    await expect(harness.auth.status()).resolves.toMatchObject({
      providers: [{ providerName: CLOUD_CODE_PROVIDER_NAME, hasToken: true }],
    });
  });

  it('resolves cached access tokens from the configured scoped OAuth ref', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(storageName, { ...freshToken(), accessToken: 'dev-access-token' });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('dev-access-token');
  });

  it('reports auth status from the configured scoped OAuth ref', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey }),
      { ...freshToken(), accessToken: 'dev-access-token' },
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.status()).resolves.toEqual({
      providers: [{ providerName: CLOUD_CODE_PROVIDER_NAME, hasToken: true }],
    });
  });

  it('provisions SDK config using an existing Kimi OAuth token', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-for-coding',
                context_length: 262144,
                supports_reasoning: true,
                supports_image_in: true,
                supports_video_in: true,
                display_name: 'Kimi for Coding',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    const result = await harness.auth.login();
    const config = await harness.getConfig({ reload: true });

    expect(result).toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
      defaultThinking: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    );
    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.models?.['kimi-code/kimi-for-coding']).toMatchObject({
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Kimi for Coding',
    });
    expect(new ProviderManager({ config }).resolveProviderConfig(config.defaultModel!)).toMatchObject({
      modelCapabilities: {
        tool_use: true,
      },
    });
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'kimi',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    });
    expect(config.services?.moonshotSearch?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('logs in against the configured scoped OAuth host and base URL when env is absent', async () => {
    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const oauthHost = 'https://auth.dev.example.test';
    const oauthKey = resolveKimiCodeOAuthKey({ oauthHost, baseUrl });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(storageName, {
      ...freshToken(),
      accessToken: 'expired-dev-access-token',
      refreshToken: 'dev-refresh-token',
      expiresAt: 1,
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "${oauthHost}" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = fetchInputUrl(input);
      if (url === `${oauthHost}/api/oauth/token`) {
        if (typeof init?.body !== 'string') throw new TypeError('expected form body');
        const body = new URLSearchParams(init.body);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('dev-refresh-token');
        return new Response(
          JSON.stringify({
            access_token: 'rotated-dev-access-token',
            refresh_token: 'rotated-dev-refresh-token',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${baseUrl}/models`) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer rotated-dev-access-token',
        );
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'kimi-for-coding',
                context_length: 262144,
                supports_reasoning: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });
    await expect(storage.load(storageName)).resolves.toMatchObject({
      accessToken: 'rotated-dev-access-token',
    });
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: { storage: 'file', key: oauthKey, oauthHost },
    });
    expect(fetchMock.mock.calls.map((call) => fetchInputUrl(call[0]))).toEqual([
      `${oauthHost}/api/oauth/token`,
      `${baseUrl}/models`,
    ]);
  });

  it('recomputes legacy managed OAuth refs during login for non-default base URLs', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({ baseUrl });
    const scopedStorageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', { ...freshToken(), accessToken: 'legacy-access-token' });
    await storage.save(scopedStorageName, {
      ...freshToken(),
      accessToken: 'scoped-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: { storage: 'file', key: oauthKey, oauthHost: 'https://auth.kimi.com' },
    });
  });

  it('logs in against environment OAuth host and base URL over persisted config', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1';
    const envOauthHost = 'https://auth.env.example.test';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const envOauthKey = resolveKimiCodeOAuthKey({ oauthHost: envOauthHost, baseUrl: envBaseUrl });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(resolveKimiTokenStorageName({ oauthKey: configuredOauthKey }), {
      ...freshToken(),
      accessToken: 'configured-access-token',
    });
    await storage.save(resolveKimiTokenStorageName({ oauthKey: envOauthKey }), {
      ...freshToken(),
      accessToken: 'env-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${configuredBaseUrl}"
api_key = ""
oauth = { storage = "file", key = "${configuredOauthKey}", oauth_host = "https://auth.kimi.com" }
`,
    );
    vi.stubEnv('CLOUD_CODE_BASE_URL', envBaseUrl);
    vi.stubEnv('CLOUD_CODE_OAUTH_HOST', envOauthHost);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${envBaseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer env-access-token');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'kimi-for-coding',
              context_length: 262144,
              supports_reasoning: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.login()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'kimi-code/kimi-for-coding',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const config = await harness.getConfig({ reload: true });
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl: envBaseUrl,
      oauth: { storage: 'file', key: envOauthKey, oauthHost: envOauthHost },
    });
  });

  it('starts degraded when a configured model alias does not have max_context_size', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'kimi-for-coding',
                  context_length: 262144,
                  supports_reasoning: true,
                  supports_image_in: true,
                  supports_video_in: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    // A broken config must not prevent startup: the invalid model alias is
    // dropped, the rest of the config survives, and a warning is reported.
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    const config = await harness.getConfig();
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toBeDefined();
    const { warnings } = await harness.getConfigDiagnostics();
    expect(warnings.some((w) => w.includes('models.kimi-code/kimi-for-coding'))).toBe(true);
  });

  it('removes managed Kimi config on logout', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[providers.custom]
type = "kimi"
api_key = "sk-existing"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models.custom-default]
provider = "custom"
model = "custom-model"
max_context_size = 1000

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }
`,
    );

    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[CLOUD_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.models?.['kimi-code/kimi-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.moonshotSearch).toBeUndefined();
    expect(config.services?.moonshotFetch).toBeUndefined();
    await expect(
      new FileTokenStorage(join(homeDir, 'credentials')).load('kimi-code'),
    ).resolves.toBeUndefined();

    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).not.toContain('managed:kimi-code');
    expect(text).not.toContain('kimi-code/kimi-for-coding');
    expect(text).not.toContain('moonshot_search');
  });

  it('removes the configured scoped OAuth token on logout without touching the production token', async () => {
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(storageName, { ...freshToken(), accessToken: 'dev-access-token' });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
`,
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
    });

    await expect(storage.load(storageName)).resolves.toBeUndefined();
    await expect(storage.load('kimi-code')).resolves.toMatchObject({
      accessToken: 'oauth-access-token',
    });
  });

  it('recomputes legacy managed OAuth refs during logout for non-default base URLs', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({ baseUrl });
    const scopedStorageName = resolveKimiTokenStorageName({ oauthKey });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save('kimi-code', freshToken());
    await storage.save(scopedStorageName, {
      ...freshToken(),
      accessToken: 'scoped-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
`,
    );
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: CLOUD_CODE_PROVIDER_NAME,
      ok: true,
    });

    await expect(storage.load(scopedStorageName)).resolves.toBeUndefined();
    await expect(storage.load('kimi-code')).resolves.toMatchObject({
      accessToken: 'oauth-access-token',
    });
  });

  it('gets managed usage without host identity and sends only auth headers', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            usage: { used: 1, limit: 10, name: 'Weekly limit' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createCloudCodeHarness({ homeDir });
    const result = await harness.auth.getManagedUsage();

    expect(result).toMatchObject({
      kind: 'ok',
      summary: { name: 'Weekly limit', used: 1, limit: 10 },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
  });

  it('uses configured scoped OAuth refs and base URLs for managed usage and feedback', async () => {
    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl,
    });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(storageName, {
      ...freshToken(),
      accessToken: 'dev-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${baseUrl}"
api_key = ""
oauth = { storage = "file", key = "${oauthKey}", oauth_host = "https://auth.dev.example.test" }
`,
    );
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/usages')) {
        return new Response(
          JSON.stringify({ usage: { used: 2, limit: 10, name: 'Dev limit' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir });

    await expect(harness.auth.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { name: 'Dev limit', used: 2, limit: 10 },
    });
    await expect(
      harness.auth.submitFeedback({
        content: 'dev feedback',
        sessionId: 'sess-dev',
        version: 'cloud-code-0.1.1',
        os: 'Darwin 25.3.0',
        model: 'kimi-code/kimi-for-coding',
      }),
    ).resolves.toEqual({ kind: 'ok', feedbackId: 3 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/usages`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${baseUrl}/feedback`);
    for (const call of fetchMock.mock.calls) {
      const init = call[1];
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer dev-access-token');
    }
  });

  it('uses environment managed endpoints for usage and feedback over persisted config', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1';
    const envOauthHost = 'https://auth.env.example.test';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const envOauthKey = resolveKimiCodeOAuthKey({
      oauthHost: envOauthHost,
      baseUrl: envBaseUrl,
    });
    const storage = new FileTokenStorage(join(homeDir, 'credentials'));
    await storage.save(resolveKimiTokenStorageName({ oauthKey: configuredOauthKey }), {
      ...freshToken(),
      accessToken: 'configured-access-token',
    });
    await storage.save(resolveKimiTokenStorageName({ oauthKey: envOauthKey }), {
      ...freshToken(),
      accessToken: 'env-access-token',
    });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "${configuredBaseUrl}"
api_key = ""
oauth = { storage = "file", key = "${configuredOauthKey}", oauth_host = "https://auth.kimi.com" }
`,
    );
    vi.stubEnv('CLOUD_CODE_BASE_URL', envBaseUrl);
    vi.stubEnv('CLOUD_CODE_OAUTH_HOST', envOauthHost);
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/usages')) {
        return new Response(
          JSON.stringify({ usage: { used: 3, limit: 10, name: 'Env limit' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const harness = createCloudCodeHarness({ homeDir });

    await expect(harness.auth.status()).resolves.toEqual({
      providers: [{ providerName: CLOUD_CODE_PROVIDER_NAME, hasToken: true }],
    });
    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('env-access-token');
    await expect(
      harness.auth.resolveOAuthTokenProvider(CLOUD_CODE_PROVIDER_NAME).getAccessToken(),
    ).resolves.toBe('env-access-token');
    await expect(
      harness.auth
        .resolveOAuthTokenProvider(CLOUD_CODE_PROVIDER_NAME, {
          storage: 'file',
          key: configuredOauthKey,
          oauthHost: 'https://auth.kimi.com',
        })
        .getAccessToken(),
    ).resolves.toBe('env-access-token');
    await expect(harness.auth.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { name: 'Env limit', used: 3, limit: 10 },
    });
    await expect(
      harness.auth.submitFeedback({
        content: 'env feedback',
        sessionId: 'sess-env',
        version: 'cloud-code-0.1.1',
        os: 'Darwin 25.3.0',
        model: 'kimi-code/kimi-for-coding',
      }),
    ).resolves.toEqual({ kind: 'ok', feedbackId: 3 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${envBaseUrl}/usages`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${envBaseUrl}/feedback`);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer env-access-token');
    }
  });

  it('submitFeedback maps camelCase input to snake_case body and posts with bearer auth', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ feedback_id: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createCloudCodeHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'great tool',
      sessionId: 'sess-42',
      version: 'cloud-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'kimi-code/kimi-for-coding',
      contact: 'test@example.com',
      info: { codebase: { file_name: 'repo.zip' } },
    });

    expect(result).toEqual({ kind: 'ok', feedbackId: 3 });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.kimi.com/coding/v1/feedback');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('content-type')).toBe('application/json');

    expect(JSON.parse(init?.body as string)).toEqual({
      session_id: 'sess-42',
      content: 'great tool',
      version: 'cloud-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'kimi-code/kimi-for-coding',
      contact: 'test@example.com',
      info: { codebase: { file_name: 'repo.zip' } },
    });
  });

  it('createFeedbackUploadUrl maps SDK input and returns camelCase upload parts', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          upload: {
            id: 28,
            parts: [
              {
                part_number: 1,
                url: 'https://upload.example.test/part-1',
                method: 'PUT',
                size: 1024,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = createCloudCodeHarness({ homeDir });
    const result = await harness.auth.createFeedbackUploadUrl({
      feedbackId: 3,
      filename: 'session.zip',
      size: 1024,
      sha256: 'abc123',
    });

    expect(result).toEqual({
      kind: 'ok',
      uploadId: 28,
      parts: [
        {
          partNumber: 1,
          url: 'https://upload.example.test/part-1',
          method: 'PUT',
          size: 1024,
        },
      ],
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.kimi.com/coding/v1/feedback/upload_url');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      feedback_id: 3,
      file_name: 'session.zip',
      file_size: 1024,
      file_hash: 'abc123',
    });
  });

  it('submitFeedback surfaces HTTP errors without throwing', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ message: 'feedback API rejected the request' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const harness = createCloudCodeHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'x',
      sessionId: 's',
      version: 'cloud-code-0.0.0',
      os: 'Darwin 25.3.0',
      model: null,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('feedback API rejected the request');
  });
});

describe('CloudCodeHarness.auth — ChatGPT Codex (OAuth)', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.test-signature`;
  }

  function chatGptToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return {
      accessToken: makeJwt({ exp }),
      refreshToken: 'chatgpt-refresh-1',
      expiresAt: exp,
      scope: 'openid',
      tokenType: 'Bearer',
      expiresIn: 3600,
      accountId: 'acct-1',
      idToken: makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
      }),
      ...overrides,
    };
  }

  async function seedChatGptToken(token: TokenInfo = chatGptToken()): Promise<void> {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('chatgpt-codex', token);
  }

  it('reports ChatGPT Codex login status from the credential slot', async () => {
    await seedChatGptToken();
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    const status = await harness.auth.status('managed:chatgpt-codex');
    expect(status.providers).toEqual([
      { providerName: 'managed:chatgpt-codex', hasToken: true },
    ]);

    const empty = createCloudCodeHarness({ homeDir: await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-empty-')) });
    await expect(empty.auth.status('managed:chatgpt-codex')).resolves.toEqual({
      providers: [{ providerName: 'managed:chatgpt-codex', hasToken: false }],
    });
  });

  it('resolves the ChatGPT token provider with the account-id header', async () => {
    await seedChatGptToken();
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });

    const provider = harness.auth.resolveOAuthTokenProvider('managed:chatgpt-codex', {
      storage: 'file',
      key: 'oauth/chatgpt-codex',
    });
    await expect(provider.getAccessToken()).resolves.toBe(chatGptToken().accessToken);
    await expect(provider.getAuthHeaders?.()).resolves.toEqual({
      'ChatGPT-Account-ID': 'acct-1',
    });
  });

  it('maps missing ChatGPT credentials to login-required errors', async () => {
    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    await expect(
      harness.auth.resolveOAuthTokenProvider('managed:chatgpt-codex').getAccessToken(),
    ).rejects.toMatchObject({ code: ErrorCodes.AUTH_LOGIN_REQUIRED });
  });

  it('logout revokes the refresh_token best-effort, deletes the credential and cleans config', async () => {
    await seedChatGptToken();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[providers."managed:chatgpt-codex"]
type = "openai_responses"
base_url = "https://chatgpt.com/backend-api/codex"
api_key = ""

[providers."managed:chatgpt-codex".oauth]
storage = "file"
key = "oauth/chatgpt-codex"

[models."chatgpt-codex/gpt-5.2-codex"]
provider = "managed:chatgpt-codex"
model = "gpt-5.2-codex"
max_context_size = 400000

default_model = "chatgpt-codex/gpt-5.2-codex"
`,
    );
    const fetchMock = vi.fn<FetchMock>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    await harness.auth.logout('managed:chatgpt-codex');

    // Best-effort revoke hit the OpenAI revocation endpoint with the refresh token.
    const revokeCalls = fetchMock.mock.calls.filter(([input]) =>
      fetchInputUrl(input).includes('/oauth/revoke'),
    );
    expect(revokeCalls).toHaveLength(1);
    const [revokeUrl, revokeInit] = revokeCalls[0] as unknown as [string, RequestInit];
    expect(revokeUrl).toBe('https://auth.openai.com/oauth/revoke');
    expect(JSON.parse(revokeInit.body as string)).toMatchObject({
      token: 'chatgpt-refresh-1',
      token_type_hint: 'refresh_token',
    });

    await expect(harness.auth.status('managed:chatgpt-codex')).resolves.toEqual({
      providers: [{ providerName: 'managed:chatgpt-codex', hasToken: false }],
    });
    const config = await harness.getConfig({ reload: true });
    expect(config.providers['managed:chatgpt-codex']).toBeUndefined();
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']).toBeUndefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it('login drives the browser flow, persists tokens and provisions config', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const idToken = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-login',
        chatgpt_plan_type: 'pro',
      },
    });
    const accessToken = makeJwt({ exp });
    const modelsPayload = {
      models: [
        {
          slug: 'gpt-5.2-codex',
          display_name: 'GPT-5.2 Codex',
          context_window: 400000,
          supported_reasoning_levels: ['low', 'medium', 'high'],
          default_reasoning_level: 'medium',
        },
      ],
    };

    const realFetch = globalThis.fetch;
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = fetchInputUrl(input);
      captured.push({ url, init });
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: accessToken,
            refresh_token: 'chatgpt-refresh-login',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) {
        return new Response(JSON.stringify(modelsPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Localhost callback server traffic goes through the real network stack.
      return realFetch(input, init);
    });

    const harness = createCloudCodeHarness({ homeDir, identity: TEST_IDENTITY });
    let authorizeUrl = '';
    const loginPromise = harness.auth.login('managed:chatgpt-codex', {
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
    });

    await vi.waitFor(() => {
      expect(authorizeUrl).not.toBe('');
    });
    const parsed = new URL(authorizeUrl);
    expect(parsed.origin).toBe('https://auth.openai.com');
    expect(parsed.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    const redirectUri = parsed.searchParams.get('redirect_uri')!;
    const state = parsed.searchParams.get('state')!;
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', 'browser-code');
    callbackUrl.searchParams.set('state', state);
    const callbackResponse = await realFetch(callbackUrl);
    expect(callbackResponse.status).toBe(200);

    const result = await loginPromise;
    expect(result.providerName).toBe('managed:chatgpt-codex');
    expect(result.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');

    // Credential file carries the ChatGPT-specific fields; expires_at comes
    // from the access_token JWT exp (the refresh response has no expires_in).
    const wire = JSON.parse(
      await readFile(join(homeDir, 'credentials', 'chatgpt-codex.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(wire['refresh_token']).toBe('chatgpt-refresh-login');
    expect(wire['account_id']).toBe('acct-login');
    expect(wire['id_token']).toBe(idToken);
    expect(wire['expires_at']).toBe(exp);

    // The models request carried bearer + account-id headers.
    const modelsCall = captured.find((c) => c.url.includes('/backend-api/codex/models'))!;
    const modelsHeaders = new Headers(modelsCall.init?.headers);
    expect(modelsHeaders.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(modelsHeaders.get('chatgpt-account-id')).toBe('acct-login');

    // Config provisioning wrote the provider, alias and default model.
    const config = await harness.getConfig({ reload: true });
    expect(config.providers['managed:chatgpt-codex']).toMatchObject({
      type: 'openai_responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      oauth: { storage: 'file', key: 'oauth/chatgpt-codex' },
    });
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']).toMatchObject({
      provider: 'managed:chatgpt-codex',
      model: 'gpt-5.2-codex',
      maxContextSize: 400000,
    });
    expect(config.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');
  });
});
