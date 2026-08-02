# Topic — Errors

Error infrastructure for `agent-core`: the central code registry, the single error class, wire serialization, and the conventions for raising errors. Source: `packages/agent-core/src/errors/`.

## Where things live

- `src/errors/codes.ts` — the `ErrorCodes` const map (`SCREAMING_KEY: 'domain.reason'`), the derived `CloudCodeErrorCode` union, and `CLOUD_CODE_ERROR_INFO` (`{ title, retryable, public, action? }` per code — the `satisfies Record<CloudCodeErrorCode, …>` forces every code to carry info).
- `src/errors/classes.ts` — `CloudCodeError extends Error`: the **single** error class. Discrimination is always by `code`, never by subclass. Fields: `code`, JSON-safe `details`, local-only `cause`.
- `src/errors/serialize.ts` — `CloudCodeErrorPayload` (`{ code, message, name?, details?, retryable }`), `toCloudCodeErrorPayload()`, `fromCloudCodeErrorPayload()`, `makeErrorPayload()`.
- `src/errors/unexpectedError.ts` — `onUnexpectedError` / `setUnexpectedErrorHandler` / `safelyCallListener` for last-resort diagnostics.

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** `throw new CloudCodeError(ErrorCodes.X, message, { details })`. Bare `new Error` only for unreachable guards.
- **One code per failure mode.** Codes read `domain.reason`. Add new codes to `ErrorCodes` **plus** a matching `CLOUD_CODE_ERROR_INFO` entry — the typing forces the pair. Adding a code is a minor change; renaming or removing one is a major.
- **`details` is structured and JSON-serializable; `message` is a short human sentence.** Paths, exit codes, and identifiers go into `details`, not the message.
- **Branch on `code`, never `instanceof`, across the wire.** In-process, `isCloudCodeError()` is fine.
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors become coded errors where they enter a domain; keep the original as `cause`.

## The wire boundary

`CloudCodeErrorPayload` is the only shape that crosses RPC: `cause` and stack never cross. `toCloudCodeErrorPayload(error)` normalizes anything:

- `CloudCodeError` passes through; `retryable` is always re-filled from the registry so it cannot drift.
- `@cloud-code/kosong` provider errors are classified **centrally here** — `APIQuotaExceededError` → `provider.quota_exhausted`; `APIStatusError` 429/401 → `provider.rate_limit` / `provider.auth_error`; `APIConnectionError`/`APITimeoutError` → `provider.connection_error`; filtered empty responses → `provider.filtered`; `ChatProviderError` → `provider.api_error`. Do not hand-map HTTP status codes anywhere else.
- Unknown → `internal`.

RPC round-trip: the server side catches and responds `{ ok: false, error: toCloudCodeErrorPayload(e) }`; the client rehydrates with `fromCloudCodeErrorPayload()` (`rpc/client.ts`). Events carry the payload type (`ErrorEvent`). For signaled-not-thrown paths (turn/event boundaries), build payloads with `makeErrorPayload(code, message)`.

## Add an error code (recipe)

1. Add `NEW_CODE: 'domain.reason'` to `ErrorCodes` in `errors/codes.ts`.
2. Add the matching `CLOUD_CODE_ERROR_INFO` entry — `title`, whether it is `retryable`, whether it is `public` (safe to surface verbatim), optional `action`.
3. Throw `new CloudCodeError(ErrorCodes.NEW_CODE, …)` at the failure site; catch-side branches on `payload.code`.
4. If the error crosses to the TUI with user-facing copy, the display string goes through i18n `errors.*` keys (tui.md) — the thrown `message` stays English.

## Red lines (this topic)

- Throw coded errors; register codes centrally with their info entry.
- Discriminate by `code` — no error subclasses, no `instanceof` across the wire.
- Provider-API error classification lives only in `serialize.ts`.
- `cause`/stack never cross RPC; `details` must be JSON-safe.
- User-facing display strings are i18n keys; thrown messages stay English.
