# Topic — Close vs Dispose

How to shut down a component in `agent-core`: when `dispose()` is enough, when to add an async `close()`, and where cancellation belongs. Read this before putting business shutdown logic into a `Disposable`.

## The one-sentence rule

> **`close()` is async business shutdown; `dispose()` is synchronous resource cleanup.**

`close()` finishes a component's work: stop in-flight operations, apply shutdown policy, flush persistence, release async resources. `dispose()` releases object resources: event subscriptions, timers, and child disposables.

## Why they must stay separate

`IDisposable.dispose()` (`di/lifecycle.ts`) is synchronous. The container and `Disposable` chains call it during teardown — children first, then reverse construction order. Nothing awaits a Promise returned from `dispose()`.

Business shutdown is usually async. It may need to:

- stop in-flight tasks and wait for settlement;
- decide policy (`kill` vs `keepAliveOnExit` vs `markLost` for background tasks);
- flush write queues and persistence (`writeMetadata`, record flushes);
- emit final records / events;
- close MCP connections, sockets, child processes, log handles.

If that logic lives in `dispose()`, it becomes fire-and-forget: teardown continues, dependencies may be disposed immediately afterward, and the async continuation runs against a half-dead object graph.

## What `close()` owns

Add `close(): Promise<void>` when a component owns async shutdown work. The reference implementation is `Session.close()` / `closeForReload()` (`session/index.ts`): it cancels rate-limit resumes, stops crons, cancels active turns, stops background tasks, flushes metadata, fires the `SessionEnd` hook, shuts down MCP, and closes the log handle — in that order, awaited.

A good `close()`:

- is idempotent — repeated calls return the same Promise or no-op;
- is called by lifecycle code **before** `dispose()`;
- rejects new work after it starts;
- applies shutdown policy explicitly;
- awaits the work it starts;
- leaves `dispose()` with only synchronous cleanup.

`flush()` is different from `close()`: `flush()` persists buffered state while the component stays open (record batching, metadata writes); `close()` is terminal.

## What `dispose()` owns

`dispose()` releases resources owned by the object instance:

```ts
class XxxService extends Disposable implements IXxxService {
  constructor(@IEventService event: IEventService) {
    super();
    this._register(event.onDidPublish(() => { /* … */ }));
  }
}
```

Use `dispose()` to `_register(...)` event subscriptions, clear timers, remove signal listeners, and dispose child `IDisposable`s. It must be idempotent and should avoid throwing. If `close()` already ran, `dispose()` is a no-op for business work and only cleans resources.

## Where abort / cancellation belongs

Cancellation is not graceful shutdown. For operation-scoped work, disposing an abort trigger is fine when the contract is **fire-and-forget cancel**: the operation observes the signal and settles asynchronously; disposal does not wait.

For a manager that owns many tasks and their state (the `BackgroundManager` precedent), `dispose()` is not the graceful abort path: expose `stop()` / `stopAll()` / `close()` and let lifecycle code await the one it needs. Internally it may use `AbortController` to propagate cancellation to process/agent/question tasks, but manager shutdown — terminal status, persistence, notifications — belongs in the explicit async path. `dispose()` may best-effort abort controllers as a safety net only.

## Decision tree

```text
What does the component own?
  ├─ only event subscriptions / timers / disposable handles
  │     └─ extend Disposable; no close() needed
  ├─ async work, in-flight tasks, persistence buffers, connections
  │     └─ add close(): Promise<void>; call it before dispose()
  ├─ a single operation callers may cancel
  │     └─ expose an AbortSignal or a fire-and-forget cancel handle
  └─ both async shutdown and disposable resources
        └─ close() for business shutdown; dispose() for resource cleanup
```

## Red lines (this topic)

- Do not put business shutdown in `dispose()` — it is synchronous and not awaited.
- Do not `await` inside `dispose()`.
- Do not rely on `dispose()` to flush persistence, emit final events, wait for tasks, or send notifications.
- Add `close(): Promise<void>` for async shutdown and call it before `dispose()`.
- Keep `close()` and `dispose()` idempotent; `dispose()` after `close()` must be safe.
- Disposal triggers cancellation only for operation-scoped work — never as a manager's shutdown policy.
