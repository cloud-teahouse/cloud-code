# Stage 5 — Verify & submit

Run the guards and re-scan the red lines before submitting.

## Commands

Bootstrap first (no global pnpm; the toolchain is project-local):

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
```

Then, from the repo root:

- `pnpm build` — full monorepo build (`pnpm -r run build`; packages build with `tsdown`).
- `pnpm test` — vitest across all projects (`packages/*` + `apps/cloud-code`).
- `pnpm lint` — `oxlint --type-aware`. Roughly 1k upstream-inherited warnings are tolerated; **no new errors** (`import/no-cycle`, `import/extensions`, and the vitest test rules are errors).
- `pnpm typecheck` — builds packages first, then `tsc --noEmit` per package + app.
- `pnpm sherif` — monorepo dependency hygiene, when you touched manifests.
- `pnpm -C apps/cloud-code e2e` — TUI e2e (`KIMI_E2E=1`), when the change crosses the SDK surface.

The phase gate (root AGENTS.md): **`pnpm build && pnpm test && pnpm lint` all green**, and every new feature carries vitest coverage. For a quicker loop, scope to the package: `pnpm -C packages/agent-core test` / `pnpm -C apps/cloud-code test`.

Development instances run with `CLOUD_CODE_HOME=$PWD/.dev-home` — never write to the real user home from a dev run.

## Guard inventory

Know which guard covers your change:

| Guard | Covers |
|---|---|
| `pnpm lint` (`import/no-cycle`, `import/extensions`) | import direction, extension discipline |
| `scripts/check-service-naming.mjs` | camelCase service folders/files |
| `test/tui/chalk-named-color-guard.test.ts` | theme-token color discipline |
| `test/tui/printable-key-guard.test.ts` | CSI-u-safe printable-key handling |
| brand-guard tests (e.g. `test/agent/compaction/instruction.test.ts`) | no "Kimi Code" in prompts/user-visible surfaces |
| `test/tui/modal-surfaces.test.ts` | the modal-surface contract matrix |

## Pre-submit checklist

Walk the stages you touched and confirm:

- **Design** — state lives with the owner whose lifetime matches; durable facts are wire records with restore cases; no foundational layer learned about an upstream one; no cycle was routed around.
- **Implement** — no `new` on `@IService`-carrying classes; impls self-register and are re-exported; tools go through `kaos`; coded errors with info entries; unreleased behavior is flag-gated; no telemetry crept in.
- **Test** — DI services resolved by interface; stubs under `test/`; hermetic tests; both live-append and resume-replay paths covered for record changes.
- **Boundaries** — `apps/cloud-code` touches SDK only; `loop/` still stateless; runtime does not import `services/`; wire types live in `packages/protocol`.
- **Surface** — new TUI strings in both locales; `.padEnd()` unused; keyboard changes registered in the contract doc; brand rules hold (A/B/C/D classification done).
- **Files** — 800-line soft cap respected; comments only for the non-obvious *why*; no line-number pointers in comments.

Then re-read the [global red lines](SKILL.md#global-red-lines) once — they catch most cross-stage mistakes in a single scan.

## Red lines (this stage)

- Do not submit with any of `pnpm build && pnpm test && pnpm lint` red — that is the phase gate, not a suggestion.
- Do not introduce a new lint error; tolerated upstream warnings are not a license to add more.
- Do not run dev instances against the real `~/.cloud-code`.
- No git mutations (commit/push/reset) unless the user explicitly asks.
