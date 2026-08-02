---
name: write-tui
description: Use when writing or modifying the Cloud Code terminal UI in apps/cloud-code/src/tui — components, dialogs/selectors, slash commands, themes, streaming render, or the CloudCodeTUI controllers. Covers the architecture, where new features go, test placement, the theme system mechanics, and the normative spec documents (docs/tui-design.md, the keyboard contract, and the modal-surfaces contract).
---

# Write TUI (apps/cloud-code)

The terminal UI lives in `apps/cloud-code/src/tui`. Before writing TUI code, read the normative documents — this skill is the **how-to** (architecture orientation, feature routing, test placement, theme mechanics); the rules live in:

- `apps/cloud-code/AGENTS.md` — the always-on **map, module boundaries, and hard constraints** (printable-key decoding, no chalk named colors, component/SDK separation).
- `docs/tui-design.md` — the written **visual spec** (box dialects, dividers, padding, token usage, tables, narrow-terminal policy; its §9 tracks legacy implementations awaiting migration).
- `docs/tui-keyboard-contract.md` — the **keymap contract** (unified key table, layered Esc, intentional-exceptions registry §5, deviation log §6).
- `docs/tui-modal-surfaces.md` — the **ModalSurface contract** (mount/dismiss, preempt vs queue, blocking semantics, Esc routing order, focus save/restore, mouse routing while stacked). The three modal mechanisms (editor-slot replacement / children-snapshot takeover / pi-tui overlay stack) stay physically separate — unify by contract, never merge.
- `.agents/skills/agent-core-dev/tui.md` — the engine-side summary of these rules (hit zones, DialogFrame, layout slots, i18n).

## Architecture

`CloudCodeTUI` is a **coordinator** that wires state, layout, session, and dialogs together and delegates heavy logic to controllers. There is no React/Ink — components implement the pi-tui `Component` interface (`render(width): string[]`, optional `handleInput` / `handleMouse` / `hitZones` / `onHitZone` / `setHoveredZone` / `invalidate`).

- `src/tui/cloud-code-tui.ts` — the `CloudCodeTUI` coordinator. Holds `state`, owns startup/shutdown order, layout/editor wiring, user-input entry, sending/queueing, session lifecycle, and slash-command dispatch. It must **not** accumulate event-routing or rendering logic — those live in controllers.
- `src/tui/tui-state.ts` — `TUIState`, `createTUIState`, `createInitialAppState`. The single global UI-state shape; `createTUIState` builds the layout tree (`transcript` scroll region + fixed bottom slot: activity → todo → queue → btw → notice → swarm → editor → footer). Before adding a global field, decide whether it truly belongs here vs. local component state.
- `src/tui/controllers/` — the independently-testable slices, one responsibility each:
  - `session-event-handler.ts` — routes SDK session events (`handleEvent` dispatch + per-event `handleXxx`). Concrete event handling goes here, not in `CloudCodeTUI`.
  - `streaming-ui.ts` — streaming render: assistant delta, thinking, tool call / result, compaction, transcript aggregation.
  - `subagent-event-handler.ts` — subagent/swarm lifecycle events driving the swarm progress grid and agent-group messages.
  - `session-replay.ts` — resume/replay orchestration; drives replay records through the same live render hooks.
  - `tasks-browser.ts` / `teams-browser.ts` / `workflows-browser.ts` — fullscreen takeover browsers (children-snapshot swap) with their trackers.
  - `editor-keyboard.ts` — editor keyboard handling, exit shortcuts, external editor, clipboard image.
  - `auth-flow.ts` — login/auth orchestration.
- `src/tui/commands/` — slash-command declaration, parsing, ordering, and dynamic skill-command generation (`skills.ts` → `buildSkillSlashCommands`). Parsing and types only; execution is dispatched from `CloudCodeTUI`, and complex execution sinks into `utils` or focused components.
- `src/tui/components/` — pi-tui components by UI type: `chrome/` (footer, todo panel, welcome, loader, gutter containers, floating dialog surface), `dialogs/` (~40 selectors / approval / question / settings popups plus the shared `frame/`), `editor/` (input box + mention provider), `media/` (image, diff, code highlight), `messages/` (transcript blocks + `tool-renderers/`), `panes/` (activity, queue, btw), `primitives/` (pure line builders: `renderBox` / `renderRow` / `renderDivider` / `renderTable`).
- `src/tui/reverse-rpc/` — adapts SDK approval/question callbacks into UI panel data and the user's choice back into an SDK response.
- `src/tui/theme/` — themes, color tokens, style helpers, custom-theme loader + JSON schema, pi-tui markdown theme, terminal-background detection. The single source of truth for color.
- `src/tui/i18n/` — `t()` singleton, en + zh-CN domain dictionaries (compile-time same-shape), `resolveDescription()`, `tIfKnown()`, `padEndVisible()`.
- `src/tui/utils/` — TUI-only utilities (need `TUIState` or a component). App-wide, UI-independent helpers go in `src/utils/`.

When a controller or `CloudCodeTUI` section keeps growing, split pure functions, state projections, and presentation components into the matching directory rather than expanding the file (800-line soft cap).

## Where new features go

The feature type decides the landing spot:

- **CLI arguments** → `src/cli/commands.ts` / options, passed into the TUI via `src/cli/run-shell.ts`. The CLI never operates on the session directly.
- **CLI subcommands** → `src/cli/`, non-interactive; reach core via `@cloud-code/sdk` only.
- **Slash commands** → declare/parse/type under `src/tui/commands/`; add the execution entry in `CloudCodeTUI`'s dispatch; sink complex logic into `utils` or a focused component. Gate unreleased commands with an `experimentalFlag` id.
- **Skill-derived commands** → hook into `buildSkillSlashCommands`; do not hard-code a single skill.
- **Transcript message types** → define the shape in `src/tui/types.ts`, add/extend a `components/messages/` component, register it in the transcript builder.
- **Tool-result display** → extend `components/messages/tool-renderers/`; do not stack branches inside `tool-call.ts`. Localized display text rides the result's `display: { key, params }` pointer rendered via `tIfKnown` against `toolResult.*` keys (model-facing `output` stays English); machine-readable facts ride the `structured` payload (`packages/protocol/src/structured.ts`, `safeParse` first, fall back to raw text).
- **Popup / selector / dialog** → `components/dialogs/`, built on **DialogFrame** (`frame/dialog-frame.ts` — never hand-render dialog chrome) and mounted through the editor slot (`mountEditorReplacement`; `dialog` panels are preemptible, `blocking` panels queue; fullscreen floats via `ui.showOverlay`). Follow `docs/tui-design.md` and the keyboard contract. If triggered by an SDK callback, check whether `reverse-rpc/` needs an adapter.
- **Mouse interactivity** → declarative hit zones (`hitZones()` + `onHitZone()` + `setHoveredZone()`); let `DialogFrame.zones(contentZones)` shift content zones instead of re-deriving row math. The raw `handleMouse` path is for zone-less special cases.
- **SDK event handling** → add the dispatch in `session-event-handler.ts`'s `handleEvent`, then the matching `handleXxx`.
- **Streaming render** → `controllers/streaming-ui.ts`.
- **Session start / resume behavior** → the session-management section of `CloudCodeTUI`; replay behavior → `controllers/session-replay.ts`, reusing live render paths.
- **Takeover browsers** → a `controllers/*-browser.ts` owning the children-snapshot swap and restore; keep browser state out of `TUIState` unless it truly is global.
- **Status bar / activity / queue / btw** → `chrome/footer`, `panes/`, and the matching update paths.
- **Configuration option** → schema + read/write in `src/tui/config.ts` (`tui.toml`), then the settings UI; persist through `saveTuiConfig` — a component never writes the config file itself. Engine config never goes into `tui.toml` (see agent-core-dev/config.md).
- **Constants** → shared CLI/TUI non-copy constants in `src/constant/`; TUI-only in `src/tui/constant/` (e.g. `symbols.ts` → `SELECT_POINTER`). Component-local copy, option labels, help text, dialog titles/footers stay next to their component — but any user-visible string is an i18n key, not a literal.
- **User-visible strings** → add the key to the matching domain file in `i18n/locales/en/` **and** `i18n/locales/zh-CN/` (missing keys are compile errors), call `t()` at render time. Never cache localized strings; never `.padEnd()` — use `padEndVisible()`.
- **General capability** → no TUI-state dependency → `src/utils/`; depends on TUI state or a component → `src/tui/utils/`.

## Test placement

Tests live under `apps/cloud-code/test/` (vitest), mirroring the source area:

- Component behavior tests → `test/tui/components/...` (render output + `handleInput` key behavior).
- Command parsing tests → `test/tui/commands/`.
- Controller tests → next to the corresponding controller tests.
- reverse-rpc tests → `test/tui/reverse-rpc/`.
- Pure utility tests → next to the corresponding utils tests.
- E2E → `test/e2e/` (`KIMI_E2E=1 pnpm -C apps/cloud-code e2e`).
- Do not create a generic `some-feature.test.ts` just to land a small feature; extend the nearest existing test file. Invariant-scanning rules (colors, printable keys) belong in a `*-guard.test.ts` alongside the existing guards.

## Theme system mechanics

Themes are managed centrally under `src/tui/theme/`:

- `colors.ts` — semantic tokens: `ColorPalette`, `darkColors`, `lightColors`.
- style helpers built on `ColorPalette`; `pi-tui-theme.ts` — the markdown/pi-tui theme config.
- `custom-theme-loader.ts` + `theme-schema.json` — user custom themes and their validation schema.
- `terminal-background.ts` / `detect.ts` — background detection and auto/dark/light resolution.

> **Keep the color-token set in sync.** `ColorPalette` in `colors.ts` is the source of truth. When you add, rename, or remove a token, update its mirrors in the same change: `theme-schema.json`, the custom-theme documentation, and the `custom-theme` built-in skill (`packages/agent-core/src/skill/builtin/custom-theme.ts`). Fill in **both** `darkColors` and `lightColors`; light-theme text tokens need ≥4.5:1 contrast, borders/large chrome ≥3:1.

Apply / switch flow:

- UI entry: the theme selector → theme command handler → apply choice.
- The real apply step updates `state.theme` / `state.appState.theme` and notifies components to refresh their palette — styles must be generated on the render path from the current palette (no module-top-level cached styled functions).
- Persist the choice through `saveTuiConfig` — a component must not write the config file itself.

The **hard color rules** (no chalk named colors, guard-enforced) live in `apps/cloud-code/AGENTS.md`; this skill covers only the mechanics.

## Before you submit

- `pnpm -C apps/cloud-code test` on the affected area; `pnpm lint` shows no new errors.
- Any dialog/selector/input/toggle list: walk `docs/tui-design.md` and the keyboard contract; register intentional key exceptions in the contract doc's §5 and alignment fixes in §6.
- `printableChar()` for printable-key comparisons (CI guard) and theme tokens for color (CI guard).
- New user-visible strings exist in both locales; CJK alignment uses `padEndVisible()`.
- New dialogs use DialogFrame; new mouse interactivity uses hit zones; the three modal mechanisms stay separate.
