/**
 * ChatGPT authorization-code + PKCE OAuth flow — pure HTTP / server wrappers.
 *
 * Mirrors `codex login` (codex-rs/login/src/server.rs):
 *  1. PKCE: 64 random bytes → base64url verifier; SHA256(verifier) → challenge.
 *  2. state: 32 random bytes base64url.
 *  3. Localhost callback server on 127.0.0.1:1455, falling back to 1457 when
 *     occupied — both ports are hard-coded because the OpenAI authorization
 *     server's redirect_uri allow-list only permits these two.
 *  4. `GET {issuer}/oauth/authorize` with the parameter set documented in
 *     docs/oauth/chatgpt-codex-oauth-research.md §1.1.
 *  5. `/oauth/token` code exchange (form-encoded) → id/access/refresh tokens.
 *
 * Also home to the refresh (`POST /oauth/token` with a **JSON** body — not
 * form-encoded) and revoke helpers, plus JWT claim parsing. No state is kept
 * here — `ChatGptOAuthManager` drives login/refresh/store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { extractApiErrorMessage } from './api-error';
import {
  CHATGPT_CODEX_CLIENT_ID,
  CHATGPT_CODEX_ISSUER,
  CHATGPT_CODEX_LOGIN_PORTS,
  CHATGPT_CODEX_ORIGINATOR,
  CHATGPT_CODEX_SCOPE,
} from './chatgpt-codex';
import {
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';
import type { TokenInfo } from './types';
import { isRecord } from './utils';

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** refresh_token rotation failures — all permanent, re-login required. */
const PERMANENT_REFRESH_ERROR_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

// ── PKCE / state ─────────────────────────────────────────────────────

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

// ── JWT claims ─────────────────────────────────────────────────────────

const OPENAI_AUTH_CLAIMS_NAMESPACE = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIMS_NAMESPACE = 'https://api.openai.com/profile';

export interface ChatGptIdTokenClaims {
  /** `chatgpt_account_id` from the `https://api.openai.com/auth` namespace. */
  readonly accountId?: string | undefined;
  /** `chatgpt_plan_type` (free/plus/pro/business/enterprise/edu). */
  readonly planType?: string | undefined;
  /** `chatgpt_user_id` (or `user_id`). */
  readonly userId?: string | undefined;
  /** Top-level or profile-namespace email. */
  readonly email?: string | undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the ChatGPT-specific claims out of a raw id_token JWT. */
export function parseChatGptIdTokenClaims(idToken: string): ChatGptIdTokenClaims {
  const payload = decodeJwtPayload(idToken);
  if (payload === undefined) return {};
  const authNs = isRecord(payload[OPENAI_AUTH_CLAIMS_NAMESPACE])
    ? payload[OPENAI_AUTH_CLAIMS_NAMESPACE]
    : undefined;
  const profileNs = isRecord(payload[OPENAI_PROFILE_CLAIMS_NAMESPACE])
    ? payload[OPENAI_PROFILE_CLAIMS_NAMESPACE]
    : undefined;
  const accountId = authNs?.['chatgpt_account_id'];
  const planType = authNs?.['chatgpt_plan_type'];
  const userId = authNs?.['chatgpt_user_id'] ?? authNs?.['user_id'];
  const email = payload['email'] ?? profileNs?.['email'];
  return {
    accountId: typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined,
    planType: typeof planType === 'string' && planType.length > 0 ? planType : undefined,
    userId: typeof userId === 'string' && userId.length > 0 ? userId : undefined,
    email: typeof email === 'string' && email.length > 0 ? email : undefined,
  };
}

/**
 * Expiry (unix seconds) of a JWT access_token from its `exp` claim. The
 * ChatGPT token endpoint returns no `expires_in`, so this is the only source
 * of expiry information. Returns undefined for non-JWT / exp-less tokens.
 */
export function jwtExpiresAt(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : undefined;
}

// ── authorize URL ──────────────────────────────────────────────────────

export interface BuildChatGptAuthorizeUrlOptions {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly originator?: string | undefined;
  /** Optional comma-separated workspace restriction. */
  readonly allowedWorkspaceId?: string | undefined;
}

export function buildChatGptAuthorizeUrl(options: BuildChatGptAuthorizeUrlOptions): string {
  const issuer = (options.issuer ?? CHATGPT_CODEX_ISSUER).replace(/\/+$/, '');
  const url = new URL(`${issuer}/oauth/authorize`);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', options.clientId ?? CHATGPT_CODEX_CLIENT_ID);
  params.set('redirect_uri', options.redirectUri);
  params.set('scope', CHATGPT_CODEX_SCOPE);
  params.set('code_challenge', options.codeChallenge);
  params.set('code_challenge_method', 'S256');
  params.set('id_token_add_organizations', 'true');
  params.set('codex_cli_simplified_flow', 'true');
  params.set('state', options.state);
  params.set('originator', options.originator ?? CHATGPT_CODEX_ORIGINATOR);
  if (options.allowedWorkspaceId !== undefined && options.allowedWorkspaceId.length > 0) {
    params.set('allowed_workspace_id', options.allowedWorkspaceId);
  }
  return url.toString();
}

// ── localhost callback server ──────────────────────────────────────────

export interface ChatGptCallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface ChatGptCallbackServer {
  /** The port actually bound (1455, or 1457 when 1455 was occupied). */
  readonly port: number;
  /** `http://localhost:{port}/auth/callback` — the redirect_uri to advertise. */
  readonly redirectUri: string;
  /**
   * Resolves with the authorization code once the browser hits
   * `/auth/callback` with a matching state; rejects when `/cancel` is hit or
   * the signal aborts. A state mismatch answers 400 and keeps waiting.
   */
  waitForCallback(options?: { readonly signal?: AbortSignal | undefined }): Promise<ChatGptCallbackResult>;
  close(): Promise<void>;
}

export interface StartChatGptCallbackServerOptions {
  readonly state: string;
  /** Ports to try in order; defaults to the allow-listed [1455, 1457]. */
  readonly ports?: readonly number[] | undefined;
}

const SUCCESS_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cloud Code CLI</title></head>' +
  '<body><h1>Login successful</h1><p>You can close this window and return to Cloud Code CLI.</p>' +
  '</body></html>';
const CANCEL_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cloud Code CLI</title></head>' +
  '<body><h1>Login cancelled</h1><p>You can close this window.</p></body></html>';
const ERROR_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cloud Code CLI</title></head>' +
  '<body><h1>Login failed</h1><p>Invalid or mismatched login state. Return to Cloud Code CLI and try again.</p>' +
  '</body></html>';

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

export async function startChatGptCallbackServer(
  options: StartChatGptCallbackServerOptions,
): Promise<ChatGptCallbackServer> {
  const ports = options.ports ?? CHATGPT_CODEX_LOGIN_PORTS;
  let lastError: unknown;

  for (const port of ports) {
    try {
      return await listenOnPort(port, options.state);
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // Port occupied — fall through to the next allow-listed port.
    }
  }
  throw new OAuthError(
    `Unable to start the ChatGPT login callback server on any allow-listed port (${ports.join(', ')}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function listenOnPort(port: number, expectedState: string): Promise<ChatGptCallbackServer> {
  return new Promise((resolveListen, rejectListen) => {
    let settled = false;
    let settleCallback: ((result: ChatGptCallbackResult) => void) | undefined;
    let rejectCallback: ((error: Error) => void) | undefined;
    const callbackPromise = new Promise<ChatGptCallbackResult>((resolve, reject) => {
      settleCallback = resolve;
      rejectCallback = reject;
    });
    // Handled rejections are consumed via waitForCallback; attach a no-op
    // catch so a settle before anyone waits never surfaces as unhandled.
    callbackPromise.catch(() => {});

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        if (state !== expectedState || code.length === 0) {
          // Bad state (CSRF / scanner noise) or a provider-side error:
          // answer 400 but keep waiting for the genuine browser callback.
          sendHtml(res, 400, ERROR_PAGE);
          return;
        }
        sendHtml(res, 200, SUCCESS_PAGE);
        if (!settled) {
          settled = true;
          settleCallback?.({ code, state });
        }
        return;
      }
      if (url.pathname === '/cancel') {
        sendHtml(res, 200, CANCEL_PAGE);
        if (!settled) {
          settled = true;
          rejectCallback?.(new OAuthError('Login cancelled before authorization completed.'));
        }
        return;
      }
      sendHtml(res, 404, ERROR_PAGE);
    });

    server.once('error', (error) => {
      rejectListen(error);
    });
    server.listen(port, '127.0.0.1', () => {
      resolveListen({
        port,
        redirectUri: `http://localhost:${port}/auth/callback`,
        waitForCallback: (waitOptions) => {
          const signal = waitOptions?.signal;
          if (signal === undefined) return callbackPromise;
          if (signal.aborted) {
            return Promise.reject(new OAuthError('Login aborted by caller'));
          }
          return new Promise<ChatGptCallbackResult>((resolve, reject) => {
            const onAbort = (): void => {
              reject(new OAuthError('Login aborted by caller'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            callbackPromise.then(
              (result) => {
                signal.removeEventListener('abort', onAbort);
                resolve(result);
              },
              (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error instanceof Error ? error : new OAuthError(String(error)));
              },
            );
          });
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
            // `close` only waits for existing connections; drop keep-alive
            // sockets (the browser's) so the port frees immediately.
            server.closeIdleConnections();
          }),
      });
    });
  });
}

// ── manual (headless) callback input parsing ───────────────────────────

export interface ParsedChatGptAuthorizationInput {
  readonly code: string;
  /** Present only when the user pasted a full callback URL. */
  readonly state?: string | undefined;
}

/**
 * Parse what a headless user pastes after the browser flow: either the full
 * callback URL (`http://localhost:1455/auth/callback?code=…&state=…`) or a
 * bare authorization code.
 */
export function parseChatGptAuthorizationInput(input: string): ParsedChatGptAuthorizationInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new OAuthError('Empty authorization input. Paste the callback URL or the code.');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new OAuthError('Could not parse the pasted callback URL.');
    }
    const errorParam = url.searchParams.get('error');
    if (errorParam !== null) {
      const description = url.searchParams.get('error_description');
      throw new OAuthError(`Authorization failed: ${description ?? errorParam}`);
    }
    const code = url.searchParams.get('code') ?? '';
    if (code.length === 0) {
      throw new OAuthError('The pasted callback URL does not contain a code parameter.');
    }
    const state = url.searchParams.get('state');
    return { code, state: state !== null && state.length > 0 ? state : undefined };
  }
  if (/\s/.test(trimmed)) {
    throw new OAuthError('Paste either the full callback URL or the bare authorization code.');
  }
  return { code: trimmed, state: undefined };
}

// ── HTTP helpers ───────────────────────────────────────────────────────

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages = new Set<string>();
  let current: Error | undefined = error;
  while (current !== undefined) {
    messages.add(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...messages].join(': ');
}

interface TokenEndpointResponse {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

async function postTokenEndpoint(
  url: string,
  options:
    | { readonly kind: 'form'; readonly params: Record<string, string> }
    | { readonly kind: 'json'; readonly body: Record<string, unknown> },
  requestOptions?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<TokenEndpointResponse> {
  const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (requestOptions?.signal !== undefined) signals.push(requestOptions.signal);
  const signal = AbortSignal.any(signals);
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string;
  if (options.kind === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.params).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal });
  } catch (error) {
    throw new OAuthConnectionError(
      `OAuth request to ${url} failed: ${describeFetchFailure(error)}`,
      { cause: error },
    );
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // Non-JSON response — leave data empty; caller interprets by status.
  }
  return { status: response.status, data };
}

/** Error code from a token-endpoint error body: `{error: 'code'}` or `{error: {code: '…'}}`. */
function errorCodeOf(data: Record<string, unknown>): string {
  const raw = data['error'];
  if (typeof raw === 'string') return raw;
  if (isRecord(raw) && typeof raw['code'] === 'string') return raw['code'];
  return '';
}

// ── authorization-code exchange ────────────────────────────────────────

export interface ChatGptTokenBundle {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface ExchangeChatGptAuthorizationCodeOptions {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly signal?: AbortSignal | undefined;
}

export async function exchangeChatGptAuthorizationCode(
  options: ExchangeChatGptAuthorizationCodeOptions,
): Promise<ChatGptTokenBundle> {
  const issuer = (options.issuer ?? CHATGPT_CODEX_ISSUER).replace(/\/+$/, '');
  const { status, data } = await postTokenEndpoint(
    `${issuer}/oauth/token`,
    {
      kind: 'form',
      params: {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId ?? CHATGPT_CODEX_CLIENT_ID,
        code_verifier: options.codeVerifier,
      },
    },
    { signal: options.signal },
  );

  if (status !== 200) {
    const detail = extractApiErrorMessage(data);
    throw new OAuthError(`ChatGPT code exchange failed (HTTP ${status}): ${detail ?? 'unknown'}`);
  }

  // All three tokens are required by the server contract.
  const idToken = data['id_token'];
  const accessToken = data['access_token'];
  const refreshToken = data['refresh_token'];
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new OAuthError('ChatGPT token response missing id_token');
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('ChatGPT token response missing access_token');
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError('ChatGPT token response missing refresh_token');
  }
  return { idToken, accessToken, refreshToken };
}

// ── refresh (JSON body, all-optional response, rotating refresh_token) ──

export interface ChatGptRefreshResult {
  readonly idToken?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
}

export interface RefreshChatGptAccessTokenOptions {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly refreshToken: string;
  readonly maxRetries?: number | undefined;
  readonly backoffMs?: ((attempt: number) => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function refreshChatGptAccessToken(
  options: RefreshChatGptAccessTokenOptions,
): Promise<ChatGptRefreshResult> {
  const issuer = (options.issuer ?? CHATGPT_CODEX_ISSUER).replace(/\/+$/, '');
  const url = `${issuer}/oauth/token`;
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoffMs ?? ((attempt: number) => 2 ** attempt * 1000);
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let status: number;
    let data: Record<string, unknown>;
    try {
      ({ status, data } = await postTokenEndpoint(
        url,
        {
          kind: 'json',
          body: {
            client_id: options.clientId ?? CHATGPT_CODEX_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: options.refreshToken,
          },
        },
        { signal: options.signal },
      ));
    } catch (error) {
      // Transport-level failure (DNS, refused, timeout) — retryable.
      lastError = error instanceof Error ? error : new OAuthError(String(error));
      if (attempt < maxRetries - 1) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    if (status === 200) {
      return {
        idToken: typeof data['id_token'] === 'string' ? data['id_token'] : undefined,
        accessToken: typeof data['access_token'] === 'string' ? data['access_token'] : undefined,
        refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : undefined,
      };
    }

    const errorCode = errorCodeOf(data);
    const detail = extractApiErrorMessage(data);
    if (
      status === 401 ||
      status === 403 ||
      PERMANENT_REFRESH_ERROR_CODES.has(errorCode)
    ) {
      throw new OAuthUnauthorizedError(
        detail ?? `ChatGPT token refresh unauthorized (${errorCode || `HTTP ${status}`}).`,
      );
    }

    const desc = detail ?? `ChatGPT token refresh failed (HTTP ${status}).`;
    if (RETRYABLE_STATUSES.has(status)) {
      lastError = new RetryableRefreshError(desc);
      if (attempt < maxRetries - 1) {
        await sleep(backoff(attempt));
        continue;
      }
      // fall through: out of retries, surface the retryable error
    } else {
      throw new OAuthError(desc);
    }
  }

  throw lastError ?? new OAuthError('ChatGPT token refresh failed after retries.');
}

// ── revoke (best-effort) ───────────────────────────────────────────────

export interface RevokeChatGptTokenOptions {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly token: string;
  readonly tokenTypeHint: 'refresh_token' | 'access_token';
  readonly signal?: AbortSignal | undefined;
}

/**
 * `POST {issuer}/oauth/revoke`. Best-effort per the upstream contract:
 * callers delete the local credentials regardless of the outcome. Returns
 * whether the server accepted the revocation.
 */
export async function revokeChatGptToken(options: RevokeChatGptTokenOptions): Promise<boolean> {
  const issuer = (options.issuer ?? CHATGPT_CODEX_ISSUER).replace(/\/+$/, '');
  try {
    const { status } = await postTokenEndpoint(
      `${issuer}/oauth/revoke`,
      {
        kind: 'json',
        body: {
          token: options.token,
          token_type_hint: options.tokenTypeHint,
          client_id: options.clientId ?? CHATGPT_CODEX_CLIENT_ID,
        },
      },
      { signal: options.signal },
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

// ── end-to-end interactive login flow ──────────────────────────────────

export interface ChatGptCodexLoginFlowOptions {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly originator?: string | undefined;
  readonly allowedWorkspaceId?: string | undefined;
  /** Ports to try for the callback server (tests only; production uses 1455/1457). */
  readonly ports?: readonly number[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Invoked with the authorize URL once the callback server is listening. */
  readonly onAuthorizeUrl?: ((url: string) => void | Promise<void>) | undefined;
  /**
   * Headless fallback: when provided, raced against the browser callback.
   * Resolve with the pasted callback URL or bare code; resolve `undefined`
   * to keep waiting for the browser (e.g. stdin closed). Implementations
   * should settle on `signal` abort so cancellation isn't blocked.
   */
  readonly waitForManualCode?: (() => Promise<string | undefined>) | undefined;
}

export interface ChatGptCodexLoginFlowResult {
  readonly token: TokenInfo;
  readonly accountId?: string | undefined;
  readonly planType?: string | undefined;
  /** Callback port that was bound. */
  readonly port: number;
}

/**
 * Drive the browser login end-to-end: PKCE + state, callback server,
 * authorize URL, wait for the code (browser callback or pasted manual
 * input), exchange it for tokens, and shape the persisted TokenInfo
 * (expiresAt from the access_token JWT exp, accountId from id_token claims).
 *
 * Does NOT persist anything — callers (ChatGptOAuthManager.login) store.
 */
export async function runChatGptCodexLoginFlow(
  options: ChatGptCodexLoginFlowOptions = {},
): Promise<ChatGptCodexLoginFlowResult> {
  const throwIfAborted = (): void => {
    if (options.signal?.aborted === true) throw new OAuthError('Login aborted by caller');
  };
  throwIfAborted();

  const pkce = generatePkce();
  const state = generateOAuthState();
  const server = await startChatGptCallbackServer({ state, ports: options.ports });
  try {
    const authorizeUrl = buildChatGptAuthorizeUrl({
      issuer: options.issuer,
      clientId: options.clientId,
      redirectUri: server.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      originator: options.originator,
      allowedWorkspaceId: options.allowedWorkspaceId,
    });
    await options.onAuthorizeUrl?.(authorizeUrl);

    const callbackPromise = server.waitForCallback({ signal: options.signal });
    let code: string;
    if (options.waitForManualCode === undefined) {
      code = (await callbackPromise).code;
    } else {
      const waitForManual = options.waitForManualCode;
      const manualPromise = (async (): Promise<ChatGptCallbackResult> => {
        const input = await waitForManual();
        if (input === undefined) {
          // Manual entry unavailable (stdin closed / aborted): never settle,
          // leave the race to the browser callback.
          return new Promise<ChatGptCallbackResult>(() => {});
        }
        const parsed = parseChatGptAuthorizationInput(input);
        if (parsed.state !== undefined && parsed.state !== state) {
          throw new OAuthError('Pasted callback URL state does not match this login attempt.');
        }
        return { code: parsed.code, state };
      })();
      manualPromise.catch(() => {});
      code = (await Promise.race([callbackPromise, manualPromise])).code;
    }
    throwIfAborted();

    const bundle = await exchangeChatGptAuthorizationCode({
      issuer: options.issuer,
      clientId: options.clientId,
      code,
      redirectUri: server.redirectUri,
      codeVerifier: pkce.verifier,
      signal: options.signal,
    });

    const claims = parseChatGptIdTokenClaims(bundle.idToken);
    const expiresAt = jwtExpiresAt(bundle.accessToken) ?? 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token: TokenInfo = {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt,
      scope: CHATGPT_CODEX_SCOPE,
      tokenType: 'Bearer',
      expiresIn: expiresAt > 0 ? Math.max(0, expiresAt - nowSeconds) : 0,
      accountId: claims.accountId,
      idToken: bundle.idToken,
    };
    return { token, accountId: claims.accountId, planType: claims.planType, port: server.port };
  } finally {
    await server.close();
  }
}
