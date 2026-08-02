/**
 * Shadow-git workspace snapshots (F4).
 *
 * A per-workspace shadow repository lives at
 * `<brandHome>/snapshots/<workdir-key>/` and is driven entirely through
 * `git --git-dir <shadow> --work-tree <workdir>` commands executed via kaos —
 * the user's own `.git` is never written (only read for seeding alternates,
 * the index, and ignore rules). Nothing is ever committed: `add` +
 * `write-tree` yields a content-addressed tree hash per snapshot.
 *
 * Tracking happens at turn boundaries (a baseline before the first step) and
 * after every step, and the records land in the wire log as `snapshot.track`
 * / `snapshot.rewind` state records, so a resumed session rebuilds the
 * in-memory index by replaying. `/rewind` resolves the Nth-from-last
 * user-anchored turn, then checks out its baseline tree file by file (files
 * absent from the baseline are deleted), which rolls back exactly the files
 * the agent touched without trampling concurrent user edits elsewhere.
 *
 * Everything here is best-effort: snapshot failures log a warning and never
 * fail a turn, and the whole feature switches off silently when git is
 * missing, the kaos backend is not local (a local git-dir cannot address a
 * remote worktree), or `[snapshot] enabled = false` is set.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@cloud-code/kaos';
import { join } from 'pathe';

import { ErrorCodes, CloudCodeError } from '#/errors';
import type { RewindFilesResult } from '#/rpc';
import { encodeWorkDirKey } from '#/session/store/workdir-key';

import type { Agent } from '..';
import type { PromptOrigin } from '../context';
import type { AgentRecordOf } from '../records';

export type { RewindFilesResult } from '#/rpc';

const GIT_TIMEOUT_MS = 5_000;
const GC_PRUNE = '7.days';
const GC_EVERY_N_TRACKS = 50;
const REVERT_BATCH_SIZE = 100;
const SNAPSHOT_MAX_FILE_SIZE_BYTES_DEFAULT = 2 * 1024 * 1024;

// git -c flag bundles, after opencode's snapshot: large-worktree handling,
// literal (unescaped) path output for name listings.
const CORE_FLAGS = ['-c', 'core.longpaths=true', '-c', 'core.symlinks=true'] as const;
const CFG_FLAGS = ['-c', 'core.autocrlf=false', ...CORE_FLAGS] as const;
const QUOTE_FLAGS = [...CFG_FLAGS, '-c', 'core.quotepath=false'] as const;

const SHADOW_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.autocrlf', 'false'],
  ['core.longpaths', 'true'],
  ['core.symlinks', 'true'],
  ['core.fsmonitor', 'false'],
  // Tuning for very large worktrees so the first add stays bounded.
  ['feature.manyFiles', 'true'],
  ['index.version', '4'],
  ['index.threads', 'true'],
  ['core.untrackedCache', 'true'],
];

// Baseline `info/exclude` content for the shadow repo: without a user
// `.gitignore` (non-git workdir) the first `ls-files --others` would
// otherwise sweep dependency and build-output trees into the snapshot.
const BASELINE_EXCLUDES = [
  '.git/',
  'node_modules/',
  '.cloud-code',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
] as const;

interface GitRunResult {
  readonly ok: boolean;
  readonly exitCode?: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when git never produced an exit code: spawn error, timeout, or stream failure. */
  readonly failure?: 'timeout' | 'spawn-error' | 'command-failed' | undefined;
}

interface TurnSnapshotEntry {
  baseline?: string | undefined;
  anchor: boolean;
  readonly steps: Map<number, { tree: string; files: readonly string[] }>;
}

// Process-wide mutual exclusion per shadow git-dir: sessions sharing a
// workspace share one shadow repo, and git index writes must not interleave.
const gitdirLocks = new Map<string, Promise<unknown>>();

export class SnapshotManager {
  private gitProbe: Promise<boolean> | undefined;
  private gitUnavailableWarned = false;
  private tracksSinceGc = 0;
  private readonly initializedGitdirs = new Set<string>();
  private readonly sessionExcludes = new Set<string>();
  private readonly turns = new Map<number, TurnSnapshotEntry>();
  /** Turn IDs of user-anchored baselines, ascending — the /rewind count axis. */
  private readonly anchorTurns: number[] = [];

  constructor(private readonly agent: Agent) {}

  /* ------------------------------------------------------------------ */
  /*  Wire-record restore (records contract: in-memory only, no I/O)     */
  /* ------------------------------------------------------------------ */

  restoreTrack(record: AgentRecordOf<'snapshot.track'>): void {
    this.applyTrack(record);
  }

  restoreRewind(_record: AgentRecordOf<'snapshot.rewind'>): void {
    // Audit-only record: the pre-rewind tree stays durable in the wire log
    // for a future redo/unrewind, and a rewind does not invalidate any
    // baseline (shadow objects are content-addressed), so there is no
    // in-memory index state to rebuild here.
  }

  /* ------------------------------------------------------------------ */
  /*  Tracking (live path)                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Capture the turn baseline. Called once per turn after the prompt is
   * accepted and before the first step runs, so a turn's starting worktree
   * state (including the user's uncommitted changes) is recoverable.
   */
  async trackTurnBaseline(turnId: number, origin: PromptOrigin): Promise<void> {
    if (!this.staticallyEnabled() || this.agent.records.restoring !== null) return;
    try {
      const tree = await this.captureTree();
      if (tree === undefined) return;
      const record: AgentRecordOf<'snapshot.track'> = {
        type: 'snapshot.track',
        turnId,
        kind: 'turn_baseline',
        tree,
        files: [],
        ...(isRewindAnchorOrigin(origin) ? { anchor: true } : {}),
      };
      this.applyTrack(record);
      this.agent.records.logRecord(record);
      this.bumpGcCounter();
    } catch (error) {
      this.agent.log.warn('snapshot: baseline track failed', { error });
    }
  }

  /**
   * Capture the post-step tree and the cumulative diff against the turn
   * baseline. Runs in the loop's `afterStep` hook (after `step.end` is
   * sealed); hook errors are swallowed by the loop, and this method never
   * throws regardless. Returns the step tree so observers (the goal evidence
   * ledger) can associate it with the step — undefined when tracking is
   * disabled, unavailable, or failed.
   */
  async trackAfterStep(turnId: number, step: number): Promise<string | undefined> {
    if (!this.staticallyEnabled() || this.agent.records.restoring !== null) return undefined;
    const baseline = this.turns.get(turnId)?.baseline;
    if (baseline === undefined) return undefined;
    try {
      const result = await this.locked(async () => {
        if (!(await this.ensureReady())) return undefined;
        const gitdir = this.gitdir();
        await this.add(gitdir);
        const tree = await this.writeTree(gitdir);
        if (tree === undefined) return undefined;
        const files = await this.diffCachedFiles(gitdir, baseline);
        return { tree, files };
      });
      if (result === undefined) return undefined;
      const record: AgentRecordOf<'snapshot.track'> = {
        type: 'snapshot.track',
        turnId,
        kind: 'step',
        step,
        tree: result.tree,
        files: result.files,
      };
      this.applyTrack(record);
      this.agent.records.logRecord(record);
      this.bumpGcCounter();
      return result.tree;
    } catch (error) {
      this.agent.log.warn('snapshot: step track failed', { error });
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Rewind                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Roll the workspace files changed since the Nth-from-last user-anchored
   * turn back to that turn's baseline tree. Pure file-system effect: the
   * conversation is untouched (that is `context.undo`'s job in 'both' mode).
   *
   * The pre-rewind worktree is tracked first and stored in the
   * `snapshot.rewind` record, so a future redo can restore the exact state
   * this call replaced.
   */
  async rewindFiles(count: number): Promise<RewindFilesResult> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new CloudCodeError(
        ErrorCodes.REQUEST_INVALID,
        `Cannot rewind ${String(count)} prompts; count must be a positive integer.`,
        { details: { reason: 'rewind_unavailable' } },
      );
    }
    if (!this.staticallyEnabled()) {
      throw rewindUnavailable('file rewind unavailable (snapshots disabled)');
    }
    if (!(await this.probeGit())) {
      throw rewindUnavailable('file rewind unavailable (git not found)');
    }
    const targetTurnId = this.anchorTurns[this.anchorTurns.length - count];
    if (targetTurnId === undefined) {
      throw new CloudCodeError(
        ErrorCodes.REQUEST_INVALID,
        `Cannot rewind ${String(count)} ${count === 1 ? 'prompt' : 'prompts'}; only ` +
          `${String(this.anchorTurns.length)} ${
            this.anchorTurns.length === 1 ? 'turn has' : 'turns have'
          } file snapshots.`,
        {
          details: {
            reason: 'rewind_limit',
            requestedCount: count,
            rewindableCount: this.anchorTurns.length,
          },
        },
      );
    }
    const baseline = this.turns.get(targetTurnId)?.baseline;
    if (baseline === undefined) {
      throw rewindUnavailable('file rewind unavailable (no baseline snapshot for that turn)');
    }

    // Everything the agent touched from the target turn onward, across all
    // turns (goal continuations included), not just anchored ones.
    const files = [
      ...new Set(
        [...this.turns.entries()]
          .filter(([turnId]) => turnId >= targetTurnId)
          .flatMap(([, entry]) => [...entry.steps.values()].flatMap((step) => step.files)),
      ),
    ].toSorted();

    const preRewindTree = await this.locked(async () => {
      if (!(await this.ensureReady())) return undefined;
      const gitdir = this.gitdir();
      // Track the current state first: this both preserves the pre-rewind
      // worktree for a future redo and makes the shadow index agree with the
      // worktree before checkout/rm rewrite it.
      await this.add(gitdir);
      const tree = await this.writeTree(gitdir);
      if (tree === undefined) return undefined;
      await this.revertToTree(gitdir, baseline, files);
      return tree;
    });
    if (preRewindTree === undefined) {
      throw rewindUnavailable('file rewind unavailable (shadow repository error)');
    }

    this.agent.records.logRecord({
      type: 'snapshot.rewind',
      turnId: targetTurnId,
      preRewindTree,
      files,
    });
    return { turnId: targetTurnId, files, preRewindTree };
  }

  /* ------------------------------------------------------------------ */
  /*  Enablement and paths                                               */
  /* ------------------------------------------------------------------ */

  private get brandHome(): string | undefined {
    return this.agent.brandHomeDir;
  }

  private get maxFileSizeBytes(): number {
    return (
      this.agent.kimiConfig?.snapshot?.maxFileSizeBytes ?? SNAPSHOT_MAX_FILE_SIZE_BYTES_DEFAULT
    );
  }

  /**
   * Static gates evaluated lazily on every operation (a `setKaos` / cwd
   * switch or config flip is picked up without any explicit sync): main
   * agent only, config on, brand home known (required to locate the shadow
   * repo), local kaos backend (a local git-dir cannot address a remote
   * worktree — v1 limitation).
   */
  private staticallyEnabled(): boolean {
    return (
      this.agent.type === 'main' &&
      this.agent.kimiConfig?.snapshot?.enabled !== false &&
      this.brandHome !== undefined &&
      this.agent.kaos.name === 'local'
    );
  }

  private workdir(): string {
    return this.agent.kaos.getcwd();
  }

  private gitdir(): string {
    return join(this.brandHome ?? '', 'snapshots', encodeWorkDirKey(this.workdir()));
  }

  private probeGit(): Promise<boolean> {
    this.gitProbe ??= this.runGitProbe();
    return this.gitProbe;
  }

  private async runGitProbe(): Promise<boolean> {
    const result = await runGit(this.agent.kaos, ['--version']);
    if (result.ok) return true;
    if (!this.gitUnavailableWarned) {
      this.gitUnavailableWarned = true;
      this.agent.log.warn('file snapshots disabled: git probe failed', {
        failure: result.failure,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Shadow repo lifecycle (callers hold the lock)                      */
  /* ------------------------------------------------------------------ */

  private async ensureReady(): Promise<boolean> {
    if (!(await this.probeGit())) return false;
    const gitdir = this.gitdir();
    if (this.initializedGitdirs.has(gitdir)) return true;
    if (await pathExists(this.agent.kaos, gitdir)) {
      // A previous session initialized this shadow repo; excludes may have
      // been extended since, so re-sync before marking ready.
      await this.syncExcludes(gitdir);
      this.initializedGitdirs.add(gitdir);
      return true;
    }
    const kaos = this.agent.kaos;
    const workdir = this.workdir();
    await kaos.mkdir(gitdir, { parents: true, existOk: true });
    // `git --git-dir <dir> init` (not GIT_DIR env): execWithEnv on a local
    // kaos without env layers would REPLACE the child environment instead of
    // overlaying it, dropping PATH/HOME from the spawned git.
    const init = await runGit(kaos, ['--git-dir', gitdir, 'init']);
    if (!init.ok) {
      this.agent.log.warn('snapshot: git init failed', {
        failure: init.failure,
        exitCode: init.exitCode,
        stderr: init.stderr,
      });
      return false;
    }
    for (const [key, value] of SHADOW_CONFIG) {
      const configured = await runGit(kaos, ['--git-dir', gitdir, 'config', key, value]);
      if (!configured.ok) {
        this.agent.log.warn('snapshot: git config failed', { key, stderr: configured.stderr });
      }
    }
    await this.seed(gitdir);
    await this.syncExcludes(gitdir);
    this.initializedGitdirs.add(gitdir);
    this.agent.log.debug('snapshot: shadow repository initialized', { gitdir, workdir });
    return true;
  }

  /**
   * Reuse the user repo's object database (and its own alternates chain) via
   * `objects/info/alternates`, and copy its index: on huge checkouts the
   * first `add` otherwise re-hashes the entire tree. The user's repo is only
   * ever read here.
   */
  private async seed(gitdir: string): Promise<void> {
    const kaos = this.agent.kaos;
    const workdir = this.workdir();
    const common = await runGit(kaos, [
      '-C',
      workdir,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (!common.ok) return; // not a git worktree — seed skipped by design
    const source = common.stdout.trim();
    if (source.length === 0 || !(await pathExists(kaos, source))) return;

    const sourceObjects = join(source, 'objects');
    const chained = (await readTextOr(kaos, join(sourceObjects, 'info', 'alternates'), ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const alternates: string[] = [];
    for (const candidate of [sourceObjects, ...chained]) {
      if (await pathExists(kaos, candidate)) alternates.push(candidate);
    }
    if (alternates.length > 0) {
      await kaos.mkdir(join(gitdir, 'objects', 'info'), { parents: true, existOk: true });
      await kaos.writeText(
        join(gitdir, 'objects', 'info', 'alternates'),
        alternates.join('\n') + '\n',
      );
    }

    // Best-effort: a missing/incompatible index just falls back to a full add.
    try {
      const indexBytes = await kaos.readBytes(join(source, 'index'));
      await kaos.writeBytes(join(gitdir, 'index'), indexBytes);
    } catch {
      /* no usable index */
    }

    // `--exclude-standard` resolves `info/exclude` against the shadow repo,
    // so import the user's own info/exclude patterns explicitly.
    const userExclude = await readTextOr(kaos, join(source, 'info', 'exclude'), '');
    if (userExclude.trim().length > 0) {
      await this.mergeExcludeFile(gitdir, userExclude.split('\n'));
    }
  }

  private async syncExcludes(gitdir: string): Promise<void> {
    await this.mergeExcludeFile(gitdir, [
      ...BASELINE_EXCLUDES,
      ...[...this.sessionExcludes].map((file) => `/${file.replaceAll('\\', '/')}`),
    ]);
  }

  private async mergeExcludeFile(gitdir: string, extraLines: readonly string[]): Promise<void> {
    const kaos = this.agent.kaos;
    const file = join(gitdir, 'info', 'exclude');
    const existing = await readTextOr(kaos, file, '');
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const line of [...existing.split('\n'), ...extraLines]) {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
    await kaos.mkdir(join(gitdir, 'info'), { parents: true, existOk: true });
    await kaos.writeText(file, merged.join('\n') + '\n');
  }

  /**
   * Stage every worktree change into the shadow index. Only candidate paths
   * (modified tracked files + untracked files, minus ignored and oversized
   * ones) are added, so incremental scans stay cheap on large repos.
   */
  private async add(gitdir: string): Promise<void> {
    const kaos = this.agent.kaos;
    const workdir = this.workdir();
    const baseArgs = ['-C', workdir, '--git-dir', gitdir, '--work-tree', workdir];
    const [diff, other] = await Promise.all([
      runGit(kaos, [...QUOTE_FLAGS, ...baseArgs, 'diff-files', '--name-only', '-z', '--', '.']),
      runGit(kaos, [
        ...QUOTE_FLAGS,
        ...baseArgs,
        'ls-files',
        '--full-name',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ]),
    ]);
    if (!diff.ok || !other.ok) {
      this.agent.log.warn('snapshot: failed to list worktree files', {
        diff: gitFailureFields(diff),
        other: gitFailureFields(other),
      });
      return;
    }

    const tracked = splitNul(diff.stdout);
    const untracked = splitNul(other.stdout);
    const all = [...new Set([...tracked, ...untracked])];
    if (all.length === 0) return;

    // Resolve the source repo's ignore rules against the exact candidate set
    // (--no-index keeps this pattern-based even for tracked paths), so files
    // that became ignored after being tracked do not linger in snapshots.
    const ignored = await this.checkIgnore(all);
    if (ignored.size > 0) {
      await runGit(
        kaos,
        [
          ...CFG_FLAGS,
          ...baseArgs,
          'rm',
          '--cached',
          '-f',
          '--ignore-unmatch',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { stdin: encodeTopLevelLiteralPathspecs([...ignored]) },
      );
    }

    const allow = all.filter((file) => !ignored.has(file));
    if (allow.length === 0) return;

    const untrackedSet = new Set(untracked);
    const blocked = new Set<string>();
    await Promise.all(
      allow.map(async (file) => {
        // Only untracked files are size-gated: tracked blobs are mostly
        // already hashed in the seeded alternates.
        if (!untrackedSet.has(file)) return;
        const size = await fileSize(kaos, join(workdir, file));
        if (size !== undefined && size > this.maxFileSizeBytes) blocked.add(file);
      }),
    );
    if (blocked.size > 0) {
      for (const file of blocked) this.sessionExcludes.add(file);
      await this.syncExcludes(gitdir);
    }

    const stage = allow.filter((file) => !blocked.has(file));
    if (stage.length === 0) return;
    const staged = await runGit(
      kaos,
      [...CFG_FLAGS, ...baseArgs, 'add', '--all', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { stdin: encodeTopLevelLiteralPathspecs(stage) },
    );
    if (!staged.ok) {
      this.agent.log.warn('snapshot: git add failed', gitFailureFields(staged));
    }
  }

  /** check-ignore against the *user* repo; empty set when not a worktree. */
  private async checkIgnore(files: readonly string[]): Promise<Set<string>> {
    if (files.length === 0) return new Set();
    const workdir = this.workdir();
    // check-ignore treats a leading colon as pathspec magic but accepts and
    // echoes a protective ./ prefix.
    const checkPaths = files.map((file) => (file.startsWith(':') ? `./${file}` : file));
    const result = await runGit(
      this.agent.kaos,
      [
        ...QUOTE_FLAGS,
        '--git-dir',
        join(workdir, '.git'),
        '--work-tree',
        workdir,
        'check-ignore',
        '--no-index',
        '--stdin',
        '-z',
      ],
      { stdin: checkPaths.join('\0') + '\0' },
    );
    // Exit 0 = some paths ignored, 1 = none; anything else (not a repo,
    // unreadable .git) means "no user ignore rules to apply".
    if (result.exitCode !== 0 && result.exitCode !== 1) return new Set();
    return new Set(
      splitNul(result.stdout).map((file) => (file.startsWith('./:') ? file.slice(2) : file)),
    );
  }

  private async writeTree(gitdir: string): Promise<string | undefined> {
    const result = await runGit(this.agent.kaos, [
      '-C',
      this.workdir(),
      '--git-dir',
      gitdir,
      '--work-tree',
      this.workdir(),
      'write-tree',
    ]);
    if (!result.ok) {
      this.agent.log.warn('snapshot: git write-tree failed', gitFailureFields(result));
      return undefined;
    }
    return result.stdout.trim();
  }

  /** Files whose cached (post-add) state differs from the given tree. */
  private async diffCachedFiles(gitdir: string, tree: string): Promise<string[]> {
    const result = await runGit(this.agent.kaos, [
      ...QUOTE_FLAGS,
      '-C',
      this.workdir(),
      '--git-dir',
      gitdir,
      '--work-tree',
      this.workdir(),
      'diff',
      '--cached',
      '--no-ext-diff',
      '--name-only',
      tree,
      '--',
      '.',
    ]);
    if (!result.ok) {
      this.agent.log.warn('snapshot: git diff --cached failed', gitFailureFields(result));
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Per-file restore from a baseline tree: `checkout <tree> -- <file>` for
   * paths present in the tree (restores content and exec bits, and updates
   * the shadow index), `git rm -f` for paths absent from it (they were
   * created after the baseline). Never a whole-tree checkout — files the
   * agent did not touch keep their current (possibly user-edited) content.
   */
  private async revertToTree(
    gitdir: string,
    tree: string,
    files: readonly string[],
  ): Promise<void> {
    const kaos = this.agent.kaos;
    const baseArgs = ['-C', this.workdir(), '--git-dir', gitdir, '--work-tree', this.workdir()];
    for (let i = 0; i < files.length; i += REVERT_BATCH_SIZE) {
      const chunk = files.slice(i, i + REVERT_BATCH_SIZE);
      const listing = await runGit(kaos, [
        ...CORE_FLAGS,
        ...baseArgs,
        'ls-tree',
        '--name-only',
        tree,
        '--',
        ...chunk.map(toLiteralPathspec),
      ]);
      if (!listing.ok) {
        for (const file of chunk) await this.revertOne(baseArgs, tree, file);
        continue;
      }
      const present = new Set(
        listing.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
      const toCheckout = chunk.filter((file) => present.has(file));
      if (toCheckout.length > 0) {
        const checkout = await runGit(kaos, [
          ...CORE_FLAGS,
          ...baseArgs,
          'checkout',
          tree,
          '--',
          ...toCheckout.map(toLiteralPathspec),
        ]);
        if (!checkout.ok) {
          for (const file of toCheckout) await this.revertOne(baseArgs, tree, file);
        }
      }
      const toDelete = chunk.filter((file) => !present.has(file));
      if (toDelete.length > 0) {
        const removed = await runGit(kaos, [
          ...CORE_FLAGS,
          ...baseArgs,
          'rm',
          '-f',
          '--ignore-unmatch',
          '--',
          ...toDelete.map(toLiteralPathspec),
        ]);
        if (!removed.ok) {
          this.agent.log.warn('snapshot: failed to delete files absent from baseline', {
            files: toDelete,
            ...gitFailureFields(removed),
          });
        }
      }
    }
  }

  private async revertOne(
    baseArgs: readonly string[],
    tree: string,
    file: string,
  ): Promise<void> {
    const kaos = this.agent.kaos;
    const checkout = await runGit(kaos, [
      ...CORE_FLAGS,
      ...baseArgs,
      'checkout',
      tree,
      '--',
      toLiteralPathspec(file),
    ]);
    if (checkout.ok) return;
    const listing = await runGit(kaos, [
      ...CORE_FLAGS,
      ...baseArgs,
      'ls-tree',
      tree,
      '--',
      toLiteralPathspec(file),
    ]);
    if (listing.ok && listing.stdout.trim().length > 0) {
      this.agent.log.warn('snapshot: file existed in baseline but checkout failed; keeping it', {
        file,
      });
      return;
    }
    const removed = await runGit(kaos, [
      ...CORE_FLAGS,
      ...baseArgs,
      'rm',
      '-f',
      '--ignore-unmatch',
      '--',
      toLiteralPathspec(file),
    ]);
    if (!removed.ok) {
      this.agent.log.warn('snapshot: failed to delete file absent from baseline', {
        file,
        ...gitFailureFields(removed),
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  gc                                                                 */
  /* ------------------------------------------------------------------ */

  private bumpGcCounter(): void {
    this.tracksSinceGc += 1;
    if (this.tracksSinceGc < GC_EVERY_N_TRACKS) return;
    this.tracksSinceGc = 0;
    void this.gcLocked();
  }

  private async gcLocked(): Promise<void> {
    try {
      await this.locked(async () => {
        const result = await runGit(this.agent.kaos, [
          '-C',
          this.workdir(),
          '--git-dir',
          this.gitdir(),
          'gc',
          `--prune=${GC_PRUNE}`,
        ]);
        if (!result.ok) {
          this.agent.log.warn('snapshot: git gc failed', gitFailureFields(result));
        }
      });
    } catch {
      /* best-effort housekeeping */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  private async captureTree(): Promise<string | undefined> {
    return this.locked(async () => {
      if (!(await this.ensureReady())) return undefined;
      const gitdir = this.gitdir();
      await this.add(gitdir);
      return this.writeTree(gitdir);
    });
  }

  private applyTrack(record: {
    readonly turnId: number;
    readonly kind: 'turn_baseline' | 'step';
    readonly step?: number | undefined;
    readonly tree: string;
    readonly files: readonly string[];
    readonly anchor?: boolean | undefined;
  }): void {
    let entry = this.turns.get(record.turnId);
    if (entry === undefined) {
      entry = { anchor: false, steps: new Map() };
      this.turns.set(record.turnId, entry);
    }
    if (record.kind === 'turn_baseline') {
      entry.baseline = record.tree;
      if (record.anchor === true) {
        entry.anchor = true;
        if (!this.anchorTurns.includes(record.turnId)) {
          this.anchorTurns.push(record.turnId);
          this.anchorTurns.sort((a, b) => a - b);
        }
      }
      return;
    }
    if (record.step !== undefined) {
      entry.steps.set(record.step, { tree: record.tree, files: record.files });
    }
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.gitdir();
    const previous = gitdirLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    gitdirLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (gitdirLocks.get(key) === run) gitdirLocks.delete(key);
    }
  }
}

function rewindUnavailable(message: string): CloudCodeError {
  return new CloudCodeError(ErrorCodes.REQUEST_INVALID, message, {
    details: { reason: 'rewind_unavailable' },
  });
}

/** The /rewind anchor predicate — mirrors the /undo user-anchor set. */
function isRewindAnchorOrigin(origin: PromptOrigin): boolean {
  if (origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') return origin.trigger === 'user-slash';
  if (origin.kind === 'plugin_command') return origin.trigger === 'user-slash';
  return false;
}

function gitFailureFields(result: GitRunResult): Record<string, unknown> {
  return {
    failure: result.failure,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

function splitNul(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

/** Literal, worktree-root-relative pathspecs, NUL-terminated for stdin. */
function encodeTopLevelLiteralPathspecs(files: readonly string[]): string {
  return files.map((file) => `:(top,literal)${file}`).join('\0') + '\0';
}

function toLiteralPathspec(file: string): string {
  return `:(top,literal)${file}`;
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextOr(kaos: Kaos, path: string, fallback: string): Promise<string> {
  try {
    return await kaos.readText(path);
  } catch {
    return fallback;
  }
}

async function fileSize(kaos: Kaos, path: string): Promise<number | undefined> {
  try {
    const stat = await kaos.stat(path);
    // Regular files only (S_IFMT 0o170000 / S_IFREG 0o100000).
    if ((stat.stMode & 0o170000) !== 0o100000) return undefined;
    return stat.stSize;
  } catch {
    return undefined;
  }
}

/**
 * Run one git command through kaos with a hard timeout, after
 * `session/git-context.ts`'s runner: structured outcome (never throws on a
 * non-zero exit), SIGKILL on timeout, both streams captured. `args` carries
 * the full invocation (including any `-C`/`--git-dir` flags).
 */
async function runGit(
  kaos: Kaos,
  args: readonly string[],
  opts?: { stdin?: string | undefined },
): Promise<GitRunResult> {
  let proc: KaosProcess | undefined;
  try {
    proc = await kaos.exec('git', ...args);
  } catch {
    return { ok: false, stdout: '', stderr: '', failure: 'spawn-error' };
  }

  try {
    if (opts?.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();
  } catch {
    // Only catches synchronous throws (writing to an already-destroyed
    // stream). A broken pipe — git exiting before it drains our input, e.g.
    // `check-ignore --stdin` against a non-repository — arrives later on the
    // stream's 'error' event and is handled by kaos (`ignoreBrokenPipe`),
    // not here.
  }

  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  // Attach a rejection handler up front: if `work` rejects during the
  // timeout-handling window, Node must not flag an unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return { ok: exitCode === 0, exitCode, stdout, stderr: stderr.trim() };
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* process already gone */
    }
    // Let the streams drain so process resources are released, even though
    // the timed-out/errored output is discarded.
    await work.catch(() => {});
    if (timedOut) {
      return { ok: false, stdout: '', stderr: '', failure: 'timeout' };
    }
    return { ok: false, stdout: '', stderr: '', failure: 'command-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (proc !== undefined) {
      try {
        await proc.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
