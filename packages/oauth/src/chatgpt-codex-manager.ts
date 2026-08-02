/**
 * ChatGptOAuthManager — ChatGPT Codex token lifecycle (load / refresh /
 * login / logout).
 *
 * Deliberately a sibling to {@link OAuthManager} rather than an extension of
 * it (research doc §5.2(b)): the ChatGPT refresh contract differs too much —
 * JSON request body instead of form-encoding, no `expires_in` in the
 * response (expiry comes from the access_token JWT `exp`), and permanent
 * refresh_token rotation errors (`refresh_token_expired/reused/invalidated`)
 * that must tombstone the stored credential. Kimi's device-flow manager is
 * left untouched.
 *
 * Reused from the Kimi implementation:
 *  - `TokenStorage` wire format (TokenInfo gained optional accountId/idToken)
 *  - the proper-lockfile cross-process refresh lock + post-lock re-read +
 *    peer-rotation recovery (critical for ChatGPT's rotating refresh_token)
 *  - `TokenState` classification and the `revokedTombstone` convention
 *
 * Proactive refresh window: 5 minutes before the JWT exp
 * (CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES=5 upstream).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import {
  chatGptAccountSnapshotFromTokenState,
  type OAuthAccountSnapshot,
} from './account-snapshot';
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_CLIENT_ID,
  CHATGPT_CODEX_ISSUER,
  CHATGPT_CODEX_TOKEN_STORAGE_NAME,
} from './chatgpt-codex';
import {
  jwtExpiresAt,
  parseChatGptIdTokenClaims,
  refreshChatGptAccessToken,
  revokeChatGptToken,
  runChatGptCodexLoginFlow,
  type ChatGptCodexLoginFlowOptions,
} from './chatgpt-codex-flow';
import {
  CHATGPT_CODEX_RESET_CREDITS_URL,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  type CodexResetCreditsList,
  type ConsumeCodexResetCreditResult,
} from './chatgpt-codex-reset-credits';
import {
  CHATGPT_CODEX_USAGE_URL,
  fetchCodexPlanUsage,
  type CodexPlanUsage,
} from './chatgpt-codex-usage';
import { OAuthError, OAuthUnauthorizedError } from './errors';
import type { OAuthRefreshOutcome } from './oauth-manager';
import type { TokenStorage } from './storage';
import { classifyToken, revokedTombstone, type TokenState } from './token-state';
import type { TokenInfo } from './types';

const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;

/**
 * The reset-credits endpoints are path siblings of the usage endpoint on the
 * same backend (codex PathStyle::ChatGptApi swaps `/wham/usage` for
 * `/wham/rate-limit-reset-credits`), so the test-only usageUrl override
 * automatically retargets them. A custom usage URL without the suffix keeps
 * the production default rather than guessing.
 */
function deriveResetCreditsUrl(usageUrl: string): string {
  const usageSuffix = '/wham/usage';
  return usageUrl.endsWith(usageSuffix)
    ? `${usageUrl.slice(0, -usageSuffix.length)}/wham/rate-limit-reset-credits`
    : CHATGPT_CODEX_RESET_CREDITS_URL;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface ChatGptOAuthManagerOptions {
  readonly storage: TokenStorage;
  /** Storage name / lockfile stem; defaults to 'chatgpt-codex'. */
  readonly name?: string | undefined;
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  /**
   * Root directory for the cross-process lock file
   * (`{configDir}/oauth/{name}.lock`). Same contract as OAuthManager:
   * production callers MUST pass it explicitly; the test-only
   * `CLOUD_CODE_HOME` fallback applies when NODE_ENV === 'test'.
   */
  readonly configDir?: string | undefined;
  readonly refreshThresholdSeconds?: number | undefined;
  /**
   * `/wham/usage` endpoint override; defaults to the production URL.
   * Tests point it at a local fake backend.
   */
  readonly usageUrl?: string | undefined;
  /**
   * `/wham/rate-limit-reset-credits` endpoint override; defaults to the
   * sibling of {@link usageUrl} (same derivation codex's PathStyle::ChatGptApi
   * applies to its base URL).
   */
  readonly resetCreditsUrl?: string | undefined;
  /** Product User-Agent sent on the usage-endpoint read (codex sends its CLI UA). */
  readonly userAgent?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: Sleep | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

export type ChatGptLoginOptions = Omit<ChatGptCodexLoginFlowOptions, 'issuer' | 'clientId'>;

export class ChatGptOAuthManager {
  private readonly storage: TokenStorage;
  private readonly name: string;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly refreshThresholdSeconds: number;
  private readonly usageUrl: string;
  private readonly resetCreditsUrl: string;
  private readonly userAgent: string | undefined;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly configDir: string | undefined;
  private readonly onRefresh: ((outcome: OAuthRefreshOutcome) => void) | undefined;

  /**
   * In-flight refresh coalescer — same force-aware semantics as
   * OAuthManager: non-force callers piggyback any in-flight call, a force
   * caller only piggybacks another force call.
   */
  private inFlightRefresh: { promise: Promise<string>; force: boolean } | undefined;

  constructor(options: ChatGptOAuthManagerOptions) {
    this.storage = options.storage;
    this.name = options.name ?? CHATGPT_CODEX_TOKEN_STORAGE_NAME;
    this.issuer = (options.issuer ?? CHATGPT_CODEX_ISSUER).replace(/\/+$/, '');
    this.clientId = options.clientId ?? CHATGPT_CODEX_CLIENT_ID;
    this.refreshThresholdSeconds =
      options.refreshThresholdSeconds ?? DEFAULT_REFRESH_THRESHOLD_SECONDS;
    this.usageUrl = options.usageUrl ?? CHATGPT_CODEX_USAGE_URL;
    this.resetCreditsUrl =
      options.resetCreditsUrl ?? deriveResetCreditsUrl(this.usageUrl);
    this.userAgent = options.userAgent;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = options.sleep ?? defaultSleep;
    this.onRefresh = options.onRefresh;
    const envConfigDir =
      process.env['NODE_ENV'] === 'test' ? process.env['CLOUD_CODE_HOME'] : undefined;
    this.configDir = options.configDir ?? envConfigDir;
  }

  private async loadState(): Promise<TokenState> {
    return classifyToken(await this.storage.load(this.name));
  }

  private notifyRefresh(outcome: OAuthRefreshOutcome): void {
    if (this.onRefresh === undefined) return;
    try {
      this.onRefresh(outcome);
    } catch {
      // Observer must not affect the OAuth flow.
    }
  }

  private resolveLockTarget(): string | undefined {
    if (process.platform === 'win32') return undefined;
    if (process.env['KIMI_DISABLE_OAUTH_LOCK'] === '1') return undefined;
    if (this.configDir === undefined) return undefined;
    return `${this.configDir}/oauth/${this.name}`;
  }

  /**
   * Same lock contract as OAuthManager: proper-lockfile against a sentinel
   * file, fail closed when a configured lock cannot be acquired — racing a
   * rotating refresh_token without the lock would permanently burn it.
   */
  private async acquireRefreshLock(): Promise<() => Promise<void>> {
    const target = this.resolveLockTarget();
    if (target === undefined) return async () => {};

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', { flag: 'a' });
    } catch (error) {
      throw new OAuthError(
        `Unable to prepare OAuth refresh lock for "${this.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const release = await lockfile.lock(target, {
        retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1_000 },
        stale: 5_000,
        realpath: false,
      });
      return async () => {
        try {
          await release();
        } catch {
          /* ignore release-after-stale */
        }
      };
    } catch (error) {
      throw new OAuthError(
        `Unable to acquire OAuth refresh lock for "${this.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async hasToken(): Promise<boolean> {
    return (await this.loadState()).kind === 'valid';
  }

  async getCachedAccessToken(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.kind === 'valid' ? state.token.accessToken : undefined;
  }

  /** The ChatGPT account id persisted at login/refresh time, if any. */
  async getAccountId(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.kind === 'valid' ? state.token.accountId : undefined;
  }

  /**
   * Network-free account snapshot for status surfaces: login state plus the
   * account claims (email / plan type / account id) parsed from the stored
   * id_token — the same claims source codex-rs uses for its /status account
   * row. Claims are absent when the stored token predates id_token retention.
   */
  async getAccountSnapshot(): Promise<OAuthAccountSnapshot> {
    return chatGptAccountSnapshotFromTokenState(await this.loadState());
  }

  /**
   * Per-request headers for Codex backend calls beyond the bearer token —
   * currently `ChatGPT-Account-ID`. Returns undefined when no account id is
   * stored so the caller can omit the header entirely.
   */
  async getAuthHeaders(): Promise<Record<string, string> | undefined> {
    const accountId = await this.getAccountId();
    if (accountId === undefined || accountId.length === 0) return undefined;
    return { [CHATGPT_ACCOUNT_ID_HEADER]: accountId };
  }

  /**
   * Fresh plan usage straight from the Codex backend (`GET /wham/usage`) —
   * the same direct read codex's own /status performs, and the only source
   * of the rate-limit-reset-credit count. The access token goes through the
   * normal {@link ensureFresh} refresh path first. A single attempt:
   * endpoint failures (Cloudflare challenge, 403, network) throw, and status
   * surfaces catch and fall back to the response-header snapshot rather than
   * burning a forced refresh here.
   */
  async fetchCodexUsage(): Promise<CodexPlanUsage> {
    const accessToken = await this.ensureFresh();
    const accountId = await this.getAccountId();
    return fetchCodexPlanUsage({
      accessToken,
      accountId,
      url: this.usageUrl,
      userAgent: this.userAgent,
    });
  }

  /**
   * Reset-credit details behind the usage payload's count (`GET
   * /wham/rate-limit-reset-credits`) — the list codex's reset picker shows
   * before redeeming. Same single-attempt contract as {@link fetchCodexUsage}:
   * endpoint failures throw for the caller to map.
   */
  async listResetCredits(): Promise<CodexResetCreditsList> {
    const accessToken = await this.ensureFresh();
    const accountId = await this.getAccountId();
    return fetchCodexResetCredits({
      accessToken,
      accountId,
      url: this.resetCreditsUrl,
      userAgent: this.userAgent,
    });
  }

  /**
   * Redeem one reset credit (`POST /wham/rate-limit-reset-credits/consume`).
   * `redeemRequestId` is the idempotency key — the caller mints one fresh
   * uuid per user-confirmed attempt; `creditId` pins a specific credit from
   * {@link listResetCredits} (omitted = the backend picks).
   */
  async consumeResetCredit(
    redeemRequestId: string,
    creditId?: string,
  ): Promise<ConsumeCodexResetCreditResult> {
    const accessToken = await this.ensureFresh();
    const accountId = await this.getAccountId();
    return consumeCodexResetCredit({
      accessToken,
      accountId,
      url: `${this.resetCreditsUrl}/consume`,
      userAgent: this.userAgent,
      redeemRequestId,
      creditId,
    });
  }

  /**
   * Best-effort server-side revocation followed by local deletion — per the
   * upstream contract the local credentials are removed regardless of the
   * revoke outcome. The refresh_token is revoked preferentially (it is the
   * long-lived credential); without one the access_token is revoked.
   */
  async logout(): Promise<void> {
    const state = await this.loadState();
    if (state.kind === 'valid') {
      const token = state.token;
      if (token.refreshToken.length > 0) {
        await revokeChatGptToken({
          issuer: this.issuer,
          clientId: this.clientId,
          token: token.refreshToken,
          tokenTypeHint: 'refresh_token',
        });
      } else if (token.accessToken.length > 0) {
        await revokeChatGptToken({
          issuer: this.issuer,
          clientId: this.clientId,
          token: token.accessToken,
          tokenTypeHint: 'access_token',
        });
      }
    }
    await this.storage.remove(this.name);
  }

  /**
   * Interactive authorization-code + PKCE login. `onAuthorizeUrl` receives
   * the URL to open in the browser; `waitForManualCode` is the headless
   * paste fallback. Persists the resulting token bundle on success.
   */
  async login(options: ChatGptLoginOptions = {}): Promise<TokenInfo> {
    const result = await runChatGptCodexLoginFlow({
      ...options,
      issuer: this.issuer,
      clientId: this.clientId,
    });
    await this.storage.save(this.name, result.token);
    return result.token;
  }

  /**
   * Return a valid access_token, refreshing when the JWT exp is within the
   * 5-minute window. Throws OAuthUnauthorizedError when no usable token is
   * stored (caller routes into re-login).
   */
  async ensureFresh(options: { force?: boolean } = {}): Promise<string> {
    const force = options.force === true;
    const current = this.inFlightRefresh;
    if (current !== undefined) {
      if (!force || current.force) {
        return current.promise;
      }
      return current.promise.catch(() => undefined).then(() => this.ensureFresh(options));
    }

    const promise = this.doEnsureFresh(force).finally(() => {
      if (this.inFlightRefresh?.promise === promise) {
        this.inFlightRefresh = undefined;
      }
    });
    this.inFlightRefresh = { promise, force };
    return promise;
  }

  private async doEnsureFresh(force: boolean): Promise<string> {
    const initial = await this.loadState();
    switch (initial.kind) {
      case 'missing':
        throw new OAuthUnauthorizedError(
          `No token for "${this.name}". Run /login to authenticate.`,
        );
      case 'revoked':
        throw new OAuthUnauthorizedError(
          `Stored token for "${this.name}" was rejected; re-login required.`,
        );
      case 'valid':
        break;
    }
    const token = initial.token;

    if (!this.shouldRefreshToken(token, force)) {
      return token.accessToken;
    }

    const release = await this.acquireRefreshLock();
    try {
      // Post-lock re-read: a peer process may have rotated the token while
      // we waited for the lock; short-circuit instead of burning the
      // single-use refresh_token a second time.
      const afterLock = await this.loadState();
      let activeToken: TokenInfo;
      switch (afterLock.kind) {
        case 'revoked':
          throw new OAuthUnauthorizedError(
            `Stored token for "${this.name}" was rejected; re-login required.`,
          );
        case 'missing':
          activeToken = token;
          break;
        case 'valid': {
          const after = afterLock.token;
          if (!this.shouldRefreshToken(after, force)) {
            return after.accessToken;
          }
          if (force) {
            const changedWhileWaiting =
              after.refreshToken !== token.refreshToken ||
              after.accessToken !== token.accessToken ||
              after.expiresAt !== token.expiresAt ||
              after.expiresIn !== token.expiresIn;
            if (changedWhileWaiting) {
              return after.accessToken;
            }
          }
          activeToken = after;
          break;
        }
      }

      if (activeToken.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError(
          `Token for "${this.name}" has no refresh_token; re-login required.`,
        );
      }

      try {
        const refreshed = await refreshChatGptAccessToken({
          issuer: this.issuer,
          clientId: this.clientId,
          refreshToken: activeToken.refreshToken,
          sleep: this.sleep,
        });
        const next = this.overlayRefreshedToken(activeToken, refreshed);
        await this.storage.save(this.name, next);
        this.notifyRefresh({ success: true });
        return next.accessToken;
      } catch (error) {
        if (error instanceof OAuthUnauthorizedError) {
          // Permanent failure (401/403 or refresh_token_expired/reused/
          // invalidated). Might still be a stale-token race: a peer process
          // may have rotated the refresh_token while we were mid-flight.
          // Re-read storage before tombstoning.
          await this.sleep(100);
          const recovery = await this.loadState();
          if (
            recovery.kind === 'valid' &&
            recovery.token.refreshToken !== activeToken.refreshToken
          ) {
            this.notifyRefresh({ success: true });
            return recovery.token.accessToken;
          }
          // No peer rotated — tombstone so a fresh process sees "previously
          // logged in, now rejected" instead of "never logged in".
          await this.storage.save(this.name, revokedTombstone(activeToken));
          this.notifyRefresh({ success: false, reason: 'unauthorized' });
        } else {
          this.notifyRefresh({ success: false, reason: 'network_or_other' });
        }
        throw error;
      }
    } finally {
      await release();
    }
  }

  /**
   * The refresh response fields are all optional — overlay whatever came
   * back onto the active token. A new access_token moves expiresAt to its
   * JWT exp (the response carries no expires_in); a new id_token refreshes
   * the cached account claims.
   */
  private overlayRefreshedToken(
    active: TokenInfo,
    refreshed: {
      readonly idToken?: string | undefined;
      readonly accessToken?: string | undefined;
      readonly refreshToken?: string | undefined;
    },
  ): TokenInfo {
    const accessToken = refreshed.accessToken ?? active.accessToken;
    const idToken = refreshed.idToken ?? active.idToken;
    const accountId =
      refreshed.idToken !== undefined
        ? (parseChatGptIdTokenClaims(refreshed.idToken).accountId ?? active.accountId)
        : active.accountId;
    const expiresAt =
      refreshed.accessToken !== undefined
        ? (jwtExpiresAt(refreshed.accessToken) ?? active.expiresAt)
        : active.expiresAt;
    return {
      accessToken,
      refreshToken: refreshed.refreshToken ?? active.refreshToken,
      expiresAt,
      scope: active.scope,
      tokenType: active.tokenType,
      expiresIn: expiresAt > 0 ? Math.max(0, expiresAt - this.now()) : 0,
      accountId,
      idToken,
    };
  }

  private shouldRefreshToken(token: TokenInfo, force: boolean): boolean {
    if (force) return true;
    // expiresAt === 0 means the access_token carried no parseable exp claim;
    // without expiry information there is no proactive refresh (a 401 still
    // triggers the caller's forced-refresh path).
    if (token.expiresAt === 0) return false;
    const remaining = token.expiresAt - this.now();
    return remaining < this.refreshThresholdSeconds;
  }
}
