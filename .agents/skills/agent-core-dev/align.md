# Subskill — Upstream align (port `kimi-code` → Cloud Code)

Port business logic from upstream `kimi-code` (the `upstream` git remote, `upstream/main`) into this fork by **splitting semantics, mapping each unit to our architecture, and re-wiring dependencies** — then migrating logic and tests, applying the brand contract and our subsystem divergences.

Use this when the task is "port upstream feature X", "align our fork with upstream's Y", or "bring `<upstream commit range>` into Cloud Code". It complements the stage files: orient / design / implement / test explain the *target* architecture; this file explains how to get there *from upstream*.

## The one-paragraph mental model

Both repos share the v1 skeleton (VSCode-style DI services, plain `Session`/`Agent`, stateless loop), but the fork has **diverged**: graduated compaction replaced `micro.ts`; guardian review, teammate/coordinator runtime, sandboxed kaos, shadow-git snapshots, wire-format extensions, a rewritten TUI, full i18n, and a deleted telemetry package are all ours. Porting is therefore **not** a file copy — it is "understand what the upstream change does, find where each piece belongs in our architecture, re-express it under our constraints, and strip what we deliberately removed".

## Divergence map (check first)

Before porting anything, know which subsystems are ours and no longer match upstream:

| Area | Upstream | Ours |
|---|---|---|
| Compaction | `micro.ts` single layer | `agent/compaction/graduated.ts` three layers (compaction.md) |
| Telemetry | full package + `ITelemetryService` | **deleted** — strip on port (telemetry.md) |
| Multi-agent | AgentSwarm basics | + teammates, teams, mailbox, coordinator mode (permission.md topology denies) |
| Approval | mode cascade | + guardian review (auto mode), sandbox escalation, approve-always persistence |
| Bash permission | whole-string matching | tree-sitter AST per-segment (`tools/support/shell-ast/`) |
| Wire records | base set | strict superset (persistence.md) |
| Execution env | kaos | + bubblewrap sandbox (`kaos/src/sandbox/`) |
| TUI | upstream TUI basics | fullscreen slot layout, hit zones, DialogFrame, i18n (tui.md) |
| Snapshots | — | shadow-git snapshot + `/rewind` |
| Brand | Kimi Code | Cloud Code + Moonshot service contract (brand.md) |

## The align workflow

```text
Read upstream → Semantic split → Map to our packages/domains → Re-wire dependencies
→ Port logic (strip telemetry, apply brand) → Port tests → Verify
```

### 1. Read upstream

Build an accurate inventory of what the upstream change actually owns. Read the upstream *source* (via the local git objects: `git show upstream/main:<path>`, or fetch the PR diff), not its docs.

- Inventory three things: **state** (every field/Map and its identity — global? per session? per agent?), **behavior** (public methods grouped by the state they touch), **dependencies** (every injection and cross-domain import).
- Note registration and bootstrap wiring (`registerSingleton`, `services.set(...)` overrides).
- Flag anything touching a diverged subsystem (table above) — those pieces need a decision, not a copy.

### 2. Semantic split

Break the upstream change into independent semantic units, each owning state at exactly one identity/lifetime (design.md §1). An upstream class often becomes several homes here: runtime state on `Session`/`Agent`/loop locals, durable facts as wire records, preferences in the config schema, facade methods in `services/`.

- If two pieces of state have different identities, they get different homes — do not keep them together "because upstream did".
- Do not split by method count or file aesthetics; split by state identity.

### 3. Map to our packages/domains

Assign each unit to an existing domain first — search `packages/agent-core/src/` for the current owner (our tree is the source of truth, not this table):

| Upstream location | Likely home here |
|---|---|
| `services/session/`, `session/` | `session/`, `session/store/`, `session/subagent-host.ts` |
| `services/tool/`, `tools/`, `agent/tool/` | `tools/builtin/`, `agent/tool/` |
| `loop/`, `agent/` (turn loop) | `loop/`, `agent/turn/` |
| `agent/context/`, `agent/compaction/` | `agent/context/`, `agent/compaction/` (graduated — do not port `micro.ts` logic verbatim) |
| `agent/permission/` | `agent/permission/` (+ guardian, topology denies — recheck chain placement) |
| `agent/goal|plan|swarm|cron|background/` | same names + `agent/swarm/` teammate runtime, `agent/coordinator/` |
| `services/config/`, `agent/config/` | `config/` (central schema — no section registry here) |
| `services/event/`, `base/common/event` | `base/common/event`, `services/event/` |
| `flags/` | `flags/` (central `FLAG_DEFINITIONS` — upstream's decentralized registry does not apply) |
| `errors/` | `errors/` (central `ErrorCodes` + `CLOUD_CODE_ERROR_INFO`) |
| `telemetry.ts`, telemetry anything | **drop** (telemetry.md) |
| `rpc/`, `services/coreProcess/` | `rpc/`, `services/coreProcess/` |
| TUI (`apps/kimi-code`) | `apps/cloud-code` (adapted to our TUI contracts — tui.md) |

Where the table says nothing or the trees have drifted, read our `src/` and decide from the code.

### 4. Re-wire dependencies

Follow design.md §3–§4 under our constraints:

- **Calling style** — need a result / I orchestrate → direct call; stating a fact → event (`Emitter<T>`); may veto/rewrite → hook; durable → wire record.
- **Direction** — `loop/` stays stateless; runtime never imports `services/`; tools touch the world via `kaos`; `apps/cloud-code` consumes SDK only. A cycle means an upstream import now points backwards.
- **Durable facts** — state changes that must be recorded/replayed go on the wire; check whether upstream added record types and whether our superset needs the same restore cases.

### 5. Port the business logic

Apply the mechanical conversions:

- **Strip telemetry** — delete every telemetry call with its import; simplify behavior that branched on telemetry flags (telemetry.md).
- **Brand** — rebrand B-class user-visible strings to Cloud Code; preserve every A-class Moonshot service-contract identifier exactly (brand.md). Classify before editing.
- **Errors** — central registry: add codes to `ErrorCodes` + `CLOUD_CODE_ERROR_INFO`; do not port per-domain error registries.
- **Flags** — central `FLAG_DEFINITIONS`; env names become `CLOUD_CODE_EXPERIMENTAL_*`.
- **Config** — central `config/schema.ts` (+ matching patch schema); snake_case mapping is automatic.
- **i18n** — new TUI strings go through `t()` in both locales (tui.md); upstream hardcoded strings are not exempt.
- **Records** — additive record types need no protocol bump; changed record meaning needs a migration (persistence.md).
- **Prompts/markdown** — `.md` assets load via `?raw`; rebrand their user-visible content too.

Red lines:

- Do not copy an upstream file and "fix imports". Re-split first (steps 2–4); a straight copy carries upstream's assumptions (telemetry, single-layer compaction, kimi branding, centralized env reads) into the fork.
- Do not preserve an upstream behavior just because it exists; if our architecture made it unnecessary (e.g. a lock our ordering already guarantees), drop it — and say so in the porting note.

### 6. Port the tests

- DI services resolve the SUT by interface (`ix.get(IX)` via `createServices`); plain runtime classes are constructed directly with the external boundary stubbed (test.md).
- Keep upstream's behavioral assertions where they still describe observable behavior; delete assertions that only checked upstream's internal shape.
- Add coverage for our extensions the port interacts with (chain placement, compaction layers, replay parity).

## Migration checklist

- [ ] Every piece of upstream state landed with the owner whose lifetime matches (design.md §1).
- [ ] Dependencies point the right way; `pnpm lint` shows no new cycle/error.
- [ ] Telemetry stripped; brand classified (A kept / B rebranded / C untouched); no user-visible "Kimi Code".
- [ ] Errors/flags/config use our central registries; env family rules hold.
- [ ] New record types have restore cases and replay-parity tests.
- [ ] Diverged subsystems re-expressed, not copied (compaction, permission chain, swarm, TUI).
- [ ] `pnpm build && pnpm test && pnpm lint` green.

## Red lines (this subskill)

- Porting is semantic mapping, not file copying — never preserve an upstream shape our architecture replaced.
- The divergence map is a checklist, not gospel: our `src/` tree is the source of truth.
- Telemetry never comes back, in any form.
- The Moonshot service contract survives every port byte-for-byte.
- A port that leaves `pnpm lint` with a new error or cycle is not done.
