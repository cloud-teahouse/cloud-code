import {
  createRPC,
  ensureConfigFile,
  getRootLogger,
  CloudCodeCore,
  resolveConfigPath,
  resolveCloudCodeHome,
  resolveLoggingConfig,
  type CoreAPI,
  type OAuthTokenProviderResolver,
  type RPCMethods,
  type SDKAPI,
} from '@cloud-code/agent-core';
import type { Kaos } from '@cloud-code/kaos';
import { assertCloudCodeHostIdentity, createCloudCodeDefaultHeaders } from '@cloud-code/oauth';

import { CloudCodeAuthFacade } from '#/auth';
import { CloudCodeHarness } from '#/cloud-code-harness';
import { RemoteRpcClient } from '#/remote-rpc-client';
import { ClientAPI, SDKRpcClientBase } from '#/rpc';
import type {
  CreateSessionOptions,
  CloudCodeHarnessOptions,
  CloudCodeHostIdentity,
  OAuthRefreshOutcome,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
} from '#/types';

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: CloudCodeHostIdentity;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly skillDirs?: readonly string[];
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  /**
   * Host UI mode (`'print'` for `cloud-code -p`, `'cli'` for the TUI, ...). Forwarded
   * to the v1 core, which applies print-mode config defaults when it is
   * `'print'`.
   */
  readonly uiMode?: string;
}

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: CloudCodeHostIdentity | undefined;
  readonly auth: CloudCodeAuthFacade;
  readonly core: CloudCodeCore;

  private readonly ready: Promise<RPCMethods<CoreAPI>>;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertCloudCodeHostIdentity(options.identity);
    this.homeDir = resolveCloudCodeHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.auth = new CloudCodeAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    this.core = new CloudCodeCore(coreRpc, {
      homeDir: options.homeDir,
      configPath: this.configPath,
      cloudCodeRequestHeaders: this.createCloudCodeRequestHeaders(),
      resolveOAuthTokenProvider:
        options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      appVersion: this.identity?.version,
      uiMode: options.uiMode,
    });
    this.ready = sdkRpc(new ClientAPI(this));
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }

  protected async getRpc(): Promise<RPCMethods<CoreAPI>> {
    return this.ready;
  }

  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    const { planMode, ...coreInput } = input;
    void planMode;
    return this.core.createSessionWithOverrides(coreInput, { kaos, persistenceKaos });
  }

  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    return this.core.resumeSessionWithOverrides(
      { ...input, sessionId: input.id },
      { kaos, persistenceKaos },
    );
  }

  private createCloudCodeRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createCloudCodeDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
  }
}

export function createCloudCodeHarness(options: CloudCodeHarnessOptions): CloudCodeHarness {
  if (options.transport !== undefined && options.transport !== 'local') {
    return createRemoteCloudCodeHarness(options);
  }
  const rpc = new SDKRpcClient(options);
  return new CloudCodeHarness(rpc, {
    identity: rpc.identity,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: rpc.core.imageLimits,
  });
}

/**
 * Remote-transport harness (stdio spawn or ws attach). Identical harness API;
 * only the RPC transport differs. `imageLimits` stays undefined on
 * daemon-client hosts, as `CloudCodeHarnessRuntimeOptions.imageLimits` documents.
 */
function createRemoteCloudCodeHarness(options: CloudCodeHarnessOptions): CloudCodeHarness {
  const transport = options.transport;
  if (
    transport === undefined ||
    transport === 'local' ||
    (transport.type !== 'stdio' && transport.type !== 'ws')
  ) {
    throw new Error(`Unsupported harness transport: ${JSON.stringify(transport)}`);
  }
  const rpc = new RemoteRpcClient({ ...options, transport });
  return new CloudCodeHarness(rpc, {
    identity: rpc.identity,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: undefined,
  });
}
