/**
 * TeamStore — session-scoped team files and shared task lists.
 *
 * A team file (`<sessionDir>/teams/<team>.json`) carries the team state and
 * its shared task list — the work-queue collaboration plane teammates claim
 * work from. It is deliberately NOT a roster authority: teammate membership
 * already persists in the session agent metadata (`AgentMeta.teammate`), so
 * the team file only holds what the metadata cannot — the tasks.
 *
 * Concurrency: all teammates of a session run in this process, so
 * read-modify-write races are serialized by a per-team promise queue; every
 * mutation is a full-file atomic write (temp + fsync + rename, via the
 * per-id JSON store). Process-external teammates would need a lockfile on
 * top of this — out of scope until a process-based backend exists.
 *
 * Task ids are per-team monotonically increasing integers held in the team
 * state (`nextTaskId` high-water mark), so ids are never reused within a
 * team — task references in conversation stay unambiguous.
 */

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';

/**
 * Team names hit the filesystem as `<sessionDir>/teams/<name>.json` (the
 * store's id regex doubles as the path-traversal guard), so they share the
 * teammate-name conservative charset.
 */
export const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TeamTask {
  readonly id: number;
  readonly subject: string;
  readonly description?: string | undefined;
  readonly status: TeamTaskStatus;
  /** Owning teammate's name; unset while unclaimed. */
  readonly owner?: string | undefined;
  /** Creator: a teammate name, or 'leader' when created outside a teammate. */
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface TeamState {
  readonly name: string;
  readonly createdAt: number;
  /** Agent id of the team creator (e.g. 'main'). */
  readonly createdBy: string;
  /** High-water mark: the id the NEXT created task receives. Starts at 1. */
  readonly nextTaskId: number;
  readonly tasks: readonly TeamTask[];
}

export interface CreateTeamTaskInput {
  readonly subject: string;
  readonly description?: string | undefined;
  /** Direct assignment at creation (leader dispatch); unset = claimable. */
  readonly owner?: string | undefined;
  readonly createdBy: string;
}

export interface UpdateTeamTaskInput {
  readonly status?: TeamTaskStatus | undefined;
  /**
   * Assignment change: a teammate name to (re)assign, `null` to clear the
   * owner (back to claimable), undefined to leave it untouched.
   */
  readonly owner?: string | null | undefined;
  readonly subject?: string | undefined;
  readonly description?: string | undefined;
}

/** Cheap structural guard for the per-id store's `list()`/`read()` drop rules. */
function isTeamState(obj: unknown): obj is TeamState {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['nextTaskId'] === 'number' &&
    Array.isArray(record['tasks'])
  );
}

export interface TeamStoreOptions {
  /**
   * Fired synchronously after a team state is persisted (team created, task
   * created/updated/claimed). The session turns this into the `team.updated`
   * protocol event for read-only team viewers.
   */
  readonly onChange?: ((teamName: string) => void) | undefined;
}

export class TeamStore {
  private readonly store: PerIdJsonStore<TeamState>;
  private readonly states = new Map<string, TeamState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    sessionDir: string,
    private readonly options: TeamStoreOptions = {},
  ) {
    this.store = createPerIdJsonStore<TeamState>({
      rootDir: sessionDir,
      subdir: 'teams',
      idRegex: TEAM_NAME_PATTERN,
      isValid: isTeamState,
      entityName: 'team name',
    });
  }

  /**
   * Create the team file if it does not exist yet. Idempotent; returns the
   * live state either way.
   */
  async ensureTeam(teamName: string, createdBy: string): Promise<TeamState> {
    return this.mutate(teamName, (current) => {
      if (current !== undefined) return { state: current, result: current };
      const state: TeamState = {
        name: teamName,
        createdAt: Date.now(),
        createdBy,
        nextTaskId: 1,
        tasks: [],
      };
      return { state, result: state };
    });
  }

  /** The live team state, or undefined when no such team file exists. */
  async getTeam(teamName: string): Promise<TeamState | undefined> {
    return this.load(teamName);
  }

  /** Every team file in the session (corrupt/unreadable ones are dropped). */
  async listTeams(): Promise<readonly TeamState[]> {
    const teams = await this.store.list();
    for (const team of teams) this.states.set(team.name, team);
    return teams;
  }

  async createTask(teamName: string, input: CreateTeamTaskInput): Promise<TeamTask> {
    return this.mutate(teamName, (current) => {
      const base = current ?? {
        name: teamName,
        createdAt: Date.now(),
        createdBy: input.createdBy,
        nextTaskId: 1,
        tasks: [],
      };
      const task: TeamTask = {
        id: base.nextTaskId,
        subject: input.subject,
        description: input.description,
        status: 'pending',
        owner: input.owner,
        createdBy: input.createdBy,
        createdAt: Date.now(),
      };
      const state: TeamState = {
        ...base,
        nextTaskId: base.nextTaskId + 1,
        tasks: [...base.tasks, task],
      };
      return { state, result: task };
    });
  }

  async listTasks(teamName: string): Promise<readonly TeamTask[] | undefined> {
    return (await this.load(teamName))?.tasks;
  }

  async getTask(teamName: string, taskId: number): Promise<TeamTask | undefined> {
    return (await this.load(teamName))?.tasks.find((task) => task.id === taskId);
  }

  /** Apply a partial update to one task. Returns undefined when it does not exist. */
  async updateTask(
    teamName: string,
    taskId: number,
    update: UpdateTeamTaskInput,
  ): Promise<TeamTask | undefined> {
    return this.mutate(teamName, (current) => {
      const task = current?.tasks.find((candidate) => candidate.id === taskId);
      if (current === undefined || task === undefined) {
        return { state: current, result: undefined };
      }
      const updated: TeamTask = {
        ...task,
        status: update.status ?? task.status,
        owner: update.owner === undefined ? task.owner : (update.owner ?? undefined),
        subject: update.subject ?? task.subject,
        description: update.description ?? task.description,
      };
      const state: TeamState = {
        ...current,
        tasks: current.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)),
      };
      return { state, result: updated };
    });
  }

  /**
   * Claim the next available task for `owner`: the oldest pending task with
   * no owner, flipped to `in_progress` with `owner` set — one atomic
   * read-modify-write under the team queue, so concurrent claimers can
   * never win the same task. Returns undefined when nothing is claimable.
   */
  async claimNextTask(teamName: string, owner: string): Promise<TeamTask | undefined> {
    return this.mutate(teamName, (current) => {
      const task = current?.tasks.find(
        (candidate) => candidate.status === 'pending' && candidate.owner === undefined,
      );
      if (current === undefined || task === undefined) {
        return { state: current, result: undefined };
      }
      const claimed: TeamTask = { ...task, status: 'in_progress', owner };
      const state: TeamState = {
        ...current,
        tasks: current.tasks.map((candidate) => (candidate.id === task.id ? claimed : candidate)),
      };
      return { state, result: claimed };
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Read-through cache; the mutation queue is the only writer. */
  private async load(teamName: string): Promise<TeamState | undefined> {
    const cached = this.states.get(teamName);
    if (cached !== undefined) return cached;
    const fromDisk = await this.store.read(teamName);
    if (fromDisk !== undefined) this.states.set(teamName, fromDisk);
    return fromDisk;
  }

  /**
   * Serialize one read-modify-write per team. The whole critical section —
   * load, transform, persist — runs inside the queue, so interleaved async
   * callers observe each other's writes, never a stale snapshot.
   */
  private mutate<T>(
    teamName: string,
    fn: (current: TeamState | undefined) => { state: TeamState | undefined; result: T },
  ): Promise<T> {
    const previous = this.queues.get(teamName) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.load(teamName);
      const { state, result } = fn(current);
      if (state !== undefined && state !== current) {
        await this.store.write(teamName, state);
        this.states.set(teamName, state);
        this.options.onChange?.(teamName);
      }
      return result;
    });
    // The queue must survive a rejection: a failed write rejects `next`,
    // and without the catch the NEXT mutation would reject immediately.
    this.queues.set(teamName, next.catch(() => {}));
    return next;
  }
}
