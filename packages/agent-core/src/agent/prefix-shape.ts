/**
 * Prefix-drift diagnostics (F7): a compact per-request fingerprint of the
 * inputs that determine the prompt-cache prefix, plus a comparator that
 * attributes a drift to the dimension that changed.
 *
 * The heavy hashes (`systemPromptHash`, `toolsHash`) are already computed per
 * request by `LlmRequestRecorder`; this module only adds adjacent-request
 * comparison and attribution. The history body is deliberately NOT hashed
 * (per-request full-history hashing is too expensive) — `historyLength` plus
 * the structured dimensions are enough to attribute a drift.
 *
 * INVARIANT — dynamic tool/skill sets never move the prefix:
 *   The top-level `tools[]` (hence `toolsHash`) and the system prompt (hence
 *   `systemHash`) must stay byte-stable while the session's *dynamic* tool
 *   surface evolves:
 *     - select_tools progressive disclosure keeps deferred MCP tools out of
 *       the top-level `tools[]`; loading one appends a schema-carrying
 *       message at the history tail and loaded tools rejoin the request only
 *       as `deferred` extras stripped by kosong before hashing/sending;
 *     - MCP servers connecting/disconnecting mid-session change the
 *       `<tools_added>/<tools_removed>` announcements (tail), not `tools[]`;
 *     - MCP tools declaring `_meta['anthropic/alwaysLoad']` are the explicit
 *       exception: they are top-level from the moment the server registers,
 *       so a same-session connect still moves `toolsHash` once for them —
 *       connect-time, not load-time;
 *     - `paths`-gated skills activate mid-session via `<skills_activated>`
 *       tail announcements and stay out of `getModelSkillListing()` forever,
 *       so activation never rewrites the system prompt.
 *   A `tools`/`system` drift reason on an adjacent-request pair that only
 *   loaded a deferred tool or activated a skill is therefore a regression,
 *   not a flaky diagnostic. Covered by test/agent/tool-select.e2e.test.ts
 *   ("dynamic tool-set changes never drift the prefix").
 */

/**
 * Monotonic version of the graduated-compaction projection rewrite: the armed
 * cutoffs and the number of mid-history tool results they replaced. Any
 * change means the projected prefix bytes changed without the system prompt
 * or tools moving — Cloud Code's highest-frequency mid-history drift source,
 * and the reason this dimension exists (the reasonix equivalent is
 * `LogRewriteVersion`).
 */
export interface GraduatedProjectionVersion {
  readonly budgetCutoff: number;
  readonly clearCutoff: number;
  readonly drainCutoff: number;
  readonly replacedCount: number;
}

export interface PrefixShape {
  readonly systemHash: string;
  readonly toolsHash: string;
  /**
   * The projection the messages were built with: `normal`, or a fallback
   * resend (`strict` / `media-degraded` / `media-stripped`). Projection
   * switches rewrite the wire bytes themselves, so they are a drift
   * dimension of their own.
   */
  readonly projection: string;
  readonly graduatedVersion: GraduatedProjectionVersion;
  readonly historyLength: number;
}

export type PrefixDriftReason = 'system' | 'tools' | 'projection' | 'graduated_rewrite';

export interface CaptureShapeInput {
  readonly systemHash: string;
  readonly toolsHash: string;
  readonly projection: string | undefined;
  readonly graduatedVersion: GraduatedProjectionVersion;
  readonly historyLength: number;
}

export function captureShape(input: CaptureShapeInput): PrefixShape {
  return {
    systemHash: input.systemHash,
    toolsHash: input.toolsHash,
    projection: input.projection ?? 'normal',
    graduatedVersion: input.graduatedVersion,
    historyLength: input.historyLength,
  };
}

/**
 * Attribute the drift between two adjacent requests. Empty when nothing
 * prefix-relevant moved — including when `previous` is absent (no baseline,
 * e.g. the first request after resume).
 */
export function compareShape(
  previous: PrefixShape | undefined,
  current: PrefixShape,
): PrefixDriftReason[] {
  if (previous === undefined) return [];
  const reasons: PrefixDriftReason[] = [];
  if (previous.systemHash !== current.systemHash) reasons.push('system');
  if (previous.toolsHash !== current.toolsHash) reasons.push('tools');
  if (previous.projection !== current.projection) reasons.push('projection');
  if (!graduatedVersionEquals(previous.graduatedVersion, current.graduatedVersion)) {
    reasons.push('graduated_rewrite');
  }
  return reasons;
}

function graduatedVersionEquals(
  a: GraduatedProjectionVersion,
  b: GraduatedProjectionVersion,
): boolean {
  return (
    a.budgetCutoff === b.budgetCutoff &&
    a.clearCutoff === b.clearCutoff &&
    a.drainCutoff === b.drainCutoff &&
    a.replacedCount === b.replacedCount
  );
}
