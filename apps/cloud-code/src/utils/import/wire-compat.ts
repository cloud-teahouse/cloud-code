/**
 * Wire-format compatibility checks for imported sessions.
 *
 * Cloud Code and upstream Kimi Code 0.29.1 share wire protocol version '1.4'
 * and Cloud Code's record-type set is a strict superset of upstream's, so any
 * upstream 0.29.1 wire file replays cleanly. Anything newer or unknown is
 * refused conservatively: the session is skipped and reported instead of
 * importing a file that might replay incorrectly.
 *
 * The type list mirrors `AgentRecordEvents` in
 * `packages/agent-core/src/agent/records/types.ts` and the version mirrors
 * `AGENT_WIRE_PROTOCOL_VERSION` in
 * `packages/agent-core/src/agent/records/migration/index.ts`.
 */

export const SUPPORTED_WIRE_PROTOCOL_VERSION = '1.4';

/**
 * All record types this build understands: the 46 current `AgentRecordEvents`
 * keys plus the v1.3 legacy `goal.account_usage` / `goal.continuation`, which
 * no longer exist in the current schema but are absorbed into `goal.update`
 * by the 1.3→1.4 wire migration (records/migration/v1.4.ts). A ≤1.3 wire
 * from a goal-mode session is legal and must not be refused as unknown.
 */
const KNOWN_WIRE_RECORD_TYPES: ReadonlySet<string> = new Set([
  'metadata',
  'forked',
  'turn.prompt',
  'turn.steer',
  'turn.cancel',
  'config.update',
  'permission.set_mode',
  'permission.record_approval_result',
  'full_compaction.begin',
  'full_compaction.cancel',
  'full_compaction.complete',
  'micro_compaction.apply',
  'graduated_compaction.apply',
  'plan_mode.enter',
  'plan_mode.cancel',
  'plan_mode.exit',
  'swarm_mode.enter',
  'swarm_mode.exit',
  'coordinator_mode.enter',
  'coordinator_mode.exit',
  'tools.register_user_tool',
  'tools.unregister_user_tool',
  'tools.set_active_tools',
  'tools.update_store',
  'usage.record',
  'usage.rate_limit',
  'context.append_message',
  'context.append_loop_event',
  'context.update_token_count',
  'context.clear',
  'context.apply_compaction',
  'context.undo',
  'snapshot.track',
  'snapshot.rewind',
  'goal.create',
  'goal.update',
  'goal.clear',
  // v1.3 legacy, folded into goal.update by the 1.3→1.4 migration on replay.
  'goal.account_usage',
  'goal.continuation',
  'llm.tools_snapshot',
  'llm.request',
  'mcp.tools_discovered',
  'guardian.assessment',
  'guardian.review_failed',
  'guardian.circuit_breaker_tripped',
  'shell_session.start',
  'shell_session.exit',
  'session.meta',
]);

export type WireCompatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'incompatible' | 'invalid'; readonly detail: string };

/**
 * Compare dotted numeric versions. Returns a negative number when a < b,
 * zero when equal, positive when a > b. Non-numeric input yields NaN.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (Number.isNaN(diff)) return Number.NaN;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Validate one wire.jsonl payload (full file text). Mirrors the reader's
 * tolerance: a truncated final line is ignored, a corrupt mid-file line is
 * fatal, and the first record must be `metadata` carrying a
 * `protocol_version` not newer than the supported one.
 */
export function checkWireCompatibility(wireText: string): WireCompatibility {
  const lines = wireText.split('\n');
  let sawMetadata = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Tolerate a truncated final line exactly like FileSystemAgentRecordPersistence.
      if (!lines.slice(i + 1).some((rest) => rest.trim().length > 0)) break;
      return { ok: false, reason: 'invalid', detail: `corrupted line ${i + 1}` };
    }
    if (typeof record !== 'object' || record === null) {
      return { ok: false, reason: 'invalid', detail: `non-object record on line ${i + 1}` };
    }
    const type = (record as { type?: unknown }).type;
    if (typeof type !== 'string') {
      return { ok: false, reason: 'invalid', detail: `missing record type on line ${i + 1}` };
    }
    if (!sawMetadata) {
      if (type !== 'metadata') {
        return { ok: false, reason: 'invalid', detail: 'first record is not metadata' };
      }
      const version = (record as { protocol_version?: unknown }).protocol_version;
      if (typeof version !== 'string') {
        return { ok: false, reason: 'invalid', detail: 'metadata lacks protocol_version' };
      }
      const cmp = compareVersions(version, SUPPORTED_WIRE_PROTOCOL_VERSION);
      if (Number.isNaN(cmp)) {
        return { ok: false, reason: 'invalid', detail: `unparseable protocol_version ${version}` };
      }
      if (cmp > 0) {
        return {
          ok: false,
          reason: 'incompatible',
          detail: `wire protocol ${version} is newer than supported ${SUPPORTED_WIRE_PROTOCOL_VERSION}`,
        };
      }
      sawMetadata = true;
      continue;
    }
    if (!KNOWN_WIRE_RECORD_TYPES.has(type)) {
      return { ok: false, reason: 'incompatible', detail: `unknown wire record type "${type}"` };
    }
  }
  if (!sawMetadata) {
    return { ok: false, reason: 'invalid', detail: 'no metadata record' };
  }
  return { ok: true };
}
