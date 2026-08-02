import {
  loadRuntimeConfigSafe,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
  type CloudCodeConfig,
  type OAuthRef,
} from '@cloud-code/agent-core';
import {
  applyChatGptCodexConfig,
  applyChatGptCodexLogoutConfig,
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  CHATGPT_CODEX_PROVIDER_NAME,
  ChatGptOAuthManager,
  CLOUD_CODE_PROVIDER_NAME,
  FileTokenStorage,
  isChatGptCodexProvider,
  CloudCodeOAuthToolkit,
  OAuthUnauthorizedError,
  provisionChatGptCodexConfig,
  createCloudCodeUserAgent,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type ChatGptCodexProvisionResult,
  type ChatGptLoginOptions,
  type CodexPlanUsage,
  type CodexResetCreditsList,
  type ConsumeCodexResetCreditResult,
  type FetchCompleteFeedbackUploadResult,
  type FetchFeedbackUploadError,
  type FetchSubmitFeedbackResult,
  type CloudCodeHostIdentity,
  type CloudCodeOAuthLoginOptions,
  type ManagedKimiConfigShape,
  type OAuthAccountSnapshot,
  type OAuthRefreshOutcome,
} from '@cloud-code/oauth';

import { join } from 'node:path';

import { mapOAuthTokenError } from '#/oauth-error';

export interface CloudCodeAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export interface CloudCodeAuthCreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CloudCodeAuthCompleteFeedbackUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface CloudCodeAuthCompleteFeedbackUploadInput {
  readonly uploadId: number;
  readonly parts: readonly CloudCodeAuthCompleteFeedbackUploadPart[];
}

export interface CloudCodeAuthFeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface CloudCodeAuthCreateFeedbackUploadUrlOk {
  readonly kind: 'ok';
  readonly uploadId: number;
  readonly parts: readonly CloudCodeAuthFeedbackUploadPart[];
}

export type CloudCodeAuthCreateFeedbackUploadUrlResult =
  | CloudCodeAuthCreateFeedbackUploadUrlOk
  | FetchFeedbackUploadError;

export type CloudCodeAuthLoginOptions = Omit<CloudCodeOAuthLoginOptions, 'provisionConfig'> & {
  /**
   * ChatGPT Codex login only: invoked with the authorize URL once the local
   * callback server is listening (open the browser / show the URL).
   */
  readonly onAuthorizeUrl?: ((url: string) => void | Promise<void>) | undefined;
  /**
   * ChatGPT Codex login only: headless paste fallback raced against the
   * browser callback — resolve with the pasted callback URL or bare code,
   * or `undefined` to keep waiting for the browser.
   */
  readonly waitForManualCode?: (() => Promise<string | undefined>) | undefined;
};

export interface CloudCodeAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface CloudCodeAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface CloudCodeAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: CloudCodeHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: CloudCodeConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = CloudCodeConfig & ManagedKimiConfigShape;

export class CloudCodeAuthFacade {
  private readonly toolkit: CloudCodeOAuthToolkit<SDKManagedConfig>;
  private chatGptManager: ChatGptOAuthManager | undefined;

  constructor(private readonly options: CloudCodeAuthFacadeOptions) {
    this.toolkit = new CloudCodeOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        // Write-path base read: strict (a salvaged base would drop the user's
        // broken-but-fixable sections on rewrite) with an actionable message.
        read: () => readConfigFileForUpdate(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  /**
   * Lazily-created ChatGPT Codex token manager. Shares the Kimi credential
   * directory and lock root; refresh outcomes flow into the same observer
   * so refresh status reporting stays uniform across providers.
   */
  private chatGpt(): ChatGptOAuthManager {
    const identity = this.options.identity;
    this.chatGptManager ??= new ChatGptOAuthManager({
      storage: new FileTokenStorage(join(this.options.homeDir, 'credentials')),
      configDir: this.options.homeDir,
      userAgent: identity === undefined ? undefined : createCloudCodeUserAgent(identity),
      onRefresh: this.options.onRefresh,
    });
    return this.chatGptManager;
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    if (isChatGptCodexProvider(providerName)) {
      return {
        providers: [
          {
            providerName: CHATGPT_CODEX_PROVIDER_NAME,
            hasToken: await this.chatGpt().hasToken(),
          },
        ],
      };
    }
    return this.toolkit.status(providerName, this.resolveRuntimeManagedAuth(providerName).oauthRef);
  }

  /**
   * Network-free account snapshot for status surfaces: login state
   * (logged-in / expired / not-logged-in); ChatGPT Codex additionally
   * reports the id_token account claims (email / plan type / account id).
   */
  async getAccountSnapshot(providerName?: string | undefined): Promise<OAuthAccountSnapshot> {
    if (isChatGptCodexProvider(providerName)) {
      return this.chatGpt().getAccountSnapshot();
    }
    return this.toolkit.getAccountSnapshot(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
  }

  /**
   * Fresh ChatGPT Codex plan usage from the backend usage endpoint (codex
   * /status parity). Refreshes the stored token when needed; endpoint
   * failures throw — status surfaces catch and fall back to the
   * response-header snapshot. ChatGPT Codex provider only.
   */
  async fetchCodexUsage(providerName?: string | undefined): Promise<CodexPlanUsage> {
    if (!isChatGptCodexProvider(providerName)) {
      throw new Error('fetchCodexUsage is only available for the ChatGPT Codex provider.');
    }
    return this.chatGpt().fetchCodexUsage();
  }

  /**
   * Reset-credit details behind the usage payload's count — the redeemable
   * usage-limit resets codex's picker lists. ChatGPT Codex provider only.
   */
  async listCodexResetCredits(providerName?: string | undefined): Promise<CodexResetCreditsList> {
    if (!isChatGptCodexProvider(providerName)) {
      throw new Error('listCodexResetCredits is only available for the ChatGPT Codex provider.');
    }
    return this.chatGpt().listResetCredits();
  }

  /**
   * Redeem one usage-limit reset credit. `redeemRequestId` is the idempotency
   * key — one fresh uuid per user-confirmed attempt. ChatGPT Codex provider
   * only.
   */
  async consumeCodexResetCredit(
    redeemRequestId: string,
    creditId?: string | undefined,
    providerName?: string | undefined,
  ): Promise<ConsumeCodexResetCreditResult> {
    if (!isChatGptCodexProvider(providerName)) {
      throw new Error('consumeCodexResetCredit is only available for the ChatGPT Codex provider.');
    }
    return this.chatGpt().consumeResetCredit(redeemRequestId, creditId);
  }

  async login(
    providerName: string | undefined = CLOUD_CODE_PROVIDER_NAME,
    options: CloudCodeAuthLoginOptions = {},
  ): Promise<CloudCodeAuthLoginResult> {
    if (isChatGptCodexProvider(providerName)) {
      return this.loginChatGptCodex(options);
    }
    const auth = this.resolveManagedAuth(providerName);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
      requestedBaseUrl: options.baseUrl,
      requestedOAuthHost: options.oauthHost,
    });
    const result = await this.toolkit.login(providerName, {
      ...options,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      oauthRef: options.oauthRef ?? loginAuth.oauthRef,
      provisionConfig: true,
    });
    if (result.provision === undefined) {
      throw new Error('Kimi auth login did not provision model config.');
    }
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  /**
   * ChatGPT Codex login: authorization-code + PKCE against auth.openai.com
   * with a localhost callback server, then provision the provider/model
   * config from the Codex backend's model catalog. Mirrors the Kimi
   * toolkit's structure: reuse a still-valid token, fall back to a fresh
   * browser login on unauthorized, and retry the provisioning fetch once
   * with a forced refresh before giving up.
   */
  private async loginChatGptCodex(options: CloudCodeAuthLoginOptions): Promise<CloudCodeAuthLoginResult> {
    const manager = this.chatGpt();
    const hadToken = await manager.hasToken();
    let usedBrowserLogin = false;
    const loginWithBrowser = async (): Promise<string> => {
      usedBrowserLogin = true;
      const loginOptions: ChatGptLoginOptions = {
        signal: options.signal,
        onAuthorizeUrl: options.onAuthorizeUrl,
        waitForManualCode: options.waitForManualCode,
      };
      return (await manager.login(loginOptions)).accessToken;
    };
    let accessToken: string;
    if (hadToken) {
      try {
        accessToken = await manager.ensureFresh();
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError)) throw error;
        accessToken = await loginWithBrowser();
      }
    } else {
      accessToken = await loginWithBrowser();
    }

    // The models endpoint requires the ChatGPT-Account-ID header, which the
    // manager reads from the stored credential; resolve it fresh each attempt
    // so a rotated account id is picked up.
    const provisionWithAccount = async (token: string): Promise<ChatGptCodexProvisionResult> =>
      provisionChatGptCodexConfig({
        accessToken: token,
        accountId: await manager.getAccountId(),
        adapter: this.chatGptConfigAdapter(),
        preserveDefaultModel: hadToken,
        // NB: no `clientVersion` — the backend returns an empty catalog for
        // any real version string (gated by models' minimal_client_version);
        // only the default 0.0.0 returns models. See chatgpt-codex.ts.
      });

    let provision: ChatGptCodexProvisionResult;
    try {
      provision = await provisionWithAccount(accessToken);
    } catch (error) {
      if (!(error instanceof OAuthUnauthorizedError) || !hadToken || usedBrowserLogin) {
        throw error;
      }
      let retryToken: string;
      try {
        retryToken = await manager.ensureFresh({ force: true });
      } catch (refreshError) {
        if (!(refreshError instanceof OAuthUnauthorizedError)) throw refreshError;
        retryToken = await loginWithBrowser();
      }
      try {
        provision = await provisionWithAccount(retryToken);
      } catch (retryError) {
        if (!(retryError instanceof OAuthUnauthorizedError) || usedBrowserLogin) {
          throw retryError;
        }
        provision = await provisionWithAccount(await loginWithBrowser());
      }
    }

    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: CHATGPT_CODEX_PROVIDER_NAME,
      ok: true,
      defaultModel: provision.defaultModel,
      defaultThinking: provision.defaultThinking,
      configPath: provision.configPath,
    };
  }

  private chatGptConfigAdapter() {
    return {
      configPath: this.options.configPath,
      read: () => readConfigFileForUpdate(this.options.configPath) as SDKManagedConfig,
      write: async (config: SDKManagedConfig) => {
        await writeConfigFile(this.options.configPath, config);
      },
      apply: applyChatGptCodexConfig,
      remove: applyChatGptCodexLogoutConfig,
    };
  }

  async logout(providerName?: string | undefined): Promise<CloudCodeAuthLogoutResult> {
    if (isChatGptCodexProvider(providerName)) {
      // Best-effort server-side revoke happens inside the manager; the
      // config cleanup runs regardless of its outcome.
      await this.chatGpt().logout();
      const config = readConfigFileForUpdate(this.options.configPath) as SDKManagedConfig;
      applyChatGptCodexLogoutConfig(config);
      await writeConfigFile(this.options.configPath, config);
      const updated = readConfigFile(this.options.configPath);
      this.options.onConfigUpdated?.(updated);
      return { providerName: CHATGPT_CODEX_PROVIDER_NAME, ok: true };
    }
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.getManagedUsage(providerName, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  async submitFeedback(
    input: CloudCodeAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.submitFeedback(
      {
        session_id: input.sessionId,
        content: input.content,
        version: input.version,
        os: input.os,
        model: input.model,
        contact: input.contact,
        info: input.info,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async createFeedbackUploadUrl(
    input: CloudCodeAuthCreateFeedbackUploadUrlInput,
    providerName?: string | undefined,
  ): Promise<CloudCodeAuthCreateFeedbackUploadUrlResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    const result = await this.toolkit.createFeedbackUploadUrl(
      {
        file_hash: input.sha256,
        file_name: input.filename,
        file_size: input.size,
        feedback_id: input.feedbackId,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      uploadId: result.upload_id,
      parts: result.parts.map((part) => ({
        partNumber: part.part_number,
        url: part.url,
        method: part.method,
        size: part.size,
      })),
    };
  }

  async completeFeedbackUpload(
    input: CloudCodeAuthCompleteFeedbackUploadInput,
    providerName?: string | undefined,
  ): Promise<FetchCompleteFeedbackUploadResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.completeFeedbackUpload(
      {
        upload_id: input.uploadId,
        parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    if (isChatGptCodexProvider(providerName, oauthRef)) {
      return this.chatGpt().getCachedAccessToken();
    }
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    if (isChatGptCodexProvider(providerName, oauthRef)) {
      // ChatGPT Codex: JSON-body refresh + JWT-exp expiry via the dedicated
      // manager, plus the `ChatGPT-Account-ID` per-request header.
      const manager = this.chatGpt();
      return {
        getAccessToken: async (options) => {
          try {
            return await manager.ensureFresh(options);
          } catch (error) {
            throw mapOAuthTokenError(error, providerName) ?? error;
          }
        },
        getAuthHeaders: () => manager.getAuthHeaders(),
      };
    }
    const provider = this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
    return {
      getAccessToken: async (options) => {
        try {
          return await provider.getAccessToken(options);
        } catch (error) {
          // Classify OAuth token failures into the public CloudCodeError protocol;
          // unrecognized errors are rethrown raw (see mapOAuthTokenError).
          throw mapOAuthTokenError(error, providerName) ?? error;
        }
      },
    };
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? CLOUD_CODE_PROVIDER_NAME;
    // Read path: token/status resolution must work off a degraded config
    // instead of failing the session when an unrelated section is broken.
    // Write paths (the toolkit's configAdapter.read) stay strict.
    const config = loadRuntimeConfigSafe(this.options.configPath).config;
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,
      baseUrl: provider?.baseUrl,
    };
  }

  private resolveRuntimeManagedAuth(providerName?: string | undefined): {
    readonly oauthRef: OAuthRef;
    readonly baseUrl?: string | undefined;
  } {
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
    });
  }

  private runtimeOAuthRef(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): OAuthRef | undefined {
    if ((providerName ?? CLOUD_CODE_PROVIDER_NAME) !== CLOUD_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
}
