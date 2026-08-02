/**
 * WorktreeMode — session worktree state holder (the EnterWorktree/ExitWorktree
 * backing store), modeled on PlanMode: an Agent-attached subsystem whose
 * transitions are journaled as wire records so a resumed session restores
 * both the state and (via the paired `config.update` record) the switched
 * working directory.
 *
 * A worktree session is entered at most one level deep: entering while
 * active is an error, matching Claude Code. The cwd switch itself rides the
 * existing `ConfigState.update({cwd})` machinery — kaos swap, builtin-tool
 * rebuild (Bash/ExecSession cwd, file-tool workspaceDir, sandbox roots) and
 * the replayable record all come from there; permission policies read
 * `agent.config.cwd` live and follow without any worktree-specific handling.
 */

import { randomUUID } from 'node:crypto';

import type { Agent } from '..';
import { generateHeroSlug } from '../../utils/hero-slug';
import {
  copyWorkspaceLocalConfig,
  copyWorktreeIncludeFiles,
  countWorktreeChanges,
  createWorktree,
  currentBranch,
  deleteWorktreeBranch,
  readWorktreeHead,
  removeWorktree,
  resolveBaseCommit,
  resolveRepoContext,
  validateWorktreeSlug,
  worktreeBranchName,
  worktreePathFor,
  type WorktreeChangeSummary,
} from './git';

export interface WorktreeSessionState {
  /** Validated slug the worktree was created under. */
  readonly name: string;
  /** Absolute path of the worktree directory. */
  readonly path: string;
  /** Temporary branch checked out in the worktree (`worktree-<slug>`). */
  readonly branch: string;
  /** Session cwd before EnterWorktree; ExitWorktree returns here. */
  readonly originalCwd: string;
  /** Branch of the original checkout at enter time (informational). */
  readonly originalBranch?: string | undefined;
  /** Commit the worktree branch started at; the dirty-gate baseline. */
  readonly headCommit: string;
  /** Main working-tree root that owns `.cloud-code/worktrees/`. */
  readonly mainRepoRoot: string;
}

export interface EnterWorktreeOptions {
  readonly name?: string | undefined;
  readonly base?: string | undefined;
}

export interface EnterWorktreeResult {
  readonly state: WorktreeSessionState;
  /** True when an existing worktree with the same name was re-attached. */
  readonly resumed: boolean;
  /** Files propagated from the base checkout (local config + .worktreeinclude). */
  readonly carriedFiles: readonly string[];
}

export interface ExitWorktreeOptions {
  readonly action: 'keep' | 'remove';
  /**
   * Removal gate override. The dirty check runs in the tool layer BEFORE
   * calling this; `discardChanges` documents at the mode level that the
   * caller consciously passed that gate. Without it, `remove` refuses when
   * the worktree has uncommitted files or commits ahead of the baseline.
   */
  readonly discardChanges?: boolean | undefined;
}

export interface ExitWorktreeResult {
  readonly action: 'keep' | 'remove';
  readonly path: string;
  readonly branch: string;
  readonly originalCwd: string;
  readonly discardedFiles: number;
  readonly discardedCommits: number;
}

export class WorktreeMode {
  private state: WorktreeSessionState | null = null;

  constructor(protected readonly agent: Agent) {}

  get isActive(): boolean {
    return this.state !== null;
  }

  get current(): WorktreeSessionState | null {
    return this.state;
  }

  /**
   * Create (or re-attach to) the worktree and switch the session into it.
   * Throws with an actionable message on every failure path; on throw, no
   * state, cwd, or record has been mutated.
   */
  async enter(options: EnterWorktreeOptions = {}): Promise<EnterWorktreeResult> {
    if (this.state !== null) {
      throw new Error(
        `Already in worktree "${this.state.name}" (${this.state.path}). ` +
          'Use ExitWorktree to leave it before entering another one.',
      );
    }

    const originalCwd = this.agent.config.cwd;
    const repo = await resolveRepoContext(this.agent.kaos, originalCwd);
    if (repo === null) {
      throw new Error(
        'Cannot create a worktree: the current working directory is not inside a git repository.',
      );
    }

    const requestedName = options.name?.trim();
    const slug =
      requestedName !== undefined && requestedName.length > 0
        ? requestedName
        : generateHeroSlug(randomUUID(), new Set());
    validateWorktreeSlug(slug);

    const requestedBase = options.base?.trim();
    const baseRef = requestedBase !== undefined && requestedBase.length > 0 ? requestedBase : 'HEAD';
    const baseSha = await resolveBaseCommit(this.agent.kaos, originalCwd, baseRef);
    if (baseSha === null) {
      throw new Error(`Cannot create a worktree: failed to resolve base ref "${baseRef}".`);
    }

    const branch = worktreeBranchName(slug);
    const path = worktreePathFor(repo.mainRepoRoot, slug);

    // Re-attach path: a worktree with this name already exists (created by an
    // earlier session, or kept by a previous ExitWorktree). Skip creation and
    // post-create propagation entirely — the checkout is already materialized.
    const existingHead = await readWorktreeHead(this.agent.kaos, path);
    const resumed = existingHead !== null;

    const carriedFiles: string[] = [];
    if (!resumed) {
      await createWorktree(this.agent.kaos, repo.mainRepoRoot, path, branch, baseSha);
      const warn = (message: string): void => {
        this.agent.log.warn(message);
      };
      await copyWorkspaceLocalConfig(this.agent.kaos, repo.repoRoot, path, warn);
      carriedFiles.push(
        ...(await copyWorktreeIncludeFiles(this.agent.kaos, repo.repoRoot, path, warn)),
      );
    }

    const state: WorktreeSessionState = {
      name: slug,
      path,
      branch,
      originalCwd,
      originalBranch: await currentBranch(this.agent.kaos, originalCwd),
      headCommit: baseSha,
      mainRepoRoot: repo.mainRepoRoot,
    };

    // Record first so the wire always shows the enter before the cwd switch
    // that followed it; restore reads them in the same order.
    this.agent.records.logRecord({
      type: 'worktree.enter',
      name: state.name,
      path: state.path,
      branch: state.branch,
      originalCwd: state.originalCwd,
      originalBranch: state.originalBranch,
      headCommit: state.headCommit,
      mainRepoRoot: state.mainRepoRoot,
    });
    this.state = state;
    this.agent.config.update({ cwd: path });
    await this.agent.refreshSystemPrompt();

    return { state, resumed, carriedFiles };
  }

  /**
   * Uncommitted-file and commit counts for the active worktree, or null when
   * git cannot answer (fail-closed for removal decisions).
   */
  async countChanges(): Promise<WorktreeChangeSummary | null> {
    const state = this.requireState();
    return countWorktreeChanges(this.agent.kaos, state.path, state.headCommit);
  }

  /**
   * Leave the worktree and restore the original session cwd. `keep` leaves
   * the directory and branch on disk; `remove` deletes both. A failed
   * removal throws and leaves the session fully untouched (still in the
   * worktree), so no error path ever strands the cwd inside a deleted or
   * half-removed directory.
   */
  async exit(options: ExitWorktreeOptions): Promise<ExitWorktreeResult> {
    const state = this.requireState();

    const summary = await countWorktreeChanges(
      this.agent.kaos,
      state.path,
      state.headCommit,
    );
    const discardedFiles = summary?.changedFiles ?? 0;
    const discardedCommits = summary?.commits ?? 0;

    if (options.action === 'remove') {
      if (
        options.discardChanges !== true &&
        (summary === null || summary.changedFiles > 0 || summary.commits > 0)
      ) {
        throw new Error(
          'Refusing to remove a worktree with unverified or unsaved work without discard_changes.',
        );
      }
      const removed = await removeWorktree(this.agent.kaos, state.mainRepoRoot, state.path);
      if (!removed.ok) {
        throw new Error(
          `Failed to remove worktree at ${state.path}: ${removed.stderr || 'git worktree remove failed'}. ` +
            'The session is still inside the worktree.',
        );
      }
      const branchDeleted = await deleteWorktreeBranch(
        this.agent.kaos,
        state.mainRepoRoot,
        state.branch,
      );
      if (!branchDeleted.ok) {
        this.agent.log.warn(
          `Worktree removed but branch ${state.branch} could not be deleted: ${branchDeleted.stderr}`,
        );
      }
    }

    this.agent.records.logRecord({
      type: 'worktree.exit',
      action: options.action,
      path: state.path,
      branch: state.branch,
      discardedFiles: options.action === 'remove' ? discardedFiles : undefined,
      discardedCommits: options.action === 'remove' ? discardedCommits : undefined,
    });
    this.state = null;
    this.agent.config.update({ cwd: state.originalCwd });
    await this.agent.refreshSystemPrompt();

    return {
      action: options.action,
      path: state.path,
      branch: state.branch,
      originalCwd: state.originalCwd,
      discardedFiles,
      discardedCommits,
    };
  }

  /**
   * Wire-replay restore: adopt the recorded state without touching git, cwd
   * (replayed separately through the paired `config.update` record), or the
   * system prompt.
   */
  restoreEnter(input: {
    readonly name: string;
    readonly path: string;
    readonly branch: string;
    readonly originalCwd: string;
    readonly originalBranch?: string | undefined;
    readonly headCommit: string;
    readonly mainRepoRoot: string;
  }): void {
    this.state = {
      name: input.name,
      path: input.path,
      branch: input.branch,
      originalCwd: input.originalCwd,
      originalBranch: input.originalBranch,
      headCommit: input.headCommit,
      mainRepoRoot: input.mainRepoRoot,
    };
  }

  restoreExit(): void {
    this.state = null;
  }

  private requireState(): WorktreeSessionState {
    if (this.state === null) {
      throw new Error('No active worktree session.');
    }
    return this.state;
  }
}
