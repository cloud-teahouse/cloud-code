import { join } from 'node:path';

import { readConfigFile, writeConfigFile } from '../../config';
import type { CloudCodeConfig, OAuthRef } from '../../config';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  ChatGptOAuthManager,
  CLOUD_CODE_PROVIDER_NAME,
  FileTokenStorage,
  isChatGptCodexProvider,
  CloudCodeOAuthToolkit,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  type BearerTokenProvider,
  type CloudCodeHostIdentity,
  type CloudCodeOAuthLoginOptions,
  type ManagedKimiConfigShape,
} from '@cloud-code/oauth';

import type { IEnvironmentService } from '../environment/environment';

type ServicesManagedConfig = CloudCodeConfig & ManagedKimiConfigShape;

type ServicesAuthLoginOptions = Omit<CloudCodeOAuthLoginOptions, 'provisionConfig'>;

interface ServicesAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

interface ServicesAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ServicesAuthFacade {
  login(
    providerName?: string | undefined,
    options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult>;
  logout(providerName?: string | undefined): Promise<ServicesAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined>;
  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
}

class ServicesManagedAuthFacade implements ServicesAuthFacade {
  private readonly toolkit: CloudCodeOAuthToolkit<ServicesManagedConfig>;
  private chatGptManager: ChatGptOAuthManager | undefined;

  constructor(
    private readonly options: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
    identity?: CloudCodeHostIdentity,
  ) {
    this.toolkit = new CloudCodeOAuthToolkit<ServicesManagedConfig>({
      homeDir: options.homeDir,
      identity,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as ServicesManagedConfig,
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
   * directory (`{homeDir}/credentials`) and lock root so both managers
   * coordinate cross-process through the same mechanism.
   */
  private chatGpt(): ChatGptOAuthManager {
    this.chatGptManager ??= new ChatGptOAuthManager({
      storage: new FileTokenStorage(join(this.options.homeDir, 'credentials')),
      configDir: this.options.homeDir,
    });
    return this.chatGptManager;
  }

  async login(
    providerName: string | undefined = CLOUD_CODE_PROVIDER_NAME,
    options: ServicesAuthLoginOptions = {},
  ): Promise<ServicesAuthLoginResult> {
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
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(
    providerName?: string | undefined,
  ): Promise<ServicesAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
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
      // ChatGPT Codex: JSON-body refresh, JWT-exp expiry, and the
      // `ChatGPT-Account-ID` per-request header — handled by the dedicated
      // manager, never the Kimi device-flow one.
      const manager = this.chatGpt();
      return {
        getAccessToken: (options) => manager.ensureFresh(options),
        getAuthHeaders: () => manager.getAuthHeaders(),
      };
    }
    return this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? CLOUD_CODE_PROVIDER_NAME;
    const config = readConfigFile(this.options.configPath);
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
    if ((providerName ?? CLOUD_CODE_PROVIDER_NAME) !== CLOUD_CODE_PROVIDER_NAME) {
      return oauthRef;
    }
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
}

export function createManagedAuthFacade(
  env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
  identity?: CloudCodeHostIdentity,
): ServicesAuthFacade {
  return new ServicesManagedAuthFacade(env, identity);
}
