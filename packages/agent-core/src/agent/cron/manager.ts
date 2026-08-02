/**
 * CronManager — Agent-facing facade for the cron scheduler.
 *
 * This layer sits between the raw `CronScheduler` (which knows nothing
 * about agents) and the rest of the agent runtime (Agent / turn /
 * tool surface). Its job is small but important:
 *
 *   - own the `SessionCronStore` for this session;
 *   - hand `() => store.list()` to the scheduler so add / delete are
 *     picked up automatically every tick;
 *   - gate fires on `agent.turn.hasActiveTurn` rather than maintaining a
 *     duplicate idle flag — the turn machinery already knows;
 *   - translate a fired `CronTask` into a `steer(...)` call carrying a
 *     `CronJobOrigin`;
 *   - mirror every store mutation to `<sessionDir>/cron/<id>.json`
 *     (via {@link addTask} / {@link removeTasks}) so that `cloud-code resume`
 *     can call {@link loadFromDisk} to rehydrate previously-scheduled
 *     tasks. When no `sessionDir` is supplied (subagents, tests,
 *     ephemeral sessions) the manager stays purely in-memory.
 *   - manage PROJECT-DURABLE tasks (`durable: true`): these live in
 *     `<projectDir>/.cloud-code/scheduled_tasks.json` instead of the
 *     session store, so any session in the same project — including a
 *     brand-new one — reloads them on startup. A cross-session lock
 *     (`lock.ts`, PID-liveness with stale recovery) elects a single
 *     owner session; only the owner adopts project tasks into the
 *     firing store. Missed fire times that passed while no session was
 *     running collapse into ONE coalesced delivery on the next startup
 *     through the scheduler's normal `coalescedCount` semantics — the
 *     same contract the resume path already honours. The project layer
 *     only engages for local workspaces (kaos `local`): the lock's PID
 *     liveness is a same-machine concept.
 *   - provide a `handleMissed(...)` entry point that future boot-time
 *     missed-task notification will call. Today the scheduler's
 *     `coalescedCount` semantics handle missed fires inline, so this
 *     entry point is not wired by the framework — it stays exposed so
 *     adding a banner later does not require API churn here.
 *
 * The manager does NOT read `Date.now()` directly anywhere; every
 * wall-clock read goes through `this.clocks.wallNow()`. The
 * `no-date-now.test.ts` guard does not list this file (it covers the
 * scheduler / jitter layer), but the same discipline is intentional so
 * bench / test clock injection holds end-to-end.
 *
 * Note on `recurring` semantics: the canonical task representation uses
 * `recurring: boolean | undefined` where `undefined` means recurring
 * (cron tasks default to repeating). One-shot is the explicit
 * `recurring === false` opt-out. Every check in this file uses
 * `task.recurring !== false` to keep that default behaviour even when
 * the field is omitted by the caller.
 */
import type { ContentPart } from '@cloud-code/kosong';

import type { Agent } from '../index';
import type { CronJobOrigin, CronMissedOrigin } from '../context/types';
import {
  resolveClockSources,
  SYSTEM_CLOCKS,
  type ClockSources,
} from '../../tools/cron/clock';
import { renderCronFireXml } from '../../tools/cron/cron-fire-xml';
import {
  tryAcquireProjectCronLock,
  releaseProjectCronLock,
} from '../../tools/cron/lock';
import { createCronPersistStore } from '../../tools/cron/persist';
import {
  createProjectCronStore,
  projectCronFilePath,
  type ProjectCronStore,
} from '../../tools/cron/project-store';
import {
  generateCronTaskId,
  SessionCronStore,
} from '../../tools/cron/session-store';
import {
  createCronScheduler,
  type CronScheduler,
} from '../../tools/cron/scheduler';
import type { CronTask } from '../../tools/cron/types';
import type { PerIdJsonStore } from '../../utils/per-id-json-store';

import type { SessionCronTaskInit } from '../../tools/cron/session-store';

/**
 * Threshold past which a recurring task is flagged `stale: true` on its
 * fire `origin`. One-shot tasks never carry the stale flag — they are
 * one-time, "we always fire at most once" by construction. Disabled by
 * `KIMI_CRON_NO_STALE=1` (bench / acceptance tests).
 *
 * Seven days mirrors the wall-clock "this got forgotten about" window
 * we want the LLM to notice; the figure also matches the auto-expire
 * cadence documented in the user-facing schedule story.
 */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often the project-schedule probe runs: a non-owner session retries
 * the cross-session lock at this cadence (taking over when the owner
 * died), and the owner re-reads the tasks file when its mtime changed
 * (picking up tasks another session created). Five seconds mirrors the
 * takeover cadence of Claude Code's cronTasksLock and keeps a freshly
 * written task at most one probe away from the owner's scheduler.
 */
const DEFAULT_PROJECT_PROBE_MS = 5_000;

/**
 * Point-in-time view of a scheduled cron task, exposed over RPC so host
 * applications (e.g. the `cloud-code -p` flow deciding whether pending work
 * remains before exit) can enumerate scheduled tasks without going
 * through the model-facing CronList tool.
 */
export interface CronTaskSnapshot {
  readonly id: string;
  readonly cron: string;
  readonly recurring: boolean;
  /**
   * Scope marker: `true` for project-durable tasks (shared via
   * `.cloud-code/scheduled_tasks.json`), `false` for session-scoped ones.
   */
  readonly durable: boolean;
  readonly createdAt: number;
  readonly lastFiredAt: number | undefined;
  /** Post-jitter next fire (epoch ms), or null when no future fire exists. */
  readonly nextFireAt: number | null;
}

export interface CronManagerOptions {
  /**
   * Override for tests / bench. Defaults to
   * `resolveClockSources(process.env.KIMI_CRON_CLOCK)` so production
   * picks up `KIMI_CRON_CLOCK=file:...` automatically.
   * When unset, falls through to {@link SYSTEM_CLOCKS}.
   */
  readonly clocks?: ClockSources;

  /**
   * Override scheduler poll interval. Defaults handled by the scheduler
   * (1000ms unless `KIMI_CRON_MANUAL_TICK=1`, which forces `null` here
   * so the auto-tick `setInterval` is never installed). `null` or `0`
   * means "no automatic timer — caller drives `tick()` manually".
   */
  readonly pollIntervalMs?: number | null;

  /**
   * Project directory for durable cron tasks. Defaults to
   * `agent.config.cwd` when the agent's kaos is local; `undefined`
   * (non-local kaos, ephemeral stubs) disables the project layer
   * entirely — `durable: true` requests then fall back to
   * session-scoped with a warning.
   */
  readonly projectDir?: string;

  /**
   * Lock identity for the project-schedule lock. Defaults to the
   * agent's homedir (unique per session) or a random id for ephemeral
   * agents. Tests inject explicit identities to simulate two sessions.
   */
  readonly projectLockIdentity?: string;

  /**
   * Override for the project-schedule probe interval. Defaults to
   * {@link DEFAULT_PROJECT_PROBE_MS}; `KIMI_CRON_MANUAL_TICK=1` forces
   * `null` (no automatic probe) so benches stay deterministic — drive
   * {@link CronManager.probeProjectSchedule} manually instead.
   */
  readonly projectProbeMs?: number | null;
}

export class CronManager {
  /** In-memory task store. Empty at construction; populated by
   * {@link addTask} (and {@link loadFromDisk} on resume). */
  readonly store: SessionCronStore;

  /**
   * Clock source used for the stale judgment. Also passed to the
   * scheduler so the entire stack shares one notion of "now".
   */
  readonly clocks: ClockSources;

  private readonly scheduler: CronScheduler;
  private readonly agent: Agent;
  /**
   * Tracks whether `start()` has been called without a matching `stop()`.
   * Used to keep `start()` / `stop()` idempotent and to gate SIGUSR1
   * binding so we don't accumulate handlers across repeated start()
   * calls.
   */
  private started = false;
  /**
   * Reference to the bound SIGUSR1 listener while the manager is
   * running. Held so `stop()` can call `process.off('SIGUSR1', handler)`
   * with the same function reference and not leak handlers across vitest
   * files. `null` whenever the manager is not started, or when running
   * on a platform that does not support SIGUSR1 (Windows).
   */
  private sigusr1Handler: NodeJS.SignalsListener | null = null;

  /**
   * File-backed mirror of {@link store}. `undefined` when no
   * `sessionDir` was supplied — the manager then behaves as pure
   * in-memory, matching pre-persistence semantics. When defined,
   * `addTask` / `removeTasks` schedule fire-and-forget writes so a
   * later `cloud-code resume` can reload via {@link loadFromDisk}.
   */
  private readonly persistStore: PerIdJsonStore<CronTask> | undefined;

  /**
   * Per-id serializer for persistence writes. Prevents a fast
   * `add` → `remove` sequence on the same id from racing each other on
   * the rename — the rm must observe the prior write's renamed file.
   * Empty between bursts; entries are deleted once their tail promise
   * settles so the map cannot grow unboundedly with churn.
   */
  private readonly persistQueues: Map<string, Promise<void>> = new Map();

  // ── Project-durable schedule ───────────────────────────────────────
  /**
   * Whole-file store for `<projectDir>/.cloud-code/scheduled_tasks.json`.
   * `undefined` when the project layer is disabled (non-local kaos,
   * ephemeral agent without a cwd).
   */
  private readonly projectStore: ProjectCronStore | undefined;
  /** Identity written into the cross-session lock file. */
  private readonly projectIdentity: string;
  /** Probe interval for lock takeover / file-change reload. */
  private readonly projectProbeMs: number | null;
  /** True while this session holds the project schedule lock. */
  private projectLockOwned = false;
  /** Timer driving {@link probeProjectSchedule}; null when disarmed. */
  private projectProbeTimer: ReturnType<typeof setInterval> | null = null;
  /** Last observed mtime of the tasks file (owner-side change detection). */
  private projectFileMtimeMs: number | null = null;
  /**
   * Serializes every project-file job (claim → write → adopt, delete,
   * cursor stamps, probe reloads) so a reload always observes this
   * session's own earlier writes. Mirrors {@link persistQueues}' role
   * for the session store, but the whole file shares one chain.
   */
  private projectChain: Promise<unknown> = Promise.resolve();
  /**
   * Settles when the constructor's initial project-schedule scan (read
   * file, claim lock if tasks exist, adopt) has finished. Tests await
   * this before ticking; production treats it as fire-and-forget.
   */
  readonly projectReady: Promise<void>;

  constructor(agent: Agent, opts: CronManagerOptions = {}) {
    this.agent = agent;
    this.store = new SessionCronStore();
    this.clocks =
      opts.clocks ??
      resolveClockSources(process.env['KIMI_CRON_CLOCK']) ??
      SYSTEM_CLOCKS;
    this.persistStore =
      agent.homedir === undefined
        ? undefined
        : createCronPersistStore(agent.homedir);

    // Project-durable layer. Only engages for local workspaces: the
    // cross-session lock's PID liveness is a same-machine concept, so
    // SSH-remote cwds keep cron strictly session-scoped.
    const projectDir =
      opts.projectDir ??
      (agent.kaos?.name === 'local' ? agent.config?.cwd : undefined);
    this.projectStore =
      projectDir === undefined ? undefined : createProjectCronStore(projectDir);
    this.projectIdentity =
      opts.projectLockIdentity ??
      agent.homedir ??
      `ephemeral-${Math.random().toString(16).slice(2, 10)}`;
    this.projectProbeMs =
      process.env['KIMI_CRON_MANUAL_TICK'] === '1'
        ? null
        : opts.projectProbeMs === undefined
          ? DEFAULT_PROJECT_PROBE_MS
          : opts.projectProbeMs;

    this.scheduler = createCronScheduler({
      clocks: this.clocks,
      source: () => this.store.list(),
      isIdle: () => !agent.turn.hasActiveTurn,
      isKilled: () => process.env['KIMI_DISABLE_CRON'] === '1',
      onFire: (task, ctx) => {
        this.handleFire(task, ctx);
      },
      removeOneShot: (id) => {
        this.removeTasks([id]);
      },
      onAdvanceCursor: (id, lastFiredAt) => {
        this.advanceCursor(id, lastFiredAt);
      },
      // `KIMI_CRON_MANUAL_TICK=1` forces the scheduler into
      // manual-drive mode (no setInterval), so bench / time-injected
      // tests can step time forward and call `tick()` explicitly without
      // racing a 1-second auto-tick. Explicit caller overrides
      // (`opts.pollIntervalMs`) lose to the env so a bench can flip the
      // switch from the outside without rebuilding the manager wiring.
      pollIntervalMs:
        process.env['KIMI_CRON_MANUAL_TICK'] === '1'
          ? null
          : opts.pollIntervalMs,
    });

    // Initial project-schedule scan: read the tasks file (no lock) and,
    // when it holds tasks, try to claim ownership and adopt them.
    // Fire-and-forget like the session persist path — failures are
    // logged, never thrown into the constructor. Tests await
    // `projectReady` before driving ticks.
    this.projectReady = this.projectEnqueueAwait(() =>
      this.initProjectSchedule(),
    ).catch((error: unknown) => {
      this.agent.log?.warn?.('cron project init failed', error);
    });

    this.start();
  }

  /**
   * Add a fresh task to the in-memory store and, when persistence is
   * attached, mirror the new record to `<sessionDir>/cron/<id>.json`.
   *
   * The store call is synchronous (CronCreate needs the id for its
   * response); the on-disk write is fire-and-forget so a slow disk
   * never blocks the tool's reply. Per-id queueing serializes
   * concurrent writes on the same id (e.g. add → stale auto-expire) so
   * the rm cannot race the rename.
   *
   * Persistence failures are logged via `agent.log.warn` and swallowed
   * — a flaky disk drops cross-resume durability but must not crash
   * the agent loop.
   *
   * Tasks whose `init.durable === true` are PROJECT-durable: they skip
   * the session mirror and go to `.cloud-code/scheduled_tasks.json`
   * instead (see {@link addProjectTask} for the ownership rules). When
   * the project layer is disabled, a durable request degrades to
   * session-scoped with a warning rather than an error.
   */
  addTask(init: SessionCronTaskInit): CronTask {
    if (init.durable === true && this.projectStore !== undefined) {
      return this.addProjectTask(init);
    }
    if (init.durable === true && this.projectStore === undefined) {
      this.agent.log?.warn?.(
        'cron: durable task requested but project cron is unavailable (non-local workspace); falling back to session scope',
      );
    }
    const task = this.store.add(init, this.clocks.wallNow());
    this.persistEnqueue(task.id, () =>
      this.persistStore!.write(task.id, task),
    );
    return task;
  }

  /**
   * Durable add path. Two cases:
   *
   *   - This session OWNS the project schedule: adopt into the firing
   *     store immediately (the scheduler picks it up next tick) and
   *     mirror the record to the project file.
   *   - This session does NOT own it (another live session holds the
   *     lock, or ownership hasn't been attempted yet): mint the record
   *     WITHOUT adopting it. Adopting here would fire the task in a
   *     non-owner session while the owner also fires it — the double-fire
   *     the lock exists to prevent. The queued job claims the lock if
   *     possible; on success the record is adopted, otherwise it lives
   *     only in the file until this session takes ownership (probe) or
   *     restarts (startup scan).
   */
  private addProjectTask(init: SessionCronTaskInit): CronTask {
    if (this.projectLockOwned) {
      const task = this.store.add(
        { ...init, durable: true },
        this.clocks.wallNow(),
      );
      this.projectEnqueue(async () => {
        await this.projectStore!.add(task);
        this.projectFileMtimeMs = await this.projectStore!.statMtimeMs();
      });
      return task;
    }

    const task: CronTask = {
      ...init,
      id: generateCronTaskId((id) => this.store.get(id) !== undefined),
      createdAt: this.clocks.wallNow(),
      durable: true,
    };
    this.projectEnqueue(async () => {
      await this.claimAndLoadProjectSchedule();
      await this.projectStore!.add(task);
      if (this.projectLockOwned) {
        this.projectFileMtimeMs = await this.projectStore!.statMtimeMs();
        this.store.adopt(task);
      }
    });
    return task;
  }

  /**
   * Remove a batch of tasks from the in-memory store and mirror each
   * deletion to disk (when persistence is attached). Returns the
   * subset of ids that were actually present, matching
   * `SessionCronStore.remove`'s contract — callers (CronDelete /
   * scheduler one-shot cleanup / stale auto-expire) read this to
   * report whether anything was actually removed.
   *
   * Persistence failures are logged and swallowed; cross-resume the
   * worst case is a ghost entry that gets dropped on the next
   * `list()` shape-guard pass.
   */
  removeTasks(ids: readonly string[]): readonly string[] {
    // Snapshot durability BEFORE removal — the routing decision needs
    // the record, not just the id.
    const durableIds = new Set(
      ids.filter((id) => this.store.get(id)?.durable === true),
    );
    const removed = this.store.remove(ids);
    for (const id of removed) {
      if (durableIds.has(id)) {
        this.projectEnqueue(async () => {
          await this.projectStore!.remove([id]);
          this.projectFileMtimeMs = await this.projectStore!.statMtimeMs();
        });
      } else {
        this.persistEnqueue(id, () => this.persistStore!.remove(id));
      }
    }
    return removed;
  }

  /**
   * Delete project-file tasks by id, regardless of whether they are in
   * this session's in-memory store. This is the CronDelete fallback for
   * sessions that don't own the project schedule: they never adopted
   * the file's tasks, so a plain {@link removeTasks} would miss. Also
   * drops any matching in-memory records (an owner session sweeping its
   * own task lands here when the record already left the store).
   *
   * Returns the ids that were actually present in the file — CronDelete
   * reports "not found" when both this and the in-memory sweep miss.
   */
  async removeProjectTasks(ids: readonly string[]): Promise<readonly string[]> {
    if (this.projectStore === undefined || ids.length === 0) return [];
    try {
      return await this.projectEnqueueAwait(async () => {
        const removed = await this.projectStore!.remove(ids);
        if (removed.length > 0) {
          this.projectFileMtimeMs = await this.projectStore!.statMtimeMs();
          this.store.remove(removed);
        }
        return removed;
      });
    } catch (error) {
      this.agent.log?.warn?.('cron project delete failed', error);
      return [];
    }
  }

  /**
   * Persist the scheduler's `lastFiredAt` cursor for a recurring task
   * so a `cloud-code resume` does not coalesce-replay an already-delivered
   * fire. Called by the scheduler's `onAdvanceCursor` callback after a
   * successful recurring fire.
   *
   * No-op when the task has already been removed between fire and
   * callback (concurrent CronDelete is the canonical case). When
   * persistence is detached (subagent / ephemeral session) we still
   * update the in-memory record — same-session stale checks read off
   * the in-memory store. The on-disk write is fire-and-forget via
   * `persistEnqueue`; a flaky disk drops cross-resume durability but
   * never blocks the scheduler.
   */
  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.store.markFired(id, lastFiredAt);
    if (updated === undefined) return;
    if (updated.durable === true) {
      this.projectEnqueue(async () => {
        await this.projectStore!.markFired(id, lastFiredAt);
        this.projectFileMtimeMs = await this.projectStore!.statMtimeMs();
      });
      return;
    }
    if (this.persistStore === undefined) return;
    this.persistEnqueue(id, () => this.persistStore!.write(id, updated));
  }

  /**
   * Rehydrate the in-memory store from `<sessionDir>/cron/` after
   * `cloud-code resume`. No-op when persistence is not attached. Idempotent:
   * clears the in-memory map and re-inserts every record on disk.
   *
   * Tasks are inserted via {@link SessionCronStore.adopt} so the
   * original `id` and `createdAt` survive — `createdAt` is the
   * scheduler's recurring baseline and the 7-day stale judgment's
   * input, so a regenerated value would corrupt both.
   */
  async loadFromDisk(): Promise<void> {
    if (this.persistStore === undefined) return;
    const tasks = await this.persistStore.list();
    // Clear SESSION-scoped tasks only. Project-durable records are
    // owned by the project file (startup scan / probe), not the session
    // mirror — clearing them here would race the constructor's
    // fire-and-forget `initProjectSchedule`.
    const sessionIds = this.store
      .list()
      .filter((t) => t.durable !== true)
      .map((t) => t.id);
    this.store.remove(sessionIds);
    for (const task of tasks) {
      this.store.adopt(task);
    }
  }

  /**
   * Serialize per-id persistence writes. Concurrent mutations on the
   * same id (uncommon but reachable via `add` immediately followed by
   * stale auto-expire) would otherwise race on the rename — atomicWrite
   * is per-call atomic, not per-id ordered. Each id's chain is dropped
   * from the map once it settles so the map size tracks live in-flight
   * writes, not lifetime churn.
   */
  private persistEnqueue(id: string, work: () => Promise<void>): void {
    if (this.persistStore === undefined) return;
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
      .catch((error: unknown) => {
        this.agent.log?.warn?.('cron persist failed', error);
      })
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
  }

  /**
   * Wait for every pending persistence write / remove scheduled via
   * {@link addTask} / {@link removeTasks} to settle. Called from
   * {@link stop} for graceful session shutdown and exposed publicly so
   * tests can synchronise on disk-visible state without polling.
   *
   * Errors are already swallowed by `persistEnqueue`, so this never
   * rejects.
   */
  async flushPersist(): Promise<void> {
    // Snapshot the chain promises rather than the map itself — the
    // `.finally` cleanup deletes entries while we await, and a live
    // map iteration would observe the deletions and miss tails.
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.allSettled(inFlight);
    await this.projectChain.catch(() => {});
  }

  // ── Project-durable schedule ───────────────────────────────────────

  /** Whether project-durable cron is available in this session. */
  get projectCronAvailable(): boolean {
    return this.projectStore !== undefined;
  }

  /** Whether this session currently owns the project schedule. */
  get ownsProjectSchedule(): boolean {
    return this.projectLockOwned;
  }

  /** Absolute path of the project tasks file, or undefined when disabled. */
  get projectCronTasksPath(): string | undefined {
    return this.projectStore === undefined
      ? undefined
      : projectCronFilePath(this.projectStore.projectDir);
  }

  /**
   * Raw project-file task list for the CronList merge. Returns durable-
   * flagged tasks straight from disk so a non-owner session can still
   * SHOW the project schedule even though it never fires it. Empty when
   * the project layer is disabled; read failures surface as `[]` (a
   * listing must not fail because the file is mid-rename elsewhere).
   */
  async listProjectFileTasks(): Promise<readonly CronTask[]> {
    if (this.projectStore === undefined) return [];
    try {
      const tasks = await this.projectEnqueueAwait(() =>
        this.projectStore!.list(),
      );
      return tasks.map((t) => ({ ...t, durable: true as const }));
    } catch {
      return [];
    }
  }

  /**
   * Constructor-time project scan. Reads the tasks file WITHOUT the
   * lock first: an empty or missing file means this session stays
   * fully passive (no lock file, no probe timer) until someone creates
   * a durable task. A non-empty file triggers a claim attempt — owning
   * sessions adopt + fire, non-owners arm the takeover probe.
   */
  private async initProjectSchedule(): Promise<void> {
    if (this.projectStore === undefined) return;
    if (process.env['KIMI_DISABLE_CRON'] === '1') return;
    const tasks = await this.projectStore.list();
    if (tasks.length === 0) return;
    await this.claimAndLoadProjectSchedule();
  }

  /**
   * Try to claim the project schedule and, on success, adopt every file
   * task into the firing store. On failure (another live session owns
   * it) just arm the probe — the next successful probe retries this.
   *
   * Must only be called from within a {@link projectChain} job; it is
   * the shared tail of the constructor scan, durable adds, and the
   * probe's takeover path.
   */
  private async claimAndLoadProjectSchedule(): Promise<void> {
    if (this.projectStore === undefined) return;
    const acquired = await tryAcquireProjectCronLock(
      this.projectStore.projectDir,
      this.projectIdentity,
      this.clocks.wallNow(),
    );
    if (!acquired) {
      this.armProjectProbe();
      return;
    }
    this.projectLockOwned = true;
    const tasks = await this.projectStore.list();
    this.projectFileMtimeMs = await this.projectStore.statMtimeMs();
    this.adoptProjectTasks(tasks);
    this.armProjectProbe();
  }

  /**
   * File-authoritative merge of project tasks into the firing store.
   * File tasks are adopted with `durable: true` re-attached (the flag is
   * stripped on disk); in-memory durable tasks missing from the file
   * are dropped (another session deleted them). Session-scoped tasks
   * are untouched. The scheduler's per-task cursors survive adoption,
   * so an unchanged task's fire schedule is not disturbed by a reload.
   */
  private adoptProjectTasks(tasks: readonly CronTask[]): void {
    const fileIds = new Set(tasks.map((t) => t.id));
    const vanished = this.store
      .list()
      .filter((t) => t.durable === true && !fileIds.has(t.id))
      .map((t) => t.id);
    if (vanished.length > 0) {
      this.store.remove(vanished);
    }
    for (const task of tasks) {
      this.store.adopt({ ...task, durable: true });
    }
  }

  /**
   * One probe cycle, serialized onto {@link projectChain}. Non-owners
   * retry the lock (takeover after owner death → adopt → the scheduler's
   * normal coalesced delivery compensates everything missed while no
   * session was running). The owner reloads the file when its mtime
   * moved, picking up tasks other sessions created or deleted.
   *
   * Public so tests with `projectProbeMs: null` can drive it manually.
   */
  probeProjectSchedule(): Promise<void> {
    return this.projectEnqueueAwait(async () => {
      if (this.projectStore === undefined) return;
      if (!this.projectLockOwned) {
        await this.claimAndLoadProjectSchedule();
        return;
      }
      const mtime = await this.projectStore.statMtimeMs();
      if (mtime === null) {
        // File vanished externally (e.g. deleted by hand) — the project
        // schedule is empty now.
        this.projectFileMtimeMs = null;
        this.adoptProjectTasks([]);
        return;
      }
      if (mtime !== this.projectFileMtimeMs) {
        const tasks = await this.projectStore.list();
        this.projectFileMtimeMs = mtime;
        this.adoptProjectTasks(tasks);
      }
    });
  }

  /** Arm the periodic probe. Idempotent; no-op when probes are disabled. */
  private armProjectProbe(): void {
    if (this.projectProbeTimer !== null) return;
    const interval = this.projectProbeMs;
    if (interval === null || interval === 0) return;
    const handle = setInterval(() => {
      void this.probeProjectSchedule().catch((error: unknown) => {
        this.agent.log?.warn?.('cron project probe failed', error);
      });
    }, interval);
    // Don't keep the event loop alive on the probe alone — matches the
    // scheduler's unref'd auto-tick.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    this.projectProbeTimer = handle;
  }

  /**
   * Fire-and-forget project job: chained onto {@link projectChain},
   * errors logged and swallowed (same discipline as
   * {@link persistEnqueue} — a flaky disk must never crash the agent
   * loop or surface as an unhandled rejection).
   */
  private projectEnqueue(work: () => Promise<void>): void {
    const next = this.projectChain
      .catch(() => {})
      .then(work)
      .catch((error: unknown) => {
        this.agent.log?.warn?.('cron project persist failed', error);
      });
    this.projectChain = next;
  }

  /**
   * Awaitable project job: same chain, but the returned promise carries
   * the job's result (and rejection) to the caller. Used by the
   * constructor scan, CronDelete's project sweep, CronList's merge, and
   * manual probe drives.
   */
  private projectEnqueueAwait<T>(work: () => Promise<T>): Promise<T> {
    const next = this.projectChain.then(work, work);
    this.projectChain = next.catch(() => {});
    return next;
  }


  /**
   * Begin the scheduler's auto-tick loop and bind the SIGUSR1 manual-tick
   * hook. Idempotent: a second call is a no-op so the boot
   * sequence and tests can opt into "ensure started" without bookkeeping.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.start();
    this.bindSigusr1();
  }

  /**
   * Stop the scheduler, drain pending persistence writes, clear
   * in-flight bookkeeping, and unbind the SIGUSR1 handler. Idempotent
   * and signal-handler-safe — multiple vitest files exercising the
   * manager must not leave a SIGUSR1 listener dangling on the shared
   * process.
   *
   * Draining persistence on shutdown matters for production: a session
   * `close()` immediately after a CronCreate would otherwise tear the
   * process down before the JSON file lands on disk, and the task
   * would be missing from the resume's `loadFromDisk()`.
   */
  async stop(): Promise<void> {
    this.unbindSigusr1();
    if (this.projectProbeTimer !== null) {
      clearInterval(this.projectProbeTimer);
      this.projectProbeTimer = null;
    }
    // Release the project lock AFTER any queued project writes (so a
    // pending add lands before another session takes over), but only
    // when we actually own it — releasing someone else's lock would
    // open a double-fire window.
    if (this.projectLockOwned && this.projectStore !== undefined) {
      const store = this.projectStore;
      const identity = this.projectIdentity;
      this.projectEnqueueAwait(() =>
        releaseProjectCronLock(store.projectDir, identity),
      ).catch(() => {});
      this.projectLockOwned = false;
    }
    await this.scheduler.stop();
    await this.flushPersist();
    this.started = false;
  }

  /** Drive one scheduler tick synchronously. Used by tests and the SIGUSR1 manual-tick hook. */
  tick(): void {
    this.scheduler.tick();
  }

  /**
   * Earliest theoretical (post-jitter) next-fire across all tasks, or
   * null if there are no tasks / none have a future fire. Used by the
   * `/cron` slash command and external monitoring.
   */
  getNextFireTime(): number | null {
    return this.scheduler.getNextFireTime();
  }

  /**
   * Per-task post-jitter next-fire. Forwards to the scheduler so
   * CronList renders the same instant the scheduler will fire — even
   * when an already-past ideal still has a pending jittered delivery
   * in the current period.
   */
  getNextFireForTask(taskId: string): number | null {
    return this.scheduler.getNextFireForTask(taskId);
  }

  /**
   * Enumerate every scheduled task with its post-jitter next fire time.
   * Unlike the CronList tool (which renders for the model), this returns
   * structured data for host applications polling for pending work.
   */
  listTaskSnapshots(): readonly CronTaskSnapshot[] {
    return this.store.list().map((task) => ({
      id: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      durable: task.durable === true,
      createdAt: task.createdAt,
      lastFiredAt: task.lastFiredAt,
      nextFireAt: this.scheduler.getNextFireForTask(task.id),
    }));
  }

  /**
   * Stale judgment.
   *
   *   - `KIMI_CRON_NO_STALE=1` short-circuits to false (bench).
   *   - One-shot tasks (`recurring === false`) are never stale — they
   *     fire at most once by construction; flagging them stale would be
   *     a noisy false positive on every backlog wakeup.
   *   - Otherwise: `wallNow() - createdAt >= 7 days`.
   *
   * `Number.isFinite` guards against the wall clock being broken (e.g.
   * a mis-set bench env that returns `NaN`); a non-finite age is
   * treated as "we don't know, don't claim stale".
   */
  isStale(task: CronTask): boolean {
    if (process.env['KIMI_CRON_NO_STALE'] === '1') return false;
    if (task.recurring === false) return false;
    const age = this.clocks.wallNow() - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  /**
   * Translate a scheduler fire into a steer.
   *
   * Honours the documented 7-day auto-expire contract for recurring
   * tasks: a stale recurring task gets exactly one final delivery
   * (already issued above) and is then removed from the store. The
   * scheduler picks up the deletion on its next tick via `source()`
   * and stops re-firing the task. One-shots are not affected — they
   * are deleted by the scheduler immediately after delivery via the
   * `removeOneShot` callback.
   */
  private handleFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number },
  ): void {
    const stale = this.isStale(task);
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale,
    };
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderCronFireXml(origin, task.prompt),
      },
    ];
    this.agent.emitEvent({
      type: 'cron.fired',
      origin,
      prompt: task.prompt,
    });
    this.agent.turn.steer(content, origin);

    // 7-day auto-expire — the recurring branch of CronCreate's tool
    // description promises this contract to the model. Without the
    // removal a long-lived session keeps re-injecting a multi-day-old
    // cron prompt forever; with it, the task fires one last time
    // (above) and is then dropped.
    if (stale && task.recurring !== false) {
      this.removeTasks([task.id]);
    }
  }

  /**
   * Reserved hook for an explicit "you missed N fires while offline"
   * banner. Today the scheduler's `coalescedCount` semantics already
   * communicate missed fires inside the `cron_job` envelope (and
   * recurring tasks past 7 days arrive with `stale: true`), so the
   * resume path does NOT invoke this from the framework. The method
   * stays exposed because adding a separate user-facing banner later
   * — e.g. for one-shots whose fire times all landed during a long
   * outage — should not require an API change here.
   *
   * The `renderMissedNotification` callback is supplied by the caller
   * (rather than imported here) so this module stays free of UI / copy
   * coupling; the same manager works for tests that want to inject a
   * trivial renderer.
   *
   * `count: 0` is a no-op — the scheduler-side missed-task detector
   * filters empties before calling us, but defending here keeps the
   * contract simple ("safe to call with anything, no-op when empty").
   */
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (
      tasks: readonly CronTask[],
    ) => readonly ContentPart[],
  ): void {
    if (tasks.length === 0) return;
    const content = renderMissedNotification(tasks);
    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    this.agent.turn.steer(content, origin);
  }

  /**
   * Wire `SIGUSR1` to a manual `tick()` so bench scripts can advance the
   * scheduler with `kill -USR1 <pid>` without a custom RPC.
   *
   * Gated on `KIMI_CRON_MANUAL_TICK=1` for two reasons:
   *
   *   1. SIGUSR1 only makes sense when auto-tick is off. When the 1s
   *      interval is running, it already advances the scheduler — a
   *      manual signal is redundant.
   *   2. In production a single CLI process can host one main agent plus
   *      many subagents. Each Agent unconditionally binding a SIGUSR1
   *      listener would put us over Node's 10-listener default cap and
   *      print a `MaxListenersExceededWarning`. Coupling the binding to
   *      the same env that disables auto-tick keeps the production path
   *      at zero listeners while still giving benches the affordance.
   *
   * Skipped on Windows because Node's signal layer does not deliver
   * POSIX signals there; attempting to `process.on('SIGUSR1', ...)` is a
   * silent no-op but we avoid the call entirely so the bookkeeping
   * (`sigusr1Handler !== null` means "we did bind") stays accurate.
   *
   * Idempotent — repeated calls keep the same listener registered once,
   * so `start() → start()` does not stack handlers.
   *
   * The handler swallows any throw from `tick()` because a signal-driven
   * bench tool must never crash the host process; the tick failure mode
   * is already surfaced via logs inside the scheduler.
   * Set `KIMI_CRON_DEBUG=1` to surface the swallowed error to stderr —
   * mirrors `scheduler.ts`'s debugLog pattern so bench debugging can
   * see a bad tick.
   */
  private bindSigusr1(): void {
    if (process.platform === 'win32') return;
    if (process.env['KIMI_CRON_MANUAL_TICK'] !== '1') return;
    if (this.sigusr1Handler !== null) return;
    const handler: NodeJS.SignalsListener = () => {
      try {
        this.tick();
      } catch (error) {
        if (process.env['KIMI_CRON_DEBUG'] === '1') {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[cron/manager] SIGUSR1 tick threw: ${msg}\n`,
          );
        }
      }
    };
    this.sigusr1Handler = handler;
    process.on('SIGUSR1', handler);
  }

  /**
   * Detach the SIGUSR1 listener registered by `bindSigusr1`. Safe to
   * call when nothing is bound (no-op). Pair this with `stop()` so
   * vitest files don't leak signal handlers across the shared process —
   * `process.listenerCount('SIGUSR1')` should return to its pre-`start()`
   * value once `stop()` resolves.
   */
  private unbindSigusr1(): void {
    if (this.sigusr1Handler === null) return;
    process.off('SIGUSR1', this.sigusr1Handler);
    this.sigusr1Handler = null;
  }
}
