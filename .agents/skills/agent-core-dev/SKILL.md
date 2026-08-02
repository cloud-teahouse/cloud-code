---
name: agent-core-dev
description: Use when developing in packages/agent-core (the Cloud Code agent engine) — adding or modifying a DI service, a builtin tool, an RPC method, a wire record type, a permission policy, a config key, an experimental flag, or a coded error; working on the compaction, swarm, coordinator, teammate, or background-task subsystems; touching the apps/cloud-code TUI (hit zones, DialogFrame, layout slots, keyboard contract, i18n); or porting/triaging an upstream kimi-code commit. Self-contained guide organized by development stage (orient → design → implement → test → verify) plus topic guides for services, domain boundaries, persistence, compaction, config, errors, flags, permission, edge exposure, TUI, brand, and the no-telemetry rule; each file carries the rules, examples, and red lines for its step.
---

# agent-core-dev

> Develop `packages/agent-core` (and its `apps/cloud-code` TUI surface) by lifecycle stage. This skill is **self-contained**: every rule, recipe, and red line lives in the stage files below. It codifies the root `AGENTS.md`, `packages/agent-core/src/services/AGENTS.md`, `apps/cloud-code/AGENTS.md`, and `docs/` contracts so you can work without re-deriving them; those documents remain the source of truth when they disagree with this skill.

`packages/agent-core` (`@cloud-code/agent-core`) is the agent engine: a stateless `loop/`, plain per-session `Session` and per-agent `Agent` classes, a VSCode-style DI service layer (`di/` + `services/`), and the in-process RPC surface (`rpc/`) that `node-sdk` / `server` / the TUI talk to. Cloud Code CLI is a fork of kimi-code; where our architecture has diverged (graduated compaction, guardian approval, teammates/coordinator, sandboxed kaos, wire-format extensions), the stage files say so explicitly.

## Lifecycle at a glance

```text
Orient → Design → Implement → Test → Verify
  │        │          │          │        │
  │        │          │          │        └─ pnpm build · pnpm test · pnpm lint · guards · red lines
  │        │          │          └─ test.md
  │        │          └─ implement.md (+ errors.md · flags.md · permission.md · config.md)
  │        └─ design.md
  └─ orient.md
```

Stages are ordered but not strictly linear: a test failure (stage 4) that reveals wrong state ownership sends you back to design (stage 2); a `CyclicDependencyError` sends you to `design.md` §dependency-direction.

## Workflows

End-to-end procedures that span the stages. Reach for these before reading the stage files individually.

- [Upstream align (port `kimi-code` → Cloud Code)](align.md): split an upstream feature into semantic units, map each to our packages/domains, re-wire dependencies under our architecture constraints, then migrate logic and tests — applying the brand contract and our subsystem divergences. Use when the task is "port upstream feature X" or "align our fork with upstream's Y".
- [Commit align (triage an `upstream/main` commit)](commit-align.md): given one upstream commit hash + a short note, find the logic it changed, check whether we already have the corresponding implementation, bucket it (aligned / partial / missing / not-applicable), and recommend a minimal fix. Use when catching the fork up to `upstream/main`, one commit at a time; escalate to [align.md](align.md) if the gap is a whole domain.

## Stages

- [Stage 1 — Orient](orient.md): the package map, the service DI black box (identity / dependencies / lifetime), the Session/Agent/loop runtime, and the import boundaries. Read before touching business code.
- [Stage 2 — Design](design.md): decide *where things live and who knows whom* — state ownership (Core vs Session vs Agent vs loop), calling style (direct call vs event vs hook vs wire record), and dependency direction.
  - Topic: [Domain boundaries](domain-boundaries.md) — keep `Session` / `Agent` from becoming god objects; the data-ownership test and their split conclusions.
  - Topic: [Persistence & wire records](persistence.md) — what must be a replayable wire record vs runtime state vs config; the session on-disk layout.
  - Topic: [Compaction layers](compaction.md) — the graduated three-layer model (tool-result budget → pinpoint purge → full LLM summary), thresholds, and the effective-count rule.
  - Topic: [Edge exposure](edge-exposure.md) — how a capability becomes visible over `CoreAPI` → `node-sdk` → `server` → TUI; what may be exposed directly vs adapted.
- [Stage 3 — Implement](implement.md): the standard recipes — add a service, a builtin tool, an RPC method, a wire record type, a config key, a flag, a permission policy.
  - Topic: [Service authoring](service-authoring.md) — file layout, naming (`Service` suffix only), contract vs impl contents, registration, comment rules.
  - Topic: [Config](config.md) — the central zod schema model, snake_case ↔ camelCase, env overlays, `tui.toml`, project-local `.cloud-code/`.
  - Topic: [Errors](errors.md) — the central `ErrorCodes` + `CloudCodeError` + `CLOUD_CODE_ERROR_INFO` registry, wire serialization, boundary translation.
  - Topic: [Flags](flags.md) — `FLAG_DEFINITIONS`, `FlagResolver` precedence, scoped resolver threading, TUI gating.
  - Topic: [Permission](permission.md) — the ordered policy chain (first hit wins), rules DSL, approve-always persistence, guardian, sandbox escalation, topology denies, the teammate permission bridge.
  - Topic: [Close vs Dispose](close-vs-dispose.md) — sync `dispose()` for resources, async `close()` for business shutdown; where abort belongs.
  - Topic: [TUI](tui.md) — pi-tui components, declarative hit zones, DialogFrame, layout slots, the keyboard contract, i18n rules.
  - Topic: [Brand](brand.md) — the Cloud Code brand rules and the untouchable Moonshot service contract list.
  - Topic: [Telemetry](telemetry.md) — **we do not have telemetry; do not add it.**
- [Stage 4 — Test](test.md): vitest conventions, the DI test harness, stub discipline, guard tests, e2e.
- [Stage 5 — Verify & submit](verify.md): `pnpm build && pnpm test && pnpm lint` three-green, typecheck, and the pre-submit checklist.

## How to use this skill

Jump to the stage you are in and read that one file; each is self-contained and ends with its own red lines. Skim the global red lines below before submitting — they catch most mistakes across every stage. The repo's source of truth remains the code plus the `AGENTS.md` files; this skill codifies the same rules so you do not have to re-derive them.

## Global red lines

Invariants that hold across every stage. Each is expanded in the file noted.

1. `apps/cloud-code` depends on `@cloud-code/sdk` only — never import `@cloud-code/agent-core` internals from app code. (orient.md)
2. `loop/` stays stateless: `LLM` / `buildMessages` / `dispatchEvent` are injected by the host; the loop never imports host implementations. (orient.md, design.md)
3. Every file/process operation goes through `kaos` — tools never touch `node:fs` / `node:child_process` directly. (design.md)
4. Services follow the VSCode convention: `IXxxService` interface with `_serviceBrand` + `createDecorator('xxxService')` + `XxxService` impl + bottom-of-file `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)`. The `Service` suffix is mandatory — no `Bus` / `Broker` / `Bridge` / `Registry` / `Manager`. (service-authoring.md)
5. Never `new` a class whose constructor carries `@IService` deps — resolve by interface through the container. (implement.md, test.md)
6. Throw coded errors: `CloudCodeError` with an `ErrorCodes` entry and a matching `CLOUD_CODE_ERROR_INFO`; branch on `code` across the wire, never `instanceof`. (errors.md)
7. Gate unreleased behavior behind a `FLAG_DEFINITIONS` flag resolved through `FlagResolver.enabled(id)`; no ad-hoc env toggles. (flags.md)
8. The permission chain adjudicates risk in order — first hit wins. Harness constraints are hard denies placed above the approve cascade; new rule specifics go through the data path (`PermissionRule`), not a new policy. (permission.md)
9. Durable, replayable facts are wire records; runtime-only state stays in memory; `config.toml` is rewritten only through the config write path. (persistence.md, config.md)
10. New user-visible TUI strings go through `t()` in **both** `en` and `zh-CN` dictionaries; CJK column alignment uses `padEndVisible()`, never `.padEnd()`. (tui.md)
11. No user-visible "Kimi Code" / "kimi-code" strings; the Moonshot service contract (provider literal `'kimi'`, `managed:kimi-code`, OAuth keys, `X-Msh-Platform`, `KIMI_API_KEY`, model IDs, `*.kimi.com` URLs) is untouchable. (brand.md)
12. No telemetry — the package was deleted from this repo; do not add event reporting, metrics beacons, or a telemetry facade. (telemetry.md)
13. Tool-result visible order strictly equals provider order — concurrency may start results early, never show them early. (design.md)
14. Single-file soft cap of 800 lines; split at review time. (implement.md)
15. New features ship with vitest coverage; a phase ends only when `pnpm build && pnpm test && pnpm lint` are all green. (verify.md)
