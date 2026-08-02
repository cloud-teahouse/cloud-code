/**
 * SandboxedKaos — a `Kaos` decorator that routes process execution through
 * an OS sandbox backend (bubblewrap on Linux).
 *
 * Only `exec` / `execWithEnv` / `ptyExec` are wrapped; file operations delegate
 * unchanged because they run inside the Node process where no OS sandbox
 * applies (the permission layer governs those). `withCwd` / `withEnv`
 * return new decorated instances, mirroring `LocalKaos`'s immutable
 * layering.
 *
 * The plan (sandboxed vs. unsandboxed) is resolved per exec through the
 * session-scoped `SandboxManager`, whose cached probe makes repeat
 * resolutions cheap. Resolving at exec time — rather than at decoration
 * time — keeps tool construction synchronous and lets `mode: 'enforce'`
 * fail closed at the exact call that would otherwise escape the sandbox.
 */

import type { Kaos } from '../kaos';
import type { KaosProcess } from '../process';
import type { KaosPtyProcess, PtyExecOptions } from '../pty';
import type { StatResult } from '../types';
import type { Environment } from '../environment';
import {
  bareGitRepoGuardPaths,
  planSandboxGuard,
  scrubReplacedGuardSymlinks,
  scrubSandboxGuardPaths,
  type SandboxGuardPlan,
} from './guard';
import type { SandboxManager } from './manager';
import type { SandboxPolicy, SandboxPlanInput } from './types';

/**
 * Session-static hardening for sandboxed runs (ported from Claude Code's
 * `sandbox-adapter.ts`; see `guard.ts` for the threat model):
 *
 *  - `scrubPaths` — control-plane locations under the writable workspace
 *    (skills dirs, `.cloud-code/`, project MCP configs) that a sandboxed
 *    command must never create: existing ones are re-bound read-only for
 *    the run, and anything planted at a missing one is deleted from the
 *    host once the process exits. The bare-repo files (`HEAD`/`objects`/
 *    `refs`/`hooks`/`config` at the exec cwd and the workspace root) are
 *    always guarded the same way and need no listing here.
 *  - `readOnlyPaths` — denyWrite equivalents whose creation is already
 *    impossible (read-only parent, e.g. the brand home) or whose
 *    mid-command creation by the host is legitimate: ro-bound when they
 *    exist, left alone when they do not.
 */
export interface SandboxGuardOptions {
  readonly scrubPaths?: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  /** Sink for scrub actions (e.g. the session logger); receives the removed paths. */
  readonly onScrub?: (removedPaths: readonly string[]) => void;
}

export class SandboxedKaos implements Kaos {
  /**
   * Shared across `withCwd`/`withEnv` derivations: callers keep the root
   * instance and query {@link wasSandboxed} on it while tools spawn through
   * a derived instance — a per-instance set would make every derived
   * process invisible to the root (the escalation-detection closure binds
   * the root instance).
   */
  private readonly sandboxedProcesses: WeakSet<KaosProcess>;

  constructor(
    private readonly inner: Kaos,
    private readonly manager: SandboxManager,
    private readonly planInput: Omit<SandboxPlanInput, 'kaosName'>,
    sandboxedProcesses?: WeakSet<KaosProcess>,
    private readonly guard?: SandboxGuardOptions,
  ) {
    this.sandboxedProcesses = sandboxedProcesses ?? new WeakSet<KaosProcess>();
    // Remote (SSH) environments wrap argv into a shell string with entirely
    // different semantics; sandboxing those is out of scope. Callers must
    // check `kaos.name === 'local'` before decorating — this assert turns a
    // wiring bug into an immediate failure instead of silent pass-through.
    if (inner.name !== 'local') {
      throw new Error(
        `SandboxedKaos only accepts a local Kaos (got "${inner.name}"); ` +
          'check kaos.name before decorating remote environments.',
      );
    }
  }

  get name(): string {
    return this.inner.name;
  }

  get osEnv(): Environment {
    return this.inner.osEnv;
  }

  /** Whether this exact process was spawned through the sandbox backend. */
  wasSandboxed(proc: KaosProcess): boolean {
    return this.sandboxedProcesses.has(proc);
  }

  withCwd(cwd: string): SandboxedKaos {
    return new SandboxedKaos(
      this.inner.withCwd(cwd),
      this.manager,
      this.planInput,
      this.sandboxedProcesses,
      this.guard,
    );
  }

  withEnv(env: Record<string, string>): SandboxedKaos {
    return new SandboxedKaos(
      this.inner.withEnv(env),
      this.manager,
      this.planInput,
      this.sandboxedProcesses,
      this.guard,
    );
  }

  async exec(...args: string[]): Promise<KaosProcess> {
    const plan = await this.resolvePlan();
    if (plan.kind === 'unsandboxed') {
      return this.runUnsandboxed(plan.reason, () => this.inner.exec(...args));
    }
    const guarded = this.applyGuard(plan.policy);
    const wrapped = plan.backend.buildCommand({
      argv: args,
      cwd: this.inner.getcwd(),
      env: {},
      policy: guarded.policy,
    });
    const proc = await this.inner.exec(...wrapped.argv);
    this.sandboxedProcesses.add(proc);
    this.scheduleGuardScrub(proc, guarded.guardPlan);
    return proc;
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const plan = await this.resolvePlan();
    if (plan.kind === 'unsandboxed') {
      return this.runUnsandboxed(plan.reason, () => this.inner.execWithEnv([...args], env));
    }
    const guarded = this.applyGuard(plan.policy);
    const wrapped = plan.backend.buildCommand({
      argv: args,
      cwd: this.inner.getcwd(),
      env: env ?? {},
      policy: guarded.policy,
    });
    // Forward the caller's env verbatim (NOT wrapped.env): `undefined` must
    // stay `undefined` so LocalKaos keeps its env-layer/inherit semantics
    // instead of spawning with an empty environment.
    const proc = await this.inner.execWithEnv(wrapped.argv, env);
    this.sandboxedProcesses.add(proc);
    this.scheduleGuardScrub(proc, guarded.guardPlan);
    return proc;
  }

  /**
   * PTY variant of `execWithEnv`: the argv passes through the same single
   * bwrap decoration point, then the wrapped argv goes to the inner kaos's
   * `ptyExec`. bwrap works under a PTY (`--new-session` was designed for
   * terminal scenarios); writableRoots / denyRead / `--unshare-net` semantics
   * carry over verbatim.
   */
  async ptyExec(
    args: string[],
    env?: Record<string, string>,
    opts?: PtyExecOptions,
  ): Promise<KaosPtyProcess> {
    const plan = await this.resolvePlan();
    if (plan.kind === 'unsandboxed') {
      return this.runUnsandboxed(plan.reason, () => this.inner.ptyExec([...args], env, opts));
    }
    const guarded = this.applyGuard(plan.policy);
    const wrapped = plan.backend.buildCommand({
      argv: args,
      cwd: this.inner.getcwd(),
      env: env ?? {},
      policy: guarded.policy,
    });
    // Same verbatim-env forwarding rule as execWithEnv above.
    const proc = await this.inner.ptyExec(wrapped.argv, env, opts);
    this.sandboxedProcesses.add(proc);
    this.scheduleGuardScrub(proc, guarded.guardPlan);
    return proc;
  }

  private resolvePlan() {
    return this.manager.resolvePlan({ ...this.planInput, kaosName: this.inner.name });
  }

  /**
   * Compute the per-exec guard plan against the CURRENT filesystem state and
   * fold it into the backend policy. Doing this at exec time — rather than
   * once at decoration time — keeps the ro-bind/scrub split accurate no
   * matter how the workspace changed since the last command (upstream
   * recomputes on settings refresh; per-exec is strictly tighter).
   */
  private applyGuard(base: SandboxPolicy): {
    readonly policy: SandboxPolicy;
    readonly guardPlan: SandboxGuardPlan;
  } {
    const guardPlan = planSandboxGuard({
      scrubCandidates: [
        ...bareGitRepoGuardPaths([this.inner.getcwd(), this.planInput.workspaceCwd]),
        ...(this.guard?.scrubPaths ?? []),
      ],
      readOnlyCandidates: this.guard?.readOnlyPaths ?? [],
    });
    if (guardPlan.readOnlySubpaths.length === 0) {
      return { policy: base, guardPlan };
    }
    return {
      policy: {
        ...base,
        readOnlySubpaths: [...(base.readOnlySubpaths ?? []), ...guardPlan.readOnlySubpaths],
      },
      guardPlan,
    };
  }

  /**
   * The `cleanupAfterCommand` analogue: once the process exits (exit or
   * spawn error — either way nothing it planted may survive), delete
   * whatever appeared at the scrub paths and whatever replaced a watched
   * symlink. Fire-and-forget by design; the scrub is host-side `rm -rf` on
   * paths that did not exist (or identities that did not match) when the
   * command started, so a failure to remove only restores the pre-guard
   * status quo.
   *
   * Bound (documented in guard.ts): the scrub is tied to the PROCESS
   * lifetime — a payload planted by a still-running long-lived background
   * task (or a persistent PTY session) sits exposed until the process ends.
   */
  private scheduleGuardScrub(proc: KaosProcess, guardPlan: SandboxGuardPlan): void {
    if (guardPlan.scrubPaths.length === 0 && guardPlan.symlinkWatches.length === 0) return;
    const scrub = (): void => {
      const removed = [
        ...scrubSandboxGuardPaths(guardPlan.scrubPaths),
        ...scrubReplacedGuardSymlinks(guardPlan.symlinkWatches),
      ];
      if (removed.length > 0) this.guard?.onScrub?.(removed);
    };
    void proc.wait().then(scrub, scrub);
  }

  private runUnsandboxed<T>(reason: string, run: () => Promise<T>): Promise<T> {
    if (this.planInput.mode === 'enforce') {
      throw new Error(
        `Refusing to run unsandboxed: ${reason}. ` +
          'Install bubblewrap or set sandbox.mode to "auto" / "off" to allow unsandboxed execution.',
      );
    }
    this.manager.warnOnce(
      'unsandboxed-fallback',
      `sandbox: running commands without OS sandbox — ${reason}.`,
    );
    return run();
  }

  // ── Everything below delegates unchanged ─────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return this.inner.pathClass();
  }

  normpath(path: string): string {
    return this.inner.normpath(path);
  }

  gethome(): string {
    return this.inner.gethome();
  }

  getcwd(): string {
    return this.inner.getcwd();
  }

  chdir(path: string): Promise<void> {
    return this.inner.chdir(path);
  }

  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    return this.inner.stat(path, options);
  }

  iterdir(path: string): AsyncGenerator<string> {
    return this.inner.iterdir(path);
  }

  glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    return this.inner.glob(path, pattern, options);
  }

  readBytes(path: string, n?: number): Promise<Buffer> {
    return this.inner.readBytes(path, n);
  }

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    return this.inner.readText(path, options);
  }

  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    return this.inner.readLines(path, options);
  }

  writeBytes(path: string, data: Buffer): Promise<number> {
    return this.inner.writeBytes(path, data);
  }

  writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    return this.inner.writeText(path, data, options);
  }

  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }
}
