import {
  getRootLogger,
  CloudCodeCore,
  resolveCloudCodeHome,
  resolveLoggingConfig,
  type OAuthTokenProviderResolver,
} from '@cloud-code/agent-core';
import type { InitializeResult } from '@cloud-code/protocol';

import type { JsonRpcConnection } from './jsonrpc/connection';
import { BridgeConnection, createCoreDispatcher } from './bridge';
import { EventJournal } from './event-journal';
import { SdkMultiplexer } from './sdk-multiplexer';

type InitializeResultServerInfo = InitializeResult['serverInfo'];

export interface ServerHostOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[] | undefined;
  readonly appVersion?: string | undefined;
  /**
   * Host UI mode of the serving process (`'print'` applies print-mode config
   * defaults to sessions created through it). Per-client uiMode
   * differentiation is a v2 concern (design §3).
   */
  readonly uiMode?: string | undefined;
  readonly serverInfo?: InitializeResultServerInfo | undefined;
  /**
   * Per-session capacity of the in-memory event journal ring buffer
   * (design §4 v2). Small values only make resync more likely on reconnect.
   */
  readonly eventJournalCapacity?: number | undefined;
}

/**
 * Single-process session host: one `CloudCodeCore` singleton, many client
 * connections, many sessions (design §2.1). Connections attach via
 * {@link ServerHost.attach}; each gets a `BridgeConnection` and the shared
 * `SdkMultiplexer` routes reverse calls by session ownership.
 */
export class ServerHost {
  readonly core: CloudCodeCore;
  readonly multiplexer: SdkMultiplexer;
  readonly journal: EventJournal;
  private readonly bridges = new Set<BridgeConnection>();
  private readonly serverInfo: InitializeResultServerInfo;

  constructor(options: ServerHostOptions = {}) {
    // The file sink is the only allowed log destination in serve mode:
    // stdout carries protocol frames exclusively.
    void getRootLogger().configure(
      resolveLoggingConfig({ homeDir: resolveCloudCodeHome(options.homeDir) }),
    );
    this.serverInfo = options.serverInfo ?? {
      name: 'cloud-code-server',
      version: options.appVersion ?? '0.0.0',
    };
    this.journal = new EventJournal(options.eventJournalCapacity);
    this.multiplexer = new SdkMultiplexer(this.journal);
    this.core = new CloudCodeCore(() => Promise.resolve(this.multiplexer.asSdkRpc()), {
      homeDir: options.homeDir,
      configPath: options.configPath,
      kimiRequestHeaders: options.kimiRequestHeaders,
      resolveOAuthTokenProvider: options.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      appVersion: options.appVersion,
      uiMode: options.uiMode,
    });
  }

  /** Bind a fresh client connection to the shared core. */
  attach(connection: JsonRpcConnection): BridgeConnection {
    const bridge = new BridgeConnection({
      connection,
      multiplexer: this.multiplexer,
      dispatch: createCoreDispatcher(this.core),
      serverInfo: this.serverInfo,
      homeDir: this.core.homeDir,
      onClose: (closed) => {
        this.bridges.delete(closed);
      },
    });
    this.bridges.add(bridge);
    return bridge;
  }

  get connectionCount(): number {
    return this.bridges.size;
  }

  async close(): Promise<void> {
    // connection.close() removes the bridge from this.bridges via onClose;
    // Set deletion during iteration is well-defined.
    for (const bridge of this.bridges) {
      bridge.connection.close();
    }
    // Release core-held resources (MCP child processes, cron/background-task
    // timers, session log handles) so a serve process whose client went away
    // can actually exit instead of lingering as an orphan. Session.close()
    // failures must not strand the remaining sessions or the logger flush.
    await Promise.allSettled(
      Array.from(this.core.sessions.keys(), (sessionId) =>
        this.core.closeSession({ sessionId }),
      ),
    );
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block shutdown
    }
  }
}
