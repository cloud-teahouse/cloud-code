# Topic — Edge exposure

How an engine capability becomes visible outside `agent-core`: the `CoreAPI` surface, the SDK, the server bridge, and the TUI's reverse-RPC. Read this before adding an RPC method, an event, or an interactive round-trip.

## The exposure chain

```text
agent-core rpc/CloudCodeCore (CoreAPI)
   │  in-process call / event union
   ▼
@cloud-code/sdk (node-sdk)  ── the ONLY thing apps/cloud-code may import
   │  stdio/WS JSON-RPC (cloud-code serve; method surface 1:1 with CoreAPI)
   ▼
@cloud-code/server (packages/server)
   │
   ▼
hosts: TUI (apps/cloud-code), -p headless, third-party clients
```

- `rpc/core-api.ts` declares `CoreAPI`; `rpc/core-impl.ts` (`CloudCodeCore`) implements it. Session-scoped methods route through `session/rpc.ts` and per-agent methods through `agent/rpc-methods.ts`.
- `packages/protocol` holds the wire types: the JSON-RPC envelope/handshake, the **event union**, and per-domain payload schemas (`session.ts`, `message.ts`, `tool.ts`, `approval.ts`, `question.ts`, `task.ts`, `skill.ts`, `structured.ts`, `ws-control.ts`). Wire types live there — not in `agent-core`, not in the app.
- The server is a thin multi-connection host: methods map 1:1 to `CoreAPI`, approvals route by `sessionId`, disconnect is fail-closed, delta merging applies backpressure; WS adds Bearer token + Origin guard + reconnect cursor.

## What may be exposed directly

A method is directly exposable on `CoreAPI` iff all hold:

1. Args are JSON-serializable (no live objects, `AbortSignal`, callbacks, resumer fns).
2. The return is JSON-serializable data or `void` (no class instances, streams, `AsyncIterable`, `IDisposable`, `Event`).
3. Errors are coded `CloudCodeError` — they cross as `CloudCodeErrorPayload` (errors.md).
4. It is a command/query, not a factory, stream, or sink.

If any fail → expose an **adapter shape**: ids in, data out. Live streams (LLM deltas, tool progress) go over the **event union**, never over request/response. Interactive round-trips (approval, question) are reverse-RPC: the engine calls *into* the host via SDK callbacks, adapted to UI in `apps/cloud-code/src/tui/reverse-rpc/`.

## Events

- Live facts (turn progress, `subagent.*` lifecycle, `background.task.*`, `agent.status.updated`) are events on the protocol union — fire-and-forget, per-sessionId routed at the server.
- Durable facts are **wire records**, not events (persistence.md): events are the live channel, records are the durable one. Do not make a client reconstruct state from events that replay already provides.
- Structured tool-result facts ride the `structured` payload channel (`protocol/structured.ts`): the tool result carries a JSON fact envelope; consumers `safeParse` first and fall back to raw text. This is how ExitPlanMode outcomes, Agent/Swarm envelopes, Bash background task ids, and goal reason codes reach the TUI without string scraping.

## Add a capability (recipe)

1. Declare the method on `CoreAPI` with protocol-typed args/return; implement in `CloudCodeCore` (or the session/agent RPC slice it delegates to).
2. Add or reuse the payload schema in `packages/protocol`.
3. Thread it through `node-sdk` and the server bridge — the method surface must stay 1:1; a core-only method that the server cannot forward is a bug.
4. New event? Add the variant to the protocol event union and emit through the established channel.
5. TUI side: SDK events are routed by `controllers/session-event-handler.ts`; interactive round-trips are adapted in `reverse-rpc/`; components never call the SDK directly (tui.md).
6. Mode/state changes that must survive resume are wire records first, RPC second (e.g. `permission.setMode` both records and responds).

## Red lines (edge exposure)

- `apps/cloud-code` imports `@cloud-code/sdk` only — never `agent-core` internals, never protocol-private paths.
- Wire types live in `packages/protocol`; do not declare ad-hoc wire shapes in `agent-core` or the app.
- No live objects over RPC — ids in, data out; streams are events.
- Interactive round-trips are reverse-RPC through the SDK callback contract; the engine never imports UI.
- The server method surface mirrors `CoreAPI` 1:1 — no server-only business logic.
- Events are live; records are durable — never substitute one for the other.
- Errors cross as `CloudCodeErrorPayload`; branch on `code` on the receiving side.
