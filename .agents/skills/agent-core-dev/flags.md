# Topic — Flags

Experimental feature-flag gating for `agent-core`: the central `FLAG_DEFINITIONS` registry, the `FlagResolver` precedence chain, and how flags reach the TUI. Source: `packages/agent-core/src/flags/`.

Gate not-yet-public behavior behind `FlagResolver.enabled(id)` — the repository hard rule is that unreleased behavior is flag-gated, with no ad-hoc env toggles.

## Layout

- `src/flags/registry.ts` — `FLAG_DEFINITIONS` (`as const satisfies readonly FlagDefinitionInput[]`): each entry `{ id, title, description, env, default, surface: 'core' | 'tui' | 'both' }`. The `FlagId` literal union is derived from the array, so `enabled('<id>')` is compile-time typo-checked.
- `src/flags/resolver.ts` — `class FlagResolver`: pure, synchronous, reads env live on every call (nothing cached). A process-global `export const flags = new FlagResolver()` exists for compatibility only — prefer the scoped resolver.
- Config section: `[experimental]` (`ExperimentalConfigSchema = z.record(z.string(), z.boolean())` in `config/schema.ts`) — keys are intentionally loose so obsolete flags stay inert config.

## Resolution precedence

Highest wins; env is read live:

1. Master env `CLOUD_CODE_EXPERIMENTAL_FLAG` truthy → every flag on.
2. Per-flag env `CLOUD_CODE_EXPERIMENTAL_<ID>` → forces on **or** off.
3. `[experimental]` config section per-flag override.
4. Registry `default`.

`explain(id)` / `explainAll()` return the winning source plus effective value — this backs the `getExperimentalFeatures` RPC and the TUI experiments dialog.

## Scoping / threading

`CloudCodeCore` owns the root `FlagResolver` (constructed with `process.env` + `FLAG_DEFINITIONS` + `config.experimental`) and passes the **same resolver** into sessions, which pass it into agents — each falls back to `new FlagResolver()` only when constructed standalone. Config reload pushes overrides via `setConfigOverrides(config.experimental)`. At the behavior site, gate with the scoped resolver (`agent.experimentalFlags.enabled('tool-select')`), not the global singleton.

## TUI integration

- `getExperimentalFeatures` RPC → TUI caches a snapshot (`tui/commands/experimental-flags.ts`); `isExperimentalFlagEnabled(flag?)` with an `undefined` flag means ungated.
- A slash command can carry an `experimentalFlag` id to hide its palette entry unless the flag is on.
- The experiments selector dialog edits config overrides (locked when the master env is on). The master env also bypasses staged update rollouts.

## Add a flag (recipe)

1. Append a `FLAG_DEFINITIONS` entry in `flags/registry.ts`:

   ```ts
   {
     id: 'my_feature',
     title: 'My feature',
     description: '…',
     env: 'CLOUD_CODE_EXPERIMENTAL_MY_FEATURE',
     default: false,
     surface: 'both',
   },
   ```

   `env` must start with `CLOUD_CODE_EXPERIMENTAL_`, be unique, and not equal `CLOUD_CODE_EXPERIMENTAL_FLAG`; `id` must not be `flag`.
2. Gate at the behavior site with the scoped resolver: `if (!this.experimentalFlags.enabled('my_feature')) return;` — the `FlagId` union autocompletes and type-checks the id.
3. Optionally set a TUI command's `experimentalFlag` to gate its palette entry.
4. Cover gated behavior with tests — resolution is env/config-driven, so construct a resolver with an injected env map and the flag registered.

## Red lines (this topic)

- Gate unreleased behavior behind a registered flag; no ad-hoc `process.env` toggles.
- One catalog: `FLAG_DEFINITIONS`. Do not create parallel registries or scatter env checks.
- Use the scoped resolver threaded from core → session → agent; the process-global `flags` singleton is compatibility-only.
- Env names are the `CLOUD_CODE_EXPERIMENTAL_*` family — this is user-visible surface, so the family name is stable (brand.md).
- `[experimental]` config keys stay loosely typed (`record<string, boolean>`) so removed flags never break config parsing.
