/**
 * `/sandbox` status report (F1 introspection): assembles a serializable
 * snapshot of the OS command sandbox from the same inputs
 * `AgentToolSet.resolveBashSandbox` uses to decorate the Bash kaos — the
 * `[sandbox]` config section, the kaos environment, and the session's
 * `SandboxManager` probe cache. Read-only: the guard plan only lstats, and
 * the manager probe is the same smoke run an exec would trigger.
 */

import {
  bareGitRepoGuardPaths,
  planSandboxGuard,
  type Kaos,
  type SandboxBackendStatus,
  type SandboxManager,
  type SandboxMode,
  type SandboxNetworkMode,
  type SandboxPolicy,
} from '@cloud-code/kaos';

import { resolveCloudCodeHome, type SandboxConfig } from '#/config';

import { collectControlPlaneGuardPaths } from './tool/control-plane-paths';

export type SandboxEscalation = NonNullable<SandboxConfig['escalation']>;

export interface SandboxGuardStatus {
  /** Existing control-plane paths the guard re-binds read-only per run. */
  readonly readOnlySubpaths: readonly string[];
  /** Missing paths the guard deletes from the host if a command plants them. */
  readonly scrubPaths: readonly string[];
}

export interface SandboxStatusData {
  readonly mode: SandboxMode;
  /** Whether a `[sandbox]` section exists in config.toml (vs. all defaults). */
  readonly configured: boolean;
  /** `Kaos.name` of the execution environment ('local' or e.g. an SSH target). */
  readonly environment: string;
  readonly local: boolean;
  readonly workspaceCwd: string;
  readonly network: SandboxNetworkMode;
  readonly escalation: SandboxEscalation;
  /** `writable_roots` / `deny_read` entries as configured (pre-expansion). */
  readonly configuredWritableRoots: readonly string[];
  readonly configuredDenyRead: readonly string[];
  /** Effective policy: workspace + /tmp + extras; default + brand-home + configured masks. */
  readonly policy: SandboxPolicy;
  readonly guard: SandboxGuardStatus;
  readonly backends: readonly SandboxBackendStatus[];
  readonly plan:
    | { readonly kind: 'sandboxed'; readonly backend: string }
    | { readonly kind: 'unsandboxed'; readonly reason: string };
  /** Fail-closed explanation for `enforce` on a non-local environment. */
  readonly unavailableReason?: string;
}

/**
 * Narrow inputs so the report can be built (and tested) without a full
 * `Agent`; the RPC handler wires the agent's fields in verbatim.
 */
export interface SandboxStatusSource {
  readonly sandboxConfig: SandboxConfig | undefined;
  readonly kaos: Kaos;
  readonly homedir?: string | undefined;
  readonly brandHomeDir?: string | undefined;
  readonly skillRoots: readonly string[];
  readonly manager: SandboxManager;
}

export async function buildSandboxStatus(source: SandboxStatusSource): Promise<SandboxStatusData> {
  const { sandboxConfig, kaos, manager } = source;
  const mode = sandboxConfig?.mode ?? 'auto';
  const local = kaos.name === 'local';
  const workspaceCwd = kaos.getcwd();
  const configuredWritableRoots = sandboxConfig?.writableRoots ?? [];
  const configuredDenyRead = sandboxConfig?.denyRead ?? [];

  // Same plan input resolveBashSandbox builds: the brand home is masked on
  // top of kaos's built-in credential list, user deny_read entries merge last.
  const inspection = await manager.inspect({
    mode,
    network: sandboxConfig?.network ?? 'allow',
    workspaceCwd,
    writableRoots: configuredWritableRoots,
    denyReadPaths: [source.homedir ?? resolveCloudCodeHome(), ...configuredDenyRead],
    kaosName: kaos.name,
  });

  // Same guard candidates as the SandboxedKaos decoration, planned once
  // against current filesystem state (lstat-only).
  const guardPaths = collectControlPlaneGuardPaths({
    cwd: workspaceCwd,
    brandHomeDir: source.brandHomeDir ?? resolveCloudCodeHome(),
    userHomeDir: kaos.gethome(),
    skillRoots: source.skillRoots,
  });
  const guardPlan = planSandboxGuard({
    scrubCandidates: [...bareGitRepoGuardPaths([workspaceCwd]), ...guardPaths.scrubPaths],
    readOnlyCandidates: guardPaths.readOnlyPaths,
  });

  // Verbatim the fail-closed message resolveBashSandbox hands the Bash tool,
  // so /sandbox explains enforce-on-remote exactly like the tool error does.
  const unavailableReason =
    mode === 'enforce' && !local
      ? `sandbox.mode is "enforce" but the execution environment is not local ` +
        `(kaos: "${kaos.name}"); bubblewrap sandboxing requires a local environment. ` +
        'Set sandbox.mode to "auto" or "off" to allow unsandboxed execution.'
      : undefined;

  return {
    mode,
    configured: sandboxConfig !== undefined,
    environment: kaos.name,
    local,
    workspaceCwd,
    network: sandboxConfig?.network ?? 'allow',
    escalation: sandboxConfig?.escalation ?? 'ask',
    configuredWritableRoots,
    configuredDenyRead,
    policy: inspection.policy,
    guard: {
      readOnlySubpaths: guardPlan.readOnlySubpaths,
      scrubPaths: guardPlan.scrubPaths,
    },
    backends: inspection.backends,
    plan: inspection.plan,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}
