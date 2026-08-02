# Topic — Persistence & wire records

How business code persists data in `agent-core`: the wire record model, the on-disk layout, replay semantics, and how to add a record type. Read this before adding any durable state.

## The one-sentence rule

> **Use records, not `state.json`, when correctness depends on order.**

Every agent owns an append-only JSONL event log — `wire.jsonl` — that is the source of truth for rebuilding agent state on resume. `state.json` (SessionMeta) is session-level summary metadata; the per-agent wire log is the authoritative history.

## Two record classes

Record types live in `agent/records/types.ts` (`AgentRecordEvents`, a type-keyed map; every record is `{ type, time?, ...payload }`). Two classes:

- **State records** — must have restore semantics: `metadata`, `forked`, `turn.prompt|steer|cancel`, `config.update`, `permission.*`, `plan_mode.*`, `worktree.enter|exit`, `swarm_mode.*`, `coordinator_mode.*`, `tools.*`, `usage.record`, `full_compaction.*`, `graduated_compaction.apply`, `context.*`, `snapshot.track|rewind`, `goal.*`.
- **Observability records** — durable trace only, never feed state rebuild: `llm.request`, `llm.tools_snapshot`, `mcp.tools_discovered`, `guardian.*`, `shell_session.*`, `session.meta`, `usage.rate_limit`. Resume only restores write-dedup cursors from these.

Loop events embedded in `context.append_loop_event` are `LoopRecordedEvent` (`loop/events.ts`: `step.begin`, `content.part`, `tool.call`, `tool.result`, …).

### Our wire-format extensions (vs upstream kimi-code)

Cloud Code's record set is a strict superset of upstream's. These are **ours** — upstream does not have them, and upstream tooling will skip them as unknown records:

`context.withdraw_tail_input` · `coordinator_mode.enter/exit` · `graduated_compaction.apply` · `guardian.assessment/review_failed/circuit_breaker_tripped` · `session.meta` · `shell_session.start/exit` · `snapshot.track/rewind` · `usage.rate_limit` · `worktree.enter/exit`

When porting an upstream change that touches records, check both directions: upstream may have added records we lack, and our extensions must keep replaying correctly.

## On-disk layout

```text
~/.cloud-code/                          ($CLOUD_CODE_HOME override; config/path.ts)
├── config.toml
├── session_index.jsonl                 global append-only session index
└── sessions/<workdirKey>/<sessionId>/  workdirKey = wd_<slug>_<sha256[:12]>
    ├── state.json                      SessionMeta (title, timestamps, workDir, agents map)
    ├── agents/<agentId>/
    │   ├── wire.jsonl                  the authoritative per-agent record log
    │   ├── blobs/<sha256>              content-addressed media offload (blobref)
    │   └── tool-results/               persisted oversized tool outputs
    ├── tasks/<taskId>.json + <taskId>/output.log   background-task persistence
    └── teams/<team>.json, teams/<team>/inboxes/<member>.json
```

- **Blob offload**: data-URI media parts >4 KiB in prompt/message/loop-event records are offloaded to `blobs/<sha256>` and replaced with `blobref:<mime>;<hash>` URLs (`agent/records/blobref.ts`); rehydrated on replay, degraded to `[media missing]` if gone. Hash and mime are strictly validated (path-traversal safe).
- **Write mechanics** (`agent/records/persistence.ts`): `FileSystemAgentRecordPersistence` batches pending records and appends with `fh.sync()` + one-time directory fsync; it tolerates a truncated **final** line (crash mid-flush) and errors on mid-file corruption. `InMemoryAgentRecordPersistence` backs ephemeral/test agents (`AgentOptions.persistence`).
- **Durability primitives** (`utils/fs.ts`): `writeFileAtomicDurable` (tmp + fsync + rename + dir fsync) for documents; `atomicWrite` for rename-based replacement — explicitly **not** for the append-only `wire.jsonl`.
- **Session metadata**: `state.json` writes go through the kaos filesystem abstraction with serialized queueing; `absorbExternalMetadata` merges external renames field-by-field (never regressing timestamps) so two open instances cannot clobber each other.
- **Lite reader**: `session/store/wire-lite.ts` reads only the first/last 64 KiB of a wire log for session listing (title/lastPrompt fallbacks); `session.meta` records are periodically re-appended to the wire tail so wire-only exports stay self-describing. `state.json` remains authoritative.

## Replay on resume

`AgentRecords` (`agent/records/index.ts`):

- The first record must be `metadata { protocol_version }` (currently `1.4`). Older versions run chained migrations (`records/migration/v1.1.ts` … `v1.4.ts`) and the log is **rewritten in place**; a newer version logs a warning and replays without migration.
- `restoreAgentRecord` is a giant switch with a strict contract: **rebuild in-memory state only** — no UI events, no LLM calls, no fs side effects. Restore replays through the *same mutator* that logged the record (`context.apply_compaction` → `ContextMemory.applyCompaction`), so live and resumed paths share one code path.
- `ReplayBuilder` (`agent/replay/`) captures UI-facing replay records during restore for the resumed-transcript view.
- Resume healing fixes interrupted logs: orphaned parallel tool results are closed at step boundaries or tail-closed by `finishResume`; late real results are re-hung in place (`recoverLateToolResult`); repairs are counted in `ContextMemory.resumeRepairs`, and unrepaired drift raises a warn-only `resume-consistency-drift` audit — it never blocks resume.

## Which store — decision tree

```text
Must survive resume / be replayed / be projected into a transcript?
  ├─ yes, and order matters        → wire record (this file)
  ├─ session summary metadata      → state.json via Session.writeMetadata
  ├─ shared mutable JSON state     → atomic JSON store (teams / mailbox pattern:
  │                                  per-key atomic write + in-process promise queue)
  ├─ large/media bytes             → blob store (content-addressed) or tool-results/
  ├─ user/operator preference      → config.toml (config.md) — never a record
  └─ ephemeral handles             → runtime memory only
```

## Add a record type (recipe)

1. Add the key and payload type to `AgentRecordEvents` in `agent/records/types.ts`.
2. Add a `case` in `restoreAgentRecord` (`agent/records/index.ts`) that restores **through the live mutator** — or an explicit no-op for observability records.
3. Do **not** bump `AGENT_WIRE_PROTOCOL_VERSION` unless existing records change meaning (policy in `records/migration/`). If they do, add a chained `vX.Y.ts` migration and bump.
4. Append records only through the owning domain's mutator — never hand-append to the log.
5. Cover both paths with tests: live append + kill/resume replay producing identical state.

## Red lines (this topic)

- Records are the order-sensitive source of truth; `state.json` is summary metadata — never invert that.
- A state record without a restore case is a resume bug; an observability record with restore side effects is a replay bug.
- Restore replays through the same mutator that logged; restore must not fire UI events, call the LLM, or touch the fs.
- Version bumps only when existing records change meaning; new additive record types need no migration.
- Business code never writes `wire.jsonl` directly — append through the owning mutator.
- Our wire extensions are a superset of upstream's: keep them replayable, and never strip them when porting upstream record code.
