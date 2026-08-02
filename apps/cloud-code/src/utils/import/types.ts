/**
 * Types for the deterministic `/import` engine (Kimi Code source).
 *
 * The engine builds an in-memory `KimiImportPlan` (scan phase, no writes),
 * the TUI renders it for preview/confirmation, and `applyKimiImportPlan`
 * executes it. Plans carry the prepared write payloads (merged config data,
 * history lines to append) so apply never re-derives what the user approved.
 */

export type ImportSourceId = 'claude' | 'codex' | 'kimi';

export type KimiImportSkipReason =
  /** Target already holds an entry with this identity; the existing one wins. */
  | 'conflict'
  /** Already imported before, or every entry is already present. */
  | 'duplicate'
  /** Format not understood: newer wire protocol or unknown wire record types. */
  | 'incompatible'
  /** Corrupt/unreadable source content (or structurally unusable, e.g. no workDir). */
  | 'invalid'
  /** Source exists but has no content worth importing. */
  | 'empty';

/**
 * Merge plan for key-structured files (config.toml, keybindings.json,
 * mcp.json). Keys are display paths such as `default_model`,
 * `models."kimi-code/kimi-for-coding"`, `mcpServers.context7`.
 */
export interface KeyMergePlan {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly importedKeys: readonly string[];
  /** Keys present in both files; the target's existing value is kept. */
  readonly keptKeys: readonly string[];
  /** Source exists but could not be parsed; the whole category is skipped. */
  readonly sourceError?: string;
  /**
   * Target exists but could not be parsed — merging would risk destroying
   * user data, so this is a category-scoped blocker (surfaced in the preview;
   * apply refuses to touch the file).
   */
  readonly targetError?: string;
}

export interface AgentsMdImportPlan {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly action: 'import' | 'skip';
  readonly skipReason?: KimiImportSkipReason;
}

export interface SkillImportItem {
  readonly name: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly kind: 'bundle' | 'flat';
  readonly action: 'import' | 'skip';
  readonly skipReason?: KimiImportSkipReason;
  readonly detail?: string;
  /** Precomputed first-free `<name>-kimi` target for conflict rename imports. */
  readonly renameName?: string;
  readonly renameTargetPath?: string;
}

export interface SessionImportItem {
  readonly sessionId: string;
  readonly title: string;
  readonly workDir: string;
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly action: 'import' | 'skip';
  readonly skipReason?: KimiImportSkipReason;
  readonly detail?: string;
}

export interface HistoryMergeItem {
  readonly sourcePath: string;
  readonly targetPath: string;
  /** New entry contents to append (already deduped against the target). */
  readonly entriesToAppend: readonly string[];
  readonly action: 'import' | 'skip';
  readonly skipReason?: KimiImportSkipReason;
}

export interface CredentialImportItem {
  readonly fileName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  /** Credentials are never part of the default apply; 'conflict' = target exists. */
  readonly skipReason?: KimiImportSkipReason;
}

export interface KimiImportPlan {
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly config?: KeyMergePlan;
  readonly keybindings?: KeyMergePlan;
  readonly mcp?: KeyMergePlan;
  readonly agentsMd?: AgentsMdImportPlan;
  readonly skills: readonly SkillImportItem[];
  readonly sessions: readonly SessionImportItem[];
  readonly inputHistory: readonly HistoryMergeItem[];
  readonly credentials: readonly CredentialImportItem[];
  /**
   * Category-scoped blockers (unparseable target files). Blocked categories
   * are excluded from apply; the rest may proceed.
   */
  readonly blockers: readonly string[];
}

export interface KimiImportApplyOptions {
  /** Copy OAuth credential files (opt-in; default false). */
  readonly includeCredentials: boolean;
  /** Import conflicting skills under their precomputed `<name>-kimi` rename. */
  readonly renameConflictingSkills: boolean;
}

export interface KimiImportApplyResult {
  /** Category label -> number of imported units (keys, files, sessions...). */
  readonly imported: Readonly<Record<string, number>>;
  /** Category label -> number of skipped units. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
  /**
   * Non-fatal anomalies worth surfacing after apply, e.g. a session whose
   * state.json homedir values pointed outside the copied tree and were left
   * unrewritten.
   */
  readonly notes: readonly SessionApplyNote[];
}

export interface SessionApplyNote {
  readonly sessionId: string;
  readonly unmatchedHomedirs: number;
}
