# Stage 2 — Design

Decide *where things live and who knows whom* before writing code. Our engine has no scope tree — placement is decided by three questions:

1. **What is the identity of the state it owns?** → decides the **owner** (process / session / agent / turn / none).
2. **Must the state survive resume?** → decides **wire record vs runtime memory vs config** (see persistence.md).
3. **Who owns the decision, and who needs the result?** → decides the **calling style** and **dependency direction**.

## 1. Pick the owner

State has an **identity** (what it is keyed by) and a **lifetime** (when it is born, when it dies). The owner is the class whose lifetime matches:

| State identity | Owner | Examples |
|---|---|---|
| process-global | `CloudCodeCore` (`rpc/core-impl.ts`) or an App-singleton DI service | `FlagResolver`, config, session registry |
| per-session | `Session` fields (`session/index.ts`) | `agents` map, MCP connection manager, hook engine, `TeamStore`, `MailboxService` |
| per-agent | `Agent` fields (`agent/agent.ts`) | permission manager, `SwarmMode`, `CoordinatorMode`, `BackgroundManager`, `AgentRecords`, `ContextMemory` |
| one turn | locals/parameters inside `loop/run-turn.ts` — the loop is stateless | step state, streaming tool-call runner state |
| none (pure behavior) | a pure function or a stateless utility | `matches-rule.ts`, projection helpers |

Rules:

- **State pins the owner; behavior is free.** The same logic can run anywhere — what decides placement is whose state it mutates.
- **Per-agent state does not leak into `Session` or `CloudCodeCore` as `Map<agentId, …>`** unless the owner genuinely manages *all* agents (the session's `agents` registry is the legitimate example). A manager map whose entries mirror one agent's lifetime is a smell: the state wants to live on `Agent`.
- One-sentence self-check: *"When this session/agent ends, should this state disappear with it?"* If it must outlive the owner, move it up; if it should be one-per-unit but is shared, move it down.
- The DI service layer (`services/`) is the **upper facade** for the server/SDK surface — business runtime state does not move there just because a consumer wants an injectable handle.

## 2. Durable vs runtime — the wire-record test

Before adding a field, ask: **must this survive resume / be replayed / be projected into a transcript?**

- Yes → it is a **wire record** appended to the agent's `wire.jsonl` through the same mutator that restores it. Mode changes (`swarm_mode.enter`, `coordinator_mode.enter`, `plan_mode.enter`), config updates, compaction applications, permission decisions — all are records. See [persistence.md](persistence.md).
- No (ephemeral handles, pending interactions, abort controllers, timers) → runtime memory on the owner.
- User/operator preference → config (`config.toml`), never a wire record. Runtime service state (switching model mid-session) is session runtime state recorded on the wire — it must **not** rewrite `config.toml`. See [config.md](config.md).

The litmus test: kill the process mid-turn and resume. Anything the resumed agent needs must have come back from `wire.jsonl` replay or `state.json` — if you held it only in memory, it is gone.

## 3. Choose a calling style

Three mechanisms answer three different questions:

| Mechanism | Nature | Coupling | Returns a value? | Consumers |
|---|---|---|---|---|
| **Direct call** | command: A tells B to do | A → B | yes | one (known) |
| **Event** (`Emitter<T>` / `Event<T>` from `base/common/event`) | fact: A announces "X happened" | both depend only on the event type | no | zero / one / many (unknown) |
| **Hook** (session hook engine, `onBeforeExecuteTool`-style participation) | observers step into an operation | both depend only on the hook contract | can observe / veto / rewrite | many |

Decision tree:

1. **Does A need a return value from B?** → direct call. Events cannot return values (request/reply over events is an anti-pattern).
2. **Is B's reaction part of A's responsibility (A orchestrates B)?** → direct call. Example: the turn drives the permission check and the tool executor.
3. **Is B's reaction B's own concern, A merely stating a fact?** → event. Example: UI-facing lifecycle emissions (`subagent.spawned/.completed`, `background.task.terminated`) are RPC events so any host can react.
4. **May observers veto or rewrite the operation (permission, input rewriting, blocking context injection)?** → hook.
5. **Is this fact part of the durable record / replay?** → then it is **also a wire record** (§2). The wire is the durable record; events are the live notification channel; do not substitute one for the other.

## 4. Dependency direction

Two mechanical guards plus judgment:

- **`import/no-cycle` is an oxlint error.** A cycle means knowledge was placed backwards: extract a third module, or invert the "notification" half into an event.
- **The documented boundaries** (orient.md): `apps/cloud-code` → SDK only; `loop/` imports no host implementation; `services/` may import the runtime, the runtime never imports `services/`; tools touch the world through `kaos` only.

On top of those, the anti-rot heuristic:

> **Do not let a more foundational / more-reused component come to know a more specific / more-upstream one.**

`kosong` never knows about sessions; `loop/` never knows about `Agent`; `Agent` never knows about the TUI; business code never knows JSON-RPC envelopes exist. Once a foundational component learns an upstream scenario, it can no longer be reused by other scenarios — and it almost always creates a cycle.

## 5. Extension points (open-closed)

When adding a scenario would otherwise require editing this domain's `if/else`, expose the right extension point instead:

| Need | Extension point | Home |
|---|---|---|
| Register a new tool | builtin tool registration (DI-injected deps) | `agent/tool/` |
| New permission rule specifics | the **data path** — `PermissionRule` in config | `agent/permission/` |
| New permission *dimension* (behavior) | a `PermissionPolicy` in the ordered chain | `agent/permission/policies/` |
| New record type | `AgentRecordEvents` + restore case | `agent/records/` |
| New config key | a zod section in the central schema | `config/schema.ts` |
| New experimental behavior | a `FLAG_DEFINITIONS` entry | `flags/registry.ts` |
| New slash command | command declaration + palette metadata | `apps/cloud-code/src/tui/commands/` |
| New wire/RPC capability | `CoreAPI` method → node-sdk → server bridge | `rpc/`, see edge-exposure.md |

Closed-for-modification means: the domain's own file is not where new scenarios branch. If a new scenario forces an edit there, an extension point is missing or misplaced.

## 6. New-capability checklist

1. **What does it remember, and what is the state's identity?** → pick the owner (§1).
2. **Must it survive resume?** → wire record + restore case, or runtime memory (§2).
3. **For each collaborator: am I commanding it, notifying it, or letting it participate?** → calling style (§3).
4. **Does each dependency arrow make a foundational thing know a specific thing?** → invert it (§4).
5. **Which extension point does it plug into?** → if none fits, you are probably adding one (§5).
6. **Is any part of it unreleased?** → gate behind a flag (flags.md).
7. **Does it touch a diverged subsystem?** → read its topic file first: compaction.md, permission.md, persistence.md, tui.md.

## Red lines (this stage)

- Owner follows state identity; no `Map<agentId, …>` parked on a longer-lived class to fake per-agent state.
- Durable facts are wire records written through the mutator that restores them; runtime-only state never becomes a record.
- Need a result / I orchestrate → direct call; stating a fact → event; may veto/rewrite → hook; durable → also a wire record.
- Foundational layers never know upstream ones; `loop/` never imports the host; the runtime never imports `services/`; business code never speaks JSON-RPC.
- Tool-result visible order strictly equals provider order — design concurrency around *start*, never around *visibility*.
- A cycle means knowledge is placed backwards — refactor, do not route around it.
