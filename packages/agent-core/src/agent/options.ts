import type { Kaos } from '@cloud-code/kaos';
import type { generate } from '@cloud-code/kosong';

import type { CloudCodeConfig, SDKAgentRPC } from '#/rpc';
import type { Logger } from '#/logging/types';
import type { EnabledPluginSessionStart, EnabledPluginSystemPrompt, PluginCommandDef } from '#/plugin';
import type { McpConnectionManager } from '../mcp';
import type { ExperimentalFlagResolver } from '../flags';
import type { ImageLimits } from '../tools/support/image-limits';
import type { PreparedSystemPromptContext } from '../profile';
import type { OutputStyleDefinition } from '../profile/output-style';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { HookEngine } from '../session/hooks';
import type { ToolServices } from '../tools/support/services';
import type {
  CompactionStrategy,
  GraduatedCompactionConfigInput,
} from './compaction';
import type { PermissionManagerOptions } from './permission';
import type { AgentRecordPersistence } from './records';
import type { ReplayBuilderOptions } from './replay';
import type { SkillRegistry } from './skill/types';
import type { MailboxService } from './swarm/mailbox-service';
import type { TeamStore } from './swarm/team-store';

export type AgentType = 'main' | 'sub' | 'independent';

export interface AgentOptions {
  readonly kaos: Kaos;
  readonly config?: CloudCodeConfig;
  readonly homedir?: string;
  /**
   * Session-shared team store: the team files and shared task lists at
   * `<sessionDir>/teams/`. Provided by the session for every agent it owns;
   * standalone agents get none (TeamTask* tools stay unregistered).
   */
  readonly teamStore?: TeamStore;
  /**
   * Session-shared mailbox service: per-team inboxes, delivery
   * watchers, and the shutdown protocol. Provided by the session for every
   * agent it owns; standalone agents get none (SendMessage stays
   * unregistered).
   */
  readonly mailbox?: MailboxService;
  /**
   * Brand home (`CLOUD_CODE_HOME`) of the owning core, used by subsystems that
   * keep workspace-level state outside the session dir — currently the
   * shadow-git snapshot repos at `<brandHomeDir>/snapshots/<workdir-key>/`.
   * When unset, file snapshots stay disabled.
   */
  readonly brandHomeDir?: string;
  /**
   * Session-owned directory for pre-compression image originals
   * (`sessionMediaOriginalsDir(sessionDir)`), threaded to media-producing
   * paths (MCP tool results) so readback originals live with the session
   * rather than in the shared temp-dir fallback.
   */
  readonly mediaOriginalsDir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly graduatedCompaction?: GraduatedCompactionConfigInput;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: SessionSubagentHost | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly pluginSystemPrompts?: readonly EnabledPluginSystemPrompt[];
  readonly pluginCommands?: readonly PluginCommandDef[];
  readonly experimentalFlags?: ExperimentalFlagResolver;
  /** Owner-scoped [image] limits; a standalone Agent gets env/built-in defaults. */
  readonly imageLimits?: ImageLimits;
  readonly replay?: ReplayBuilderOptions;
  readonly additionalDirs?: readonly string[];
  readonly systemPromptContextProvider?: (() => Promise<PreparedSystemPromptContext>) | undefined;
  /**
   * Session-owned output-style registry, read live at every prompt render so
   * styles discovered asynchronously (user/project/plugin dirs) apply without
   * re-injecting. Standalone agents without a provider fall back to the
   * bundled styles.
   */
  readonly outputStylesProvider?: (() => readonly OutputStyleDefinition[]) | undefined;
}
