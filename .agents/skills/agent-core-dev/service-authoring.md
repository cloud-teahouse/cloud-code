# Topic — Service authoring

How to write a service in `packages/agent-core/src/services/`: file layout, naming, what goes in the contract vs the impl, registration, and the comment rules. This is the day-to-day reference for stage 3's service recipe. The normative source is `packages/agent-core/src/services/AGENTS.md`; this file restates it so you do not have to cross-read.

The `services/` subtree is agent-core's **upper facade** layer: it may depend on the runtime (`di/`, `rpc/`, `session/`, `agent/`) via relative submodule imports (never the top-level barrel), and **the runtime must not import back into `services/`**.

## Naming (normative)

Every injectable thing uses the **`Service` suffix**. No `Bus`, no `Broker`, no `Bridge`, no `Registry`, no `Manager`.

| Artifact | Rule | Example |
|---|---|---|
| Decorator | `export const IXxxService = createDecorator<IXxxService>('xxxService')` | `IPromptService` |
| Interface | `export interface IXxxService { readonly _serviceBrand: undefined; ... }` | `IPromptService` |
| Class | `export class XxxService implements IXxxService` | `PromptService` |
| Decorator string | lowerCamelCase of the interface minus the leading `I`; **globally unique and stable** (it surfaces in `CyclicDependencyError.path` and "No service registered" errors) | `'promptService'` |
| Model / non-service types | PascalCase, no `I` prefix | `SessionMeta`, `PromptItem` |

The role (business facade / one-shot reverse-RPC broker / pub-sub bus / cross-process RPC adapter) is communicated through the **docstring** and the **interface shape**, never through the suffix:

| Role | Interface signature | Example |
|---|---|---|
| Business facade | mostly `Promise<T>` returns | `IPromptService.submit(...)` |
| One-shot broker | `request(req): Promise<resp>` + `resolve(id, resp)` | `IApprovalService` |
| Pub-sub bus | `publish(e)` + `readonly onDidXxx: Event<T>` | `IEventService` |
| Cross-process adapter | `readonly rpc: ...` + `ready(): Promise<void>` | `ICoreProcessService` |

## File / folder convention (normative)

- One folder per domain, **camelCase**, no kebab: `coreProcess/`, `authSummary/` — not `core-process/`. Enforced repo-wide by `scripts/check-service-naming.mjs`.
- **Contracts** file = `<domain>.ts` (no `Service` suffix). Holds the interface, the decorator, sentinel errors, adapter helpers, and protocol↔in-process shape translations.
- **Impl** file = `<domain>Service.ts`. Holds the concrete class and the bottom-of-file registration; imports the decorator + interface from the sibling contracts file.
- Helper classes/functions used only by the impl are co-located in the impl file.

```text
coreProcess/
  coreProcess.ts          ← ICoreProcessService, CoreProcessServiceOptions
  coreProcessService.ts   ← CoreProcessService implements ICoreProcessService
```

This mirrors `vscode/src/vs/platform/<domain>/common/<domain>.ts` + `<domain>Service.ts`.

## Interface style

- **Sync methods** return a concrete type; **async methods** return `Promise<T>`. Do not wrap a sync return in `Promise`.
- **Readonly fields** for immutable exposed state; prefer a getter when the value can change.
- **Events** as `readonly onDid…` properties typed `Event<T>`, backed by a private `Emitter<T>` registered with `this._register(...)` (`base/common/event`). `onDid…` = after the fact; `onWill…` = about to happen.
- Only interfaces used as a **DI token** carry `readonly _serviceBrand: undefined` — never base interfaces or plain models.

## Registration (normative)

Registry-based wiring, modelled on `vscode/src/vs/platform/extensions/common/extensions.ts`:

1. **Each `<X>Service.ts` self-registers at the bottom:**

   ```ts
   import { InstantiationType, registerSingleton } from '../../di';

   registerSingleton(IXxxService, XxxService, InstantiationType.Delayed);
   ```

   - Prefer `InstantiationType.Delayed` (the default): the container returns a `Proxy` that defers real construction until the first method call, avoiding ctor cost for services never used in a given session.
   - `InstantiationType.Eager` only when the service must exist before any consumer touches it (`ILogService`, so early errors are captured).
   - Leading data-bag ctor prefix → descriptor overload: `registerSingleton(IXxxService, new SyncDescriptor(XxxService, [optionsBag]))`.

2. **Consumers seed from `getSingletonServiceDescriptors()` directly.** Importing `@cloud-code/agent-core` loads the barrel, whose impl re-exports run the `registerSingleton(...)` side effects.

3. **Bootstrap may override** the registry-derived entry via `services.set(I, prebuiltInstance)` or `services.set(I, new SyncDescriptor(C, [runtimeArgs], false))` for services needing external handles or runtime static args. `registerSingleton` does not throw on a duplicate id; the later registration wins at every layer.

The legacy "hand-built array" and `defaultServicesModule()` wrapper patterns are gone. Do **not** reintroduce them — the registry is the source of truth.

## Comments (normative)

Default to **no comments**. Well-named identifiers and types already say WHAT the code does; a comment that restates that just decays as the code changes around it.

Write a comment only when the **WHY** is non-obvious to a reader who has the diff in front of them: a hidden constraint, a subtle invariant, a workaround for a specific upstream bug, behavior that would surprise someone reading the call. One short line max.

Do **not** write:

- Block / paragraph docstrings on internal helpers.
- Comments that narrate the diff itself ("now we call resumeSession first so cold sessions auto-load") — that belongs in the commit message, not the source.
- Comments that re-explain types already visible at the call site ("returns `Promise<Session>`").
- Comments pointing at other files by line number (`core-impl.ts:286-289`). Line numbers move; the pointer rots within a release.
- "Regression guard for …" / "fixes the bug where …" preambles on tests. The test name and assertions are the contract; the bug history belongs in git.

Existing files over-comment by historical accident. **Do not propagate that style to new code.** When touching an existing file, leave the surrounding comments alone — large comment deletions belong in their own dedicated cleanup pass, not bundled into behavior changes.

## Red lines (this topic)

- `Service` suffix on every injectable — no `Bus` / `Broker` / `Bridge` / `Registry` / `Manager`.
- One folder per domain, camelCase; contracts `<domain>.ts` + impl `<domain>Service.ts`.
- Decorator string is lowerCamelCase-minus-`I`, globally unique, stable.
- `_serviceBrand` only on interfaces used as a DI token — never on base interfaces or plain models.
- Sync methods return concrete types; do not `Promise`-wrap sync work.
- Impl self-registers at the bottom; the barrel re-exports impls so registration side effects run; no hand-built service arrays.
- `services/` imports runtime submodules directly (never the barrel); the runtime never imports `services/`.
- Comments only for the non-obvious *why*; no narration, no type restating, no line-number pointers.
