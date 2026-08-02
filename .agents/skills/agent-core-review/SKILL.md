---
name: agent-core-review
description: Use for code review and test write/review guidance in packages/agent-core (the Cloud Code agent engine) and its apps/cloud-code TUI surface. Bundles the review checklist for our subsystems (permission chain, compaction, wire records, swarm/coordinator/teammates, config, DI services, boundaries, TUI, brand) with two lenses — `slop` (single-level-of-abstraction / layered error-handling review, invoked only on explicit request) and `test` (contract-driven per-test rules for both authoring and reviewing tests). Apply the subsystem checklist to any agent-core diff; apply the sub-skill that matches the task; do not apply `slop` unprompted.
has-sub-skill: true
---

# agent-core-review

> Review lens bundle for `packages/agent-core` and `apps/cloud-code`. Calibrated for this fork's architecture — where a rule comes from a diverged subsystem, it says so.

Two parts: a **subsystem checklist** to run against any diff in the engine or TUI, and two self-contained **sub-skills** for specific tasks.

## Sub-skills

- **`slop/`** — Single Level of Abstraction & layered error handling. A *review dimension*: a function should read as a straight-line description of its own layer, with errors handled above or below. The agent reports detections and measurements, not severity grades. **Invoke only when the user explicitly asks for this lens** — do not apply it unprompted to general reviews or refactors.
- **`test/`** — Per-test rules behind "test the contract / responsibility, not the implementation," serving two modes. **Write mode:** author a test — one behavior per `it`, drive through the public surface, stub only the true external boundary, control time/config via documented knobs, keep tests clear, isolated, and refactor-resilient (CCCR). **Review mode:** audit existing tests against the same rules and report findings with `file:line`. Use when writing, modifying, or reviewing tests, or when asked how to write a good single test.

## Routing

- Reviewing any agent-core / TUI diff → the subsystem checklist below.
- Reviewing code structure / abstraction layers / where error handling belongs → `slop` (only on explicit request).
- Writing or modifying tests, reviewing test quality, or advising on a single test → `test`.

## Subsystem review checklist

Run the sections that the diff touches. Cite `file:line` for every finding.

### Boundaries and structure (always)

- `apps/cloud-code` imports `@cloud-code/sdk` only — no `agent-core` internals, no protocol-private paths.
- `loop/` stays stateless: no imports of host implementations (`session/`, `agent/`, `rpc/`).
- Tools touch the world through `kaos` only — no `node:fs` / `node:child_process` in tool code.
- `services/` imports runtime submodules directly (never the barrel); the runtime never imports `services/`.
- No new import cycle (`import/no-cycle` is a lint error); foundational code did not learn about an upstream consumer.
- 800-line soft cap respected; new comments state a non-obvious *why* in one line (no diff narration, no type restating, no `file:line` pointers).
- DI services follow the convention: `IXxxService` + `_serviceBrand` + `createDecorator` + `XxxService` + bottom-of-file `registerSingleton` + barrel re-export; `Service` suffix only; consumers resolve by interface, never `new`.

### Permission chain (`agent/permission/**`)

- A new policy sits at a deliberate precedence: first hit wins, and ordering is the safety model. Structural/harness denies belong above `SessionApprovalHistory`; user specifics belong in the data path (`permission.rules`), not a new policy.
- `ask` flows only through `requestToolApproval` (or the sandbox-escalation channel); no synthesized approvals; teammate asks route through the leader bridge.
- Topology denies (swarm exclusivity, coordinator-worker, teammate-spawn, worktree-teammate) remain hard denies nothing can unlock.
- Bash rule matching keeps AST per-segment semantics: deny/ask on any segment triggers, allow requires full coverage.

### Compaction and context (`agent/compaction/**`, `agent/context/**`)

- Layer thresholds, counters, and failure isolation stay independent; projection rewrites never mutate stored history.
- The effective count stays one number shared by trigger and `agent.status.updated` — no double-deduction of rewrite savings.
- Every applied rewrite/compaction is a wire record; resume reproduces it exactly.

### Wire records and persistence (`agent/records/**`, `session/store/**`)

- New record types have a `restoreAgentRecord` case (or an explicit observability no-op) and replay-parity tests; restore goes through the same mutator, with no UI/LLM/fs side effects.
- `AGENT_WIRE_PROTOCOL_VERSION` bumps only when existing records change meaning, with a chained migration.
- Our superset records (swarm/coordinator/guardian/snapshot/session.meta/…) are never stripped by a port.
- `state.json` stays summary metadata; order-sensitive truth lives in `wire.jsonl`; `config.toml` is written only through the config write path.

### Swarm / coordinator / teammates (`agent/swarm/**`, `agent/coordinator/**`, `session/subagent-*.ts`)

- The agent graph stays two levels: coordinator workers and teammates cannot spawn; the spawn denies enforce this, not conventions.
- Team/mailbox stores keep atomic per-key writes with in-process serialization; roster authority stays with SessionMeta.
- Batch scheduling changes stay inside the documented `SubagentBatch` contract (launch pacing, rate-limit backoff, per-task timeout).

### Config / flags / errors

- Config keys land in `config/schema.ts` in both the full and the strict patch schema; snake_case on disk, camelCase in memory; runtime state never rewrites `config.toml`.
- New flags go in `FLAG_DEFINITIONS` with a `CLOUD_CODE_EXPERIMENTAL_*` env; gated behavior has tests; no ad-hoc env toggles.
- New error codes pair an `ErrorCodes` entry with `CLOUD_CODE_ERROR_INFO`; wire code branching on `code`, not `instanceof`; provider error classification stays centralized in `serialize.ts`.

### TUI (`apps/cloud-code/**`)

- Components do not call the SDK; logic sinks to `controllers/`; new dialogs use DialogFrame; new mouse interactivity uses declarative hit zones.
- No chalk named colors; no literal printable-char comparisons in `handleInput` (`printableChar` first); keyboard changes follow `docs/tui-keyboard-contract.md` (exceptions registered).
- Every new user-visible string goes through `t()` in **both** `en` and `zh-CN`; no `.padEnd()` for alignment (`padEndVisible`); model-facing text stays English (tool results localize via `display` pointers).

### Brand and telemetry (always)

- No user-visible "Kimi Code" / "kimi-code" added; the Moonshot service contract (provider literal `'kimi'`, `managed:kimi-code`, OAuth keys, `X-Msh-Platform`, `KIMI_*` env family, model IDs, `*.kimi.com` URLs, locked formats) is byte-identical; A/B/C/D classification done for any `kimi` reference touched.
- No telemetry introduced in any form — no event reporting, no facade, no outbound analytics channel, including inside ported upstream code.

### Tests

- New behavior has vitest coverage; DI services resolve the SUT by interface; stubs live under `test/` as factories; tests are hermetic (no real home, no wall-clock, env restored); no focused/conditional tests.
- For record changes: both live-append and resume-replay paths covered.
- The diff leaves `pnpm build && pnpm test && pnpm lint` green — that is the phase gate.
