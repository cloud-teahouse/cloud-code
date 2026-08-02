# Topic — Domain boundaries

How to keep `Session` / `Agent` from becoming god objects. Read this before adding a field to either class, creating a new subsystem, or deciding whether data belongs to the session, the agent, or the turn.

## The one-sentence rule

> **A class is a lifetime boundary; a domain is a responsibility and data-ownership boundary.**

`Session` and `Agent` are the two runtime lifetimes (orient.md). Owning *lifetime* does not make a class the owner of every piece of data that lives that long. Domain says which responsibility owns the data and is allowed to mutate it.

## The data-ownership test

Do not ask "does the session / agent / turn *use* this data?" — most data is used by several of them. Ask instead:

1. **What is the data's identity?** `sessionId`, `agentId`, `turnId`, `taskId`, `teamName`, or something else?
2. **Who is the only writer?** The writer is usually the owner. Readers and projectors are not owners.
3. **Who enforces the invariants?** The component that decides valid transitions owns the model.
4. **What is the authoritative source?** A wire record, `state.json`, a JSON store under the session dir, config, or runtime memory?
5. **Can it be named without `Session` / `Agent` / `Turn`?** If yes, it probably deserves its own component.

Examples in this repo:

- Permission rules are agent-scoped, but `agent/permission/` owns rule evaluation and the session-grant memory.
- Background tasks are spawned by an agent, but `agent/background/` (`BackgroundManager`) owns task state, output rings, and reconciliation.
- Team/mailbox state is used by agents, but `agent/swarm/team-store.ts` / `mailbox.ts` own the JSON stores — `Session` merely holds the instances.
- Context messages are consumed by the loop, but `agent/context/` (`ContextMemory`) owns history and projection; `agent/records/` owns the durable log.

## Split conclusion — `Session`

`Session` owns session-level identity, lifecycle, and shared resources — keep it narrow:

| Concern | Owner | Notes |
|---|---|---|
| `sessionId`, workDir, `state.json` (SessionMeta) | `Session` / `session/store/` | `writeMetadata` serialized; `absorbExternalMetadata` merges external renames |
| Agent instances | `Session.agents` map + `session/subagent-host.ts` | spawn/resume/retry lifecycle |
| MCP connections | `Session` MCP connection manager | reconnect/auth-cache in `mcp/` |
| Hook engine | `session/hooks/` | `PreToolUse` / `PostToolUse` / lifecycle events |
| Team + mailbox stores | `agent/swarm/team-store.ts`, `mailbox.ts` | instances held on `Session`; logic in swarm |
| Session listing / fork / archive | `session/store/session-store.ts` | CRUD over `~/.cloud-code/sessions/` |

`Session` must not reabsorb: turns (`loop/`), context (`agent/context/`), permission state (`agent/permission/`), compaction (`agent/compaction/`), background task internals (`agent/background/`), goal/plan state (agent-level records).

## Split conclusion — `Agent`

`Agent` owns one agent's runtime: its records, context, permission chain, mode objects (`SwarmMode`, `CoordinatorMode`), background tasks, and tool assembly. It is already wide — treat every new field as a guilty party until proven innocent:

- If the state has its own identity (task id, team name, cron id), it belongs in a dedicated manager *held by* the agent, not in loose agent fields.
- If the behavior is a turn-scoped computation, it belongs in the stateless `loop/` or a pure helper, not on `Agent`.
- If the data is durable, the owner is the records subsystem; `Agent` only appends through mutators.

## Split conclusion — `turn`

A turn is a function-call scope inside `loop/run-turn.ts` — there is **no** `Turn` class with its own lifetime. Turn-scoped state (step counters, streaming runner state, abort signal) lives in locals and parameters. Do not create a turn object that accumulates responsibilities; when turn logic needs to persist something, it appends `turn.*` / `context.*` records through the agent's mutators.

## Persistence models are not all the same

Before adding state, classify the persistence model (details in [persistence.md](persistence.md)):

| Model | Use when | Examples |
|---|---|---|
| **Wire record (append-log)** | "what happened" is authoritative; must survive resume | `turn.prompt`, `config.update`, `swarm_mode.enter`, `graduated_compaction.apply` |
| **Atomic document** | one typed document per key | `state.json` (SessionMeta), background-task `*.json` |
| **JSON store** | shared mutable state with atomic per-key writes | `teams/<team>.json`, mailbox inboxes |
| **Blob (content-addressed)** | large/media bytes | `blobs/<sha256>`, `tool-results/` |
| **Config** | user/operator preference | `~/.cloud-code/config.toml` |
| **Runtime memory** | ephemeral handles | pending approvals, abort controllers, timers |

## Migration recipe

When moving data out of a god object or reviewing a proposed new field:

1. **Name the data without `Session`, `Agent`, or `Turn`.** If you cannot, the domain is probably unclear.
2. **Find the writer.** The exclusive writer is the likely owner.
3. **Find the invariant.** The component that rejects invalid transitions owns the model.
4. **Classify the persistence model** (table above).
5. **Pick the shape:** dedicated manager held by the lifetime owner; pure function for stateless behavior; wire record for durable facts.
6. **Check dependency direction** (design.md §4): foundational components must not learn about this new upstream state.

## Red lines (this topic)

- Ownership follows write authority and invariants, not read consumption.
- No new god-object fields on `Session` / `Agent`: state with its own identity gets a dedicated manager.
- `Session` holds instances; it does not absorb the logic of the things it holds.
- No `Turn` class — turn state lives in the loop's call scope.
- Durable state goes through the records mutators; never hand-append to `wire.jsonl`.
- A dependency is not ownership: a component may reference another domain without owning that domain's data.
