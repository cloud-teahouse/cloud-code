# Topic — TUI

How the `apps/cloud-code` terminal UI is built: pi-tui components, declarative hit zones, DialogFrame, the layout slots, the keyboard contract, and the i18n rules. Read this before adding or modifying any TUI surface.

The TUI is **not** React/Ink. It runs on a vendored, modified pi-tui (`packages/pi-tui/`): components implement `render(width): string[]` plus optional `handleInput`, `handleMouse`, `hitZones`, `onHitZone`, `setHoveredZone`, `invalidate`. The `TUI` root does differential rendering, an alternate-screen **fullscreen mode** (default; `tui.toml fullscreen=false` falls back to inline scrollback), a scroll region + pinned bottom slot, an overlay stack, and single-focus keyboard dispatch (no bubbling). Entry chain: `main.ts` → `cli/commands.ts` → `cli/run-shell.ts` → SDK `CloudCodeHarness` → `tui/cloud-code-tui.ts`.

## Module boundaries (hard)

From `apps/cloud-code/AGENTS.md`:

- `CloudCodeTUI` coordinates; it does not accumulate business rules — heavy logic sinks into `controllers/` (event routing, streaming render, session replay, browsers, editor keyboard, auth).
- `components/` handle presentation and local interaction only — they **never call the SDK directly** and never read/write session state.
- `commands/` own slash-command declaration and parsing; execution is dispatched from `CloudCodeTUI`.
- `reverse-rpc/` adapts SDK approval/question callbacks into panel/dialog data shapes and back.
- `theme/` is the single source of truth for color — **chalk named colors are forbidden** (CI-enforced by `chalk-named-color-guard.test.ts`); use theme tokens / style helpers, and add semantic tokens to `ColorPalette` (both dark and light) when none fits.
- Constants live in the matching `constant/` directory.
- Inside `handleInput(data)`, comparing a printable character with a literal (`data === 'q'`) is **forbidden** — Kitty-protocol terminals send CSI-u sequences. Decode via `printableChar(data)` first (CI-enforced by `printable-key-guard.test.ts`); function keys use `matchesKey(data, Key.*)`.
- The app reaches engine capabilities through `@cloud-code/sdk` only.

## Layout zones (the screen)

`createTUIState()` (`tui/tui-state.ts`) builds the tree: `rootContainer` (a `BottomAnchorContainer`) holds exactly two children — the **transcript** (scroll region) and the **slot** (fixed bottom region), registered via `ui.setLayoutRegions({ scroll, slot })`. Slot order:

```text
activity → todo panel → queue → btw → notice → swarm → editor → footer
```

Chrome gutter is `CHROME_GUTTER = 1`; `GutterContainer` / `EditorSlotContainer` pad children and report `leftInset` / `rowsBeforeChild` for mouse translation. Fullscreen extras (sticky prompt header, scroll badge, virtual scrollbar) are pi-tui managed. Panel dialogs mount through the **editor slot** (token-based owner: `dialog` panels are preemptible, `blocking` panels — approval/question — queue); fullscreen takeovers snapshot `ui.children`, swap in the browser, and restore on close. The three modal mechanisms (editor-slot replacement / children-snapshot takeover / pi-tui overlay stack) are unified by contract, not merged — see `docs/tui-modal-surfaces.md`.

## Hit zones (mouse)

There is no central registry class — mouse interactivity is **declarative hit zones** (`packages/pi-tui/src/hit-zones.ts`):

- A component declares `hitZones(): HitZone[]` (`{ id, row, col, width, height, semantics: { action, hover } }`); `resolveHitZones(root, width)` walks the subtree, composing container children with accumulated row/col offsets; `hitZoneAt(zones, row, col, kind)` hit-tests. Coordinates: row 0-based, col 1-based, in the same frame as translated mouse events.
- The TUI translates terminal coords (gutter/slot-clip aware), routes presses to `owner.onHitZone(id, ownerRelativeEvent)`, and tracks hover centrally via `owner.setHoveredZone(id | null)`. Components outside zones keep the raw `handleMouse` path.
- Dialogs do not re-derive row math: `DialogFrame.zones(contentZones)` shifts content zones by the recorded `contentRow` and adds chrome zones (`'search'`, namespaced `'tab:<index>'`).
- Legacy shared-hover idiom (click = select, re-click = Enter) lives in `tui/utils/mouse-hover.ts`; new surfaces should prefer hit zones.

## DialogFrame

`components/dialogs/frame/dialog-frame.ts` is a **composition helper, not a Component**. Each dialog owns one and calls `frame.render(width, { title, hintParts, notice, tabStrip, search, content, footer })` for the full chrome; the frame records `contentRow` and provides `zones(...)`, layered `handleEscape` (clear query → unfocus search → close), and the narrow-terminal `tooSmall` fallback. Build new dialogs on it — do not hand-render dialog chrome.

## Keyboard contract

All interactive surfaces share one keymap contract, registered in `docs/tui-keyboard-contract.md`:

- **Esc peels the innermost layer first** (clear query → unfocus → close). Focus layers: editor (default) → editor-slot dialogs (with inner sub-states) → fullscreen takeovers.
- ↑/↓ navigate (j/k only in fullscreen browsers/viewers + vim), PgUp/PgDn page, Home/End first/last, Enter confirm, Space toggle/confirm/query-char, Tab/Shift+Tab tabs, `/` focus search, digits quick-select (approval/question only), y/N armed confirms, Ctrl+C/D interrupt/cancel, Alt+letter row-management actions (must pass `normalizeLegacyMetaKey`).
- Before adding or changing key bindings: read the contract; a new intentional exception must be registered in its §5, and alignment fixes leave a trail in §6. Mouse: click = select, re-click = Enter, wheel = ↑/↓.

## i18n rules (hard)

Runtime: `tui/i18n/` singleton — `t(key, vars?)` with fallback active locale → English → key itself; `setLocalePreference('auto' | 'en' | 'zh-CN')` hot-switches and persists to `tui.toml`'s `language` key. Dictionaries: `tui/i18n/locales/en/*.ts` (~25 domain files) are the compile-time source of truth; `zh-CN` must be a complete `Record<MessageKey, string>` — **missing/extra keys are compile errors**.

- **Every new user-visible string goes through `t()`** into a domain dictionary, in **both** locales, called at render time (no caching localized strings). Constants that cannot call `t()` at module scope store the key and resolve via `resolveDescription()`.
- **Not translated:** log/diagnostic strings, easter eggs, banner art, tool names, slash-command names/flags, language names, and model-facing text. Tool results keep English `output`; their UI localization rides the `display: { key, params }` pointer (`ToolResultDisplayRef`) rendered via `tIfKnown` against `toolResult.*` keys, falling back to raw text.
- **CJK alignment:** column padding uses `padEndVisible()` (`i18n/pad-visible.ts`) — `.padEnd()` on user-visible labels is banned.
- Historical transcripts keep the language they were generated in (intentional).

## Red lines (this topic)

- Components never call the SDK; `CloudCodeTUI` never accumulates business logic; logic sinks to `controllers/`.
- No chalk named colors; no module-level cached styled functions (theme switching must apply within one render).
- No literal printable-char comparisons in `handleInput` — `printableChar(data)` first.
- New dialogs use DialogFrame; new mouse interactivity uses declarative hit zones; keyboard changes follow the contract doc and register exceptions.
- Every new user-visible string goes through `t()` in both locales; `.padEnd()` is banned for alignment; model-facing text stays English.
- The three modal mechanisms stay separate — unify by contract, never by merging implementations.
