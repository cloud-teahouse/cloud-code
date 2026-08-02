/**
 * SandboxManager — decides (mode × probe) whether a command runs sandboxed
 * and with what policy. Analogous to codex `sandboxing/src/manager.rs`'s
 * `select_initial` + `should_sandbox`, plus the denial heuristic entry point.
 *
 * One manager per session (owned by the agent): it caches backend probes so
 * the smoke sandbox runs once, and it owns the once-per-session
 * unsandboxed-warning keys.
 */

import { homedir } from 'node:os';

import { isLikelySandboxDenied, type SandboxDenialOutput } from './denial';
import { BubblewrapBackend } from './bubblewrap';
import type {
  SandboxBackend,
  SandboxBackendStatus,
  SandboxInspection,
  SandboxPlan,
  SandboxPlanInput,
  SandboxPolicy,
  SandboxProbeResult,
} from './types';

/**
 * Default deny-read list: home is otherwise readable under the baseline
 * `--ro-bind / /` policy (toolchains legitimately read tool config there),
 * so credential protection comes from this mask list. `~` expands against
 * the current user's home. Callers (agent-core) append their own
 * credential-bearing directories on top.
 */
export const DEFAULT_DENY_READ_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gcloud',
];

export interface SandboxManagerOptions {
  /** Backends probed in order; the first available one wins. */
  readonly backends?: readonly SandboxBackend[];
  /** Sink for once-per-session warnings (e.g. the session logger). */
  readonly onWarning?: ((message: string) => void) | undefined;
}

export class SandboxManager {
  private readonly backends: readonly SandboxBackend[];
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly probeCache = new Map<string, Promise<SandboxProbeResult>>();
  private readonly warnedKeys = new Set<string>();

  constructor(options: SandboxManagerOptions = {}) {
    this.backends = options.backends ?? [new BubblewrapBackend()];
    this.onWarning = options.onWarning;
  }

  /**
   * Resolve the execution plan for one environment. Async because probing
   * spawns real processes; the probe itself is cached, so repeat calls are
   * cheap. `mode: 'enforce'` does not change the plan — it only changes how
   * the caller treats an `unsandboxed` plan (fail closed vs. warn and run).
   */
  async resolvePlan(input: SandboxPlanInput): Promise<SandboxPlan> {
    if (input.mode === 'off') {
      return { kind: 'unsandboxed', reason: 'sandbox mode is off' };
    }
    if (input.kaosName !== undefined && input.kaosName !== 'local') {
      return {
        kind: 'unsandboxed',
        reason: `OS sandboxing requires a local execution environment (kaos: "${input.kaosName}")`,
      };
    }

    const reasons: string[] = [];
    for (const backend of this.backends) {
      const probe = await this.probe(backend);
      if (probe.available) {
        return { kind: 'sandboxed', backend, policy: this.buildPolicy(input) };
      }
      reasons.push(`${backend.name}: ${probe.reason}`);
    }
    return {
      kind: 'unsandboxed',
      reason: `no sandbox backend available (${reasons.join('; ')})`,
    };
  }

  /**
   * Introspection for status reporting (e.g. a `/sandbox` command): probes
   * every backend through the shared cache — even when `mode` is `'off'` or
   * the environment is non-local, which `resolvePlan` would short-circuit —
   * and returns the plan alongside the policy that applies (or would apply
   * once a backend works). Read-only: nothing runs beyond the same smoke
   * probe `resolvePlan` performs.
   */
  async inspect(input: SandboxPlanInput): Promise<SandboxInspection> {
    const backends: SandboxBackendStatus[] = [];
    for (const backend of this.backends) {
      const probe = await this.probe(backend);
      backends.push(
        probe.available
          ? {
              name: backend.name,
              available: true,
              ...(probe.version !== undefined ? { version: probe.version } : {}),
            }
          : { name: backend.name, available: false, reason: probe.reason },
      );
    }
    const plan = await this.resolvePlan(input);
    return {
      backends,
      policy: this.buildPolicy(input),
      plan:
        plan.kind === 'sandboxed' ? { kind: 'sandboxed', backend: plan.backend.name } : plan,
    };
  }

  /** Emit `message` through the warning sink once per session per `key`. */
  warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.onWarning?.(message);
  }

  /** See `denial.ts`; callers must gate on the run actually being sandboxed. */
  isLikelySandboxDenied(output: SandboxDenialOutput): boolean {
    return isLikelySandboxDenied(output);
  }

  private probe(backend: SandboxBackend): Promise<SandboxProbeResult> {
    let cached = this.probeCache.get(backend.name);
    if (cached === undefined) {
      cached = backend.probe().catch((error: unknown): SandboxProbeResult => {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      });
      this.probeCache.set(backend.name, cached);
    }
    return cached;
  }

  private buildPolicy(input: SandboxPlanInput): SandboxPolicy {
    const denyReadPaths = [
      ...DEFAULT_DENY_READ_PATHS.map(expandHome),
      ...(input.denyReadPaths ?? []).map(expandHome),
    ];
    return {
      // Canonicalization and existence filtering happen in the backend's
      // buildCommand; `/tmp` and the workspace are always writable.
      writableRoots: [input.workspaceCwd, '/tmp', ...(input.writableRoots ?? []).map(expandHome)],
      denyReadPaths,
      network: input.network,
    };
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return homedir() + path.slice(1);
  return path;
}
