/**
 * OS-level sandbox abstractions (F1).
 *
 * The sandbox is a pure argv transformation layered onto `Kaos` process
 * execution: a `SandboxBackend` wraps the original argv (e.g. by prefixing
 * `bwrap ... --`) so the spawned process runs inside a restricted filesystem
 * / network view. File operations (`readText`, `writeText`, ...) are not
 * affected — they execute inside the Node process, which an OS sandbox
 * cannot reach; those remain the permission layer's job.
 */

/** Network posture inside the sandbox. `'deny'` maps to bwrap `--unshare-net`. */
export type SandboxNetworkMode = 'allow' | 'deny';

/**
 * Sandbox posture from configuration (`[sandbox] mode`):
 *   - `'off'`     — never wrap; identical to the pre-sandbox behavior.
 *   - `'auto'`    — wrap when a backend is available; otherwise run
 *                   unsandboxed with a once-per-session warning.
 *   - `'enforce'` — fail closed: when no backend is available the Bash call
 *                   returns an error instead of running unsandboxed.
 */
export type SandboxMode = 'off' | 'auto' | 'enforce';

export interface SandboxPolicy {
  /** Writable roots (absolute paths, canonicalized when the plan is built). */
  readonly writableRoots: readonly string[];
  /** Subpaths under writable roots that are re-bound read-only (optional). */
  readonly readOnlySubpaths?: readonly string[];
  /** Paths masked unreadable (directories → tmpfs, files → /dev/null). */
  readonly denyReadPaths?: readonly string[];
  readonly network: SandboxNetworkMode;
}

export interface SandboxExecRequest {
  /** Original argv (e.g. `[shellPath, '-c', script]`). */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly policy: SandboxPolicy;
}

export type SandboxProbeResult =
  | { readonly available: true; readonly version?: string }
  | { readonly available: false; readonly reason: string };

export interface SandboxBackend {
  readonly name: string;
  /**
   * Probe real availability — must actually run a smoke sandbox, not just
   * check for the binary's existence (distros disable user namespaces via
   * sysctl/AppArmor while keeping the binary installed). Results are cached
   * by `SandboxManager`; backends need not cache themselves.
   */
  probe(): Promise<SandboxProbeResult>;
  /**
   * Pure argv transformation (codex `SandboxManager::transform` analogue).
   * Does not spawn anything; the filesystem is only touched for
   * canonicalization / existence filtering of mount targets.
   */
  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> };
}

/** Inputs from which `SandboxManager` derives a per-environment plan. */
export interface SandboxPlanInput {
  readonly mode: SandboxMode;
  readonly network: SandboxNetworkMode;
  /** Workspace root; always a writable root (together with `/tmp`). */
  readonly workspaceCwd: string;
  /** Extra writable roots from configuration. */
  readonly writableRoots?: readonly string[];
  /** Extra masked paths from configuration (merged over the default list). */
  readonly denyReadPaths?: readonly string[];
  /**
   * `Kaos.name` of the environment being wrapped. Sandboxing requires a
   * local execution environment; anything else resolves to `unsandboxed`.
   */
  readonly kaosName?: string;
}

export type SandboxPlan =
  | {
      readonly kind: 'sandboxed';
      readonly backend: SandboxBackend;
      readonly policy: SandboxPolicy;
    }
  | {
      readonly kind: 'unsandboxed';
      /** Human-readable explanation (surfaced via warning / error message). */
      readonly reason: string;
    };

/**
 * Serializable per-backend probe snapshot for status introspection
 * (`SandboxManager.inspect`). Unlike `SandboxProbeResult` it carries the
 * backend name, so a multi-backend report needs no side table.
 */
export interface SandboxBackendStatus {
  readonly name: string;
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

/**
 * Read-only snapshot of the manager's decision state for status reporting
 * (e.g. a `/sandbox` command). `policy` is the policy `resolvePlan` derives
 * for the same input — included even when `plan` is unsandboxed so a status
 * view can show the posture that takes effect once a backend works. The
 * plan carries the backend NAME rather than the `SandboxBackend` instance
 * so the whole snapshot crosses the RPC boundary.
 */
export interface SandboxInspection {
  readonly backends: readonly SandboxBackendStatus[];
  readonly policy: SandboxPolicy;
  readonly plan:
    | { readonly kind: 'sandboxed'; readonly backend: string }
    | { readonly kind: 'unsandboxed'; readonly reason: string };
}
