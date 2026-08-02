# Stage 1 — Orient

Understand the moving parts and the file conventions before touching business code.

## The package map

```text
apps/cloud-code        CLI/TUI app (npm: cloudcode-cli, bin cloudcode/cloud-code) — talks to the engine ONLY through @cloud-code/sdk
apps/vis               session replay visualization
packages/
  agent-core           the agent engine: loop / session / agent / permission / compaction / tools / services / rpc
  kosong               multi-provider LLM abstraction (kimi / anthropic / openai / google-genai); defensive wire layer
  kaos                 execution-environment abstraction — the ONLY channel for file/process ops (Local / SSH / sandboxed)
  node-sdk             public SDK / harness (@cloud-code/sdk)
  protocol             event + wire types: JSON-RPC envelope, event union, per-domain wire schemas, structured tool results
  server               @cloud-code/server: stdio/WS JSON-RPC service layer (multi-connection host, CoreAPI 1:1)
  transcript           transcript tooling
  pi-tui               vendored terminal UI framework (components, hit zones, overlay stack, fullscreen)
  oauth / minidb       support packages
```

## The three runtime shapes

`agent-core` has three distinct code shapes; know which one you are in before writing anything.

1. **The stateless loop** (`src/loop/`) — turn convergence (`run-turn.ts`), one provider step (`turn-step.ts`), tool-call lifecycle (`tool-call.ts` incl. the `StreamingToolCallRunner`). The loop imports no host implementation: the `LLM` contract, `buildMessages`, and `dispatchEvent` are injected by the host. If you are editing `loop/`, you may depend on types and injected capabilities only.

2. **Plain runtime classes** — `Session` (`src/session/index.ts`) and `Agent` (`src/agent/agent.ts`) are ordinary classes constructed directly (`CloudCodeCore` does `new Session({...})`; the session constructs agents). They are **not** DI services. Per-session singletons live as `Session` fields (`agents` map, MCP connection manager, hook engine, `teamStore`, `mailbox`); per-agent singletons live as `Agent` fields (permission manager, `SwarmMode`, `CoordinatorMode`, `BackgroundManager`, records). A turn is a function-call scope inside `loop/run-turn.ts` — there is no Turn object with its own lifetime.

3. **The DI service layer** (`src/di/` + `src/services/`) — VSCode platform-service style. `createDecorator<T>('xxxService')` mints an identifier that is simultaneously a runtime key, a constructor-parameter decorator, and a compile-time type carrier. Impl files self-register with `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)`; the container (`InstantiationService`) resolves singleton-per-container, detects cycles (`CyclicDependencyError` with a `path`), and lazily materializes `Delayed` services through a `Proxy`. See [service-authoring.md](service-authoring.md) for the authoring rules.

### The DI black box

When writing a service you declare three things; the container handles the rest (when to construct, whether it is the same instance, ordering, disposal):

- **Who am I** — `createDecorator<IXxxService>('xxxService')`: an identity that is both a runtime key and a compile-time type. The string is globally unique (it surfaces in `CyclicDependencyError.path`).
- **Whom do I need** — `@IXxxService` decorations on constructor parameters.
- **How long do I live** — singleton-per-container; `InstantiationType.Delayed` (default, constructed on first use) or `Eager` (constructed at bootstrap, e.g. `ILogService`).

Consumers resolve by interface (`accessor.get(IXxxService)` or constructor injection) and never import the impl class.

## The request path (who talks to whom)

```text
TUI (apps/cloud-code)  ──@cloud-code/sdk──▶  node-sdk  ──▶  rpc/CloudCodeCore (CoreAPI)
                                                              │ new Session({...})
                                                              ▼
                                          Session ──owns──▶ Agent ──drives──▶ loop/run-turn
                                                              │                   │
                                                              │                   ▼
                                                              │             kosong generate()
                                                              ▼
                                        kaos (fs/process/sandbox) · tools · permission chain
```

- The TUI never imports `agent-core` internals; it talks to the SDK, and SDK approval/question callbacks are adapted in `src/tui/reverse-rpc/`.
- `packages/server` exposes the same `CoreAPI` over stdio/WS JSON-RPC for multi-connection hosts (`cloud-code serve`); the TUI/`-p` can switch to it via `--server-stdio` / `--server <ws-url>`. Approval routing is per-sessionId; disconnect is fail-closed.
- In-process, the upper facade (`services/`) translates between the runtime and protocol shapes.

## The subsystems that are ours (diverged from upstream)

Cloud Code forked kimi-code and then diverged. When porting or reviewing, these subsystems are **ours** and do not match upstream:

- **Graduated compaction** — `agent/compaction/graduated.ts` (replaces upstream's `micro.ts`): three layers with independent thresholds. See [compaction.md](compaction.md).
- **Swarm / coordinator / teammates** — `SwarmMode` (session mode), the `AgentSwarm` batch tool (`session/subagent-batch.ts`), `CoordinatorMode` (main-agent orchestration role), and the in-process teammate runtime (`agent/swarm/team-store.ts`, `mailbox.ts`). Topology is hard-capped by permission denies. See [permission.md](permission.md).
- **Guardian AI approver** — `agent/guardian/`; in `auto` mode, non-whitelisted actions are reviewed by an independent model before execution.
- **Sandboxed execution** — `kaos/src/sandbox/` (bubblewrap); Bash runs sandboxed with an escalation path through the permission manager. File tools are governed by the permission chain, not the sandbox.
- **Wire-format extensions** — `snapshot.track/rewind`, `session.meta` re-append, swarm/coordinator mode records, structured tool-result payloads (`protocol/structured.ts`). See [persistence.md](persistence.md).
- **TUI** — fullscreen bottom-slot layout, declarative hit zones, DialogFrame, full i18n. See [tui.md](tui.md).

## Import boundaries

There is no `lint:imports` script. Enforcement is `pnpm lint` (`oxlint --type-aware`: `import/no-cycle` and `import/extensions` are errors) plus these documented architectural rules — treat violations as review blockers:

- `apps/cloud-code` depends on `@cloud-code/sdk` only; never import `@cloud-code/agent-core` internals.
- `loop/` is stateless; it never imports host implementations (`session/`, `agent/`, `rpc/`).
- All file/process operations go through `kaos`; tools never import `node:fs` / `node:child_process`.
- `services/` may import the runtime (`di/`, `rpc/`, `session/`, `agent/`) via relative submodule paths (never the barrel); **the runtime must not import `services/`**.
- Tool-result visible order strictly equals provider order: concurrency may advance *start*, never *visibility*.

## File conventions

- Kebab-case filenames are the norm in the runtime (`run-turn.ts`, `tool-call.ts`, `connection-manager.ts`); the `services/` subtree mandates camelCase domain folders (`coreProcess/`, `authSummary/`) — see [service-authoring.md](service-authoring.md).
- Many runtime files open with a short `/** … */` header stating what the module owns. Subsystem docs live as colocated `README.md` (`di/README.md`, `loop/README.md`) or `AGENTS.md` (`services/AGENTS.md`).
- Comment discipline (normative, from `services/AGENTS.md`): default to **no comments**. Comment only the non-obvious *why* — a hidden constraint, a subtle invariant, a workaround. One short line. No diff-narrating, no type-restating, no `file.ts:line` pointers (line numbers rot), no "regression guard for…" preambles on tests.
- Single-file soft cap: **800 lines**; split at review time.
- Markdown prompt assets (tool descriptions, reminders, coordinator/teammate prompts) are loaded via `?raw` imports and assembled at construction — editing the `.md` needs no schema change.

## Red lines (this stage)

- `apps/cloud-code` → `@cloud-code/sdk` only; `loop/` stays stateless; `kaos` is the only fs/process channel; runtime never imports `services/`.
- `Session` / `Agent` are plain classes — do not wrap them in DI or register them as services; the DI layer is for the `services/` facade.
- Resolve services by interface through the container; never `new` a `@IService`-carrying class.
- Comments state the non-obvious *why* only; no narration, no line-number pointers.
