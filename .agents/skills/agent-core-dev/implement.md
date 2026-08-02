# Stage 3 — Implement

The standard recipes. Each names its files, the wiring step that makes it load, and the topic file with the details. Source of truth for the DI mechanics: `packages/agent-core/src/di/README.md`; for service authoring style: [service-authoring.md](service-authoring.md).

## Recipe — add a DI service (`services/`)

1. **Contract** — `src/services/<domain>/<domain>.ts` (camelCase folder, no kebab): the `IXxxService` interface with `readonly _serviceBrand: undefined`, the `createDecorator<IXxxService>('xxxService')` identity, sentinel errors, and protocol↔in-process shape translations.
2. **Impl** — `src/services/<domain>/<domain>Service.ts`: `class XxxService extends Disposable implements IXxxService` with `@IX` constructor injection; bottom-of-file `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)`.
3. **Barrel** — re-export both from `src/services/index.ts` (and the package barrel chain) so importing `@cloud-code/agent-core` runs the registration side effect.
4. **Tests** — see test.md; resolve the SUT by interface through `TestInstantiationService`.

Key rules:

- Prefer `InstantiationType.Delayed` — the container hands out a `Proxy` and constructs on first method call. `Eager` only when the service must exist before any consumer touches it (e.g. `ILogService`).
- Constructor takes a leading data bag? Use the descriptor overload: `registerSingleton(IXxxService, new SyncDescriptor(XxxService, [optionsBag]))`.
- Bootstrap may override the registry entry with `services.set(IX, prebuilt | new SyncDescriptor(Impl, [args], false))` for external handles or runtime static args. Later registration wins; do not rely on registration order elsewhere.
- Never `new` a class whose constructor carries `@IService` deps — `new` bypasses registration, the singleton cache, and cycle detection. Inject with `@IX` or resolve via `accessor.get(IX)`.
- `@IX` decorates **constructor parameters only**. For `createInstance` non-singletons, static parameters come first, `@IX` parameters after.
- `ServicesAccessor` obtained via `invokeFunction(fn)` is valid **only during that call** — never stash it for async use; inject the service instead.

## Recipe — add a builtin tool

1. Implement the tool under `src/tools/builtin/<family>/` (file, shell, web, memory, planning, goal, collaboration, state). All fs/process effects go through `kaos` — never `node:fs` / `node:child_process`.
2. Declare permission-relevant metadata: rule-matching (`matchesRule` / literal patterns), and whether the tool is read-only (drives streaming-early execution and auto-approve dimensions). Bash-class commands are segmented by the tree-sitter shell AST (`tools/support/shell-ast/`) — a deny/ask on any segment triggers; allow requires full segment coverage.
3. Register it in `src/agent/tool/` where builtin tools are assembled with DI-injected collaborators (`subagentHost`, `swarmMode`, `backgroundManager`, `teamStore`, `mailbox`, …).
4. If the result carries UI-facing facts, add a `structured` payload schema to `packages/protocol/src/structured.ts` (consumers `safeParse` first, fall back to raw text) and, where the TUI renders it localized, a `display: { key, params }` pointer into the `toolResult.*` i18n domain (model-facing `output` stays English).
5. Oversized single results (>50 KB / >2000 lines) are auto-persisted to `tool-results/` by the turn's budget mechanism — do not hand-roll truncation.

## Recipe — add an RPC method / wire capability

Follow [edge-exposure.md](edge-exposure.md): declare on `CoreAPI` (`rpc/core-api.ts`), implement in `CloudCodeCore` (`rpc/core-impl.ts`), thread through `node-sdk` and the `server` bridge (the method surface is a 1:1 mirror), and adapt the TUI side via `reverse-rpc/` for interactive round-trips. Errors cross as `CloudCodeErrorPayload` — throw coded `CloudCodeError` (errors.md).

## Recipe — add a wire record type

Follow [persistence.md](persistence.md): (1) add the key + payload type to `AgentRecordEvents` in `agent/records/types.ts`; (2) add a `case` in `restoreAgentRecord` (`agent/records/index.ts`) that restores **through the same mutator** that logged the record — or an explicit no-op for observability records; (3) do **not** bump `AGENT_WIRE_PROTOCOL_VERSION` unless existing records change meaning; if they do, add a chained `vX.Y.ts` migration and bump.

## Recipe — add a config key

Follow [config.md](config.md): add the field to the section's zod schema in `config/schema.ts` (both the full schema and the matching `*PatchSchema`), snake_case ↔ camelCase is automatic, wire an env binding via `resolveConfigValue` at the consumption site if env-overridable, add tests in `packages/agent-core/test/config/`.

## Recipe — add an experimental flag

Follow [flags.md](flags.md): append to `FLAG_DEFINITIONS` in `flags/registry.ts` (`env` must start with `CLOUD_CODE_EXPERIMENTAL_`), gate with `enabled('<id>')` on the scoped resolver at the behavior site. The `FlagId` union type-checks the id.

## Recipe — add a permission policy

Follow [permission.md](permission.md): implement `PermissionPolicy` under `agent/permission/policies/`, insert it into `createPermissionDecisionPolicies(agent)` at the correct precedence — structural/harness denies above the approve cascade, approves below user-configured deny/ask. First non-`undefined` result wins; ordering is the safety model. New *rule specifics* (another deny pattern) belong in the data path (`permission.rules`), not a new policy.

## Releasing resources (`Disposable`)

For anything that subscribes to events, starts timers, or holds handles:

```ts
import { Disposable } from '../../di';

export class XxxService extends Disposable implements IXxxService {
  constructor(@IEventService event: IEventService) {
    super();
    this._register(event.onDidPublish(() => { /* … */ }));
  }
}
```

- Extend `Disposable`, collect every `IDisposable` with `this._register(d)`; the container disposes registered children (LIFO) when the service is torn down.
- `dispose()` is **synchronous** resource cleanup. Async business shutdown (flush persistence, stop in-flight work, decide task policy) belongs in `close(): Promise<void>`, called before disposal — see [close-vs-dispose.md](close-vs-dispose.md).

## Cyclic dependencies (forbidden — refactor)

The container throws `CyclicDependencyError` with a `path` like `['aService', 'bService', 'aService']`. This is a protection mechanism telling you two services' responsibilities are mis-drawn. In priority order:

1. **Extract a third service** holding the part both need.
2. **Decouple with an event** (`Emitter<T>`) if one side only needs to know something happened.
3. **Re-partition** — one of them may belong to a different owner (design.md §1).

`InstantiationType` does not break cycles: `Delayed` defers construction cost, not the dependency graph. Do not "fix" a cycle by reaching for a lazy `accessor.get` inside a method — that hides the inversion instead of removing it.

## Comments and size

- Default to **no comments**; comment only the non-obvious *why*, one short line (services/AGENTS.md comment rules — see service-authoring.md).
- Single-file soft cap **800 lines**; when you cross it, split along responsibility lines before review.
- Kebab-case filenames in the runtime; camelCase domain folders in `services/`.

## Red lines (this stage)

- No `new` on a class whose constructor carries `@IService` deps — inject or `accessor.get(IX)`.
- `@IX` decorates constructor params only; `createInstance` objects put static params first.
- `ServicesAccessor` is valid only during `invokeFunction` — never stash it.
- Impl files self-register at the bottom (`registerSingleton`); the barrel re-exports them so the side effect runs.
- Tools touch the world through `kaos` only; no `node:fs` / `node:child_process` in tool code.
- No cyclic dependencies — refactor (extract / event / re-partition); laziness is not a fix.
- 800-line soft cap; comments only for the non-obvious *why*.
