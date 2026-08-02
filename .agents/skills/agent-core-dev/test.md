# Stage 4 — Test

Vitest conventions for this repo: where tests live, how to drive the system under test, the DI harness, stub discipline, and the guard-test pattern.

## Layout and runner

- Runner: **vitest** (repo-wide; `packages/pi-tui` alone uses `node --test`). Root `pnpm test` runs all projects (`packages/*` + `apps/cloud-code`).
- Tests live in a per-package **`test/` tree**, not colocated with `src/`: `packages/agent-core/test/{agent,session,loop,config,services,tools,skill,di,...}`, `apps/cloud-code/test/{tui,cli,e2e,...}`.
- Naming: `*.test.ts` (unit), `*.e2e.ts` / `*.e2e.test.ts` (e2e; `apps/cloud-code` e2e runs with `KIMI_E2E=1 pnpm -C apps/cloud-code e2e`).
- oxlint's vitest plugin enforces `expect-expect`, `no-focused-tests`, `no-conditional-tests` on all test files.
- New features must ship with tests (root AGENTS.md hard rule).

## The one rule (DI services)

**Resolve the system under test by its interface, through the container. Never `new` a production service whose constructor carries `@IService` dependencies.**

```ts
// ✅ resolve by interface — the registerSingleton binding is exercised
const svc = ix.get(IPromptService);

// ❌ construct the impl directly — registration, delay semantics, and
//    dependency resolution all go untested
const svc = new PromptService(core, events, auth, sessions, log);
```

Pure functions, value objects, and classes with **no** `@IService` deps may be constructed directly — and most runtime code (`Session`, `Agent`, loop helpers, permission policies, swarm/coordinator machinery) is plain classes, so construct those directly with hand-built or stubbed collaborators. The interface-resolution rule binds the DI service layer.

## The DI harness

`TestInstantiationService` (`src/di/testInstantiationService.ts`, re-exported from `src/di/test.ts`) is an `InstantiationService` that also implements `ServicesAccessor` (so `ix.get(IX)` works directly) and owns sinon (so `dispose()` restores stubs). `createServices` seeds it:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '../../src/di';
import { createServices, type TestInstantiationService } from '../../src/di/test';

describe('XxxService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, [
      [ILogService, stubLog],          // instance collaborator
      [IXxxService, XxxService],       // SUT: constructor → SyncDescriptor
    ]);
  });
  afterEach(() => disposables.dispose());

  it('does the thing', () => {
    const svc = ix.get(IXxxService);
    expect(svc.thing()).toBe('…');
  });
});
```

- Pairs are `[identifier, CtorOrInstance]`: a constructor becomes a lazy `SyncDescriptor` (use for the SUT and real collaborators); an instance is used as-is (use for fakes/stubs).
- `ix.stub(IId, { method() { … } })` swaps a partial object; `ix.stub(IId, 'method', value)` stubs one method; `ix.spy(IId, 'method')` spies.
- Fixture services declare dependencies with the same `@IService` parameter decorators as production (the build runs `experimentalDecorators`), and the `createDecorator` identifier must be initialized before the fixture class that uses it.

## Runtime tests (plain classes)

For `Session` / `Agent` / loop / permission / compaction code, construct the object under test directly and stub only the true external boundary:

- The LLM boundary: stub the injected `LLM` contract / kosong `generate` — capture what the system sends to the provider; never stand up a real provider.
- The fs/process boundary: kaos test doubles or in-memory persistence (`InMemoryAgentRecordPersistence` via `AgentOptions.persistence`); never touch the real `~/.cloud-code` in tests — use a temp dir.
- Time/timers: use the documented control knobs the system exposes (injected clocks, manual ticks, config intervals). Do not drive time with fake timers or real `setTimeout`.
- Env/config knobs are snapshotted at construction — set them **before** building the SUT and restore in `afterEach`.
- Resume/replay behavior: append records, then rebuild state from the log and assert parity with the live path (persistence.md) — both directions of a record type need coverage.

## Stub discipline

- Hand-rolled stubs must not be copied between test files. A stub needed by two files belongs in a shared `stubs`/fixtures module under `test/` (e.g. `test/fixtures/`), never in `src/`.
- Export a **factory** (`stubLog()`), not a shared singleton, so tests cannot leak state through a stub.
- The stub satisfies the full interface so the compiler — not a cast — keeps it in sync.
- Keep `beforeEach` for cross-cutting plumbing (env snapshot, disposables); the scenario's own setup stays inside the `it`, next to its assertions (DAMP over DRY: literal expected values, never re-derived by the implementation's logic).

## Guard tests (a repo pattern)

Several invariants are enforced by tests that scan source text rather than executing behavior: `test/tui/chalk-named-color-guard.test.ts` (theme tokens), `test/tui/printable-key-guard.test.ts` (CSI-u safe key handling), brand-guard tests asserting prompts contain no "Kimi Code". When you add a rule that is easier to violate than to test behaviorally, add a guard test of the same kind.

## Teardown

One `DisposableStore` per suite; add the container and subscriptions; dispose in `afterEach`. Do not add the SUT itself when the container already disposes what it creates. Every test must be hermetic and order-independent: restore mocks/spies and env in `afterEach`; give each scenario its own temp dir when state persists.

## Red lines (this stage)

- DI services resolve by interface through the container; never `new` a `@IService`-carrying impl.
- Shared stubs live under `test/` (never `src/`), as factories satisfying the full interface.
- Stub only the true external boundary (LLM, kaos, network); time flows through documented knobs, not fake timers.
- No real home dir, no real network, no wall-clock dependence; hermetic and order-independent.
- Literal expected values; assert observable effects, not internals.
- No focused or conditional tests; every `it` asserts.
