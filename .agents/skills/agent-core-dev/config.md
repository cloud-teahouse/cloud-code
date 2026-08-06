# Topic — Config

How configuration works in `agent-core`: the central zod schema, the TOML on-disk format, env overlays, and the recipe for adding a key. Read this before adding or migrating any configuration.

Config is a TOML file at `~/.cloud-code/config.toml` (`$CLOUD_CODE_HOME` override), parsed by `smol-toml`, validated by zod. Everything lives in `packages/agent-core/src/config/`.

## The central-schema model

Unlike upstream's decentralized section registry, ours is **one schema**:

- `config/schema.ts` — `CloudCodeConfigSchema` is the single source of truth: `providers`, `defaultProvider`, `defaultModel`, `models`, `thinking`, `serviceTier`, `planMode`, `yolo`, `defaultPermissionMode`, `defaultPlanMode`, `permission`, `hooks`, `services`, `outputStyle`, `extraSkillDirs`/`extraAgentDirs`, `loopControl`, `behaviorReminders`, `goal`, `background`, `subagent`, `secondaryModel`, `mcp`, `image`, `snapshot`, `sandbox`, `shellSession`, `guardian`, `debug`, `modelCatalog`, `experimental`, `raw`. A parallel `CloudCodeConfigPatchSchema` (`.strict()`, all-partial) mirrors it for write paths.
- `config/toml.ts` — `readConfigFile()` (salvage-on-error), `readConfigFileForUpdate()` (strict, for read-merge-write), `loadRuntimeConfig()` (on-disk config + env-synthesized models).
- `config/migrations.ts` — persisted-shape upgrades; `print-defaults.ts` renders the default commented template.
- `config/path.ts` — `resolveCloudCodeHome()`; home is created mode `0o700`.

On disk keys are **snake_case**; in memory **camelCase**. Conversion is generic (`snakeToCamel`/`camelToSnake`) — there are no per-key maps to maintain.

## What belongs in config

Config holds **preferences**: values a user or operator *chooses*, with a schema and a default, persistable to `config.toml`. Classify before adding:

| Type | Example | Home |
|---|---|---|
| User preference | model, theme, permission mode | **config.toml** |
| Operational override | `CLOUD_CODE_*` env (legacy `KIMI_*` aliases) | config (env overlay at the consumption site) |
| Per-run intent | CLI `--model` | runtime options, never persisted |
| Session runtime state | active model mid-session, plan mode | session/agent runtime + wire record — **not** config |
| Tuning constant | retry backoffs, buffer sizes | code; promote only when user-tunable |

**Runtime state is not config.** Switching model or thinking level mid-session changes in-memory fields and appends a `config.update` wire record for replay — it never rewrites `config.toml`. Treat the file as the user's static config; runtime overrides live in memory and the session record.

## Env overlays

- `CLOUD_CODE_MODEL_*` family (`config/env-model.ts`) synthesizes a runtime-only provider/model (reserved keys `__kimi_env__` / `__kimi_env_model__`) — **never persisted**. The legacy `KIMI_MODEL_*` names keep working as aliases via `cloudCodeEnv`; the reserved keys keep their old values because they can leak into session records.
- `CLOUD_CODE_MODEL_TEMPERATURE/TOP_P/THINKING_EFFORT` (`config/cloud-code-env-params.ts`) override sampling.
- Generic precedence helper `config/resolve.ts` `resolveConfigValue({ env, envKey, configValue, defaultValue })`: **env > config value > default**. Scattered `CLOUD_CODE_*` vars (e.g. `CLOUD_CODE_DEBUG_CACHE`, `CLOUD_CODE_MCP_*_TIMEOUT_MS`) win over specific config keys.
- Business code reads resolved config; it never parses `process.env` ad hoc.

## The three config files (do not conflate)

| File | Scope | Owner |
|---|---|---|
| `~/.cloud-code/config.toml` | user-global engine config | `packages/agent-core/src/config/` |
| `~/.cloud-code/tui.toml` | TUI preferences (theme, language, `editor.vim_mode`, fullscreen) | `apps/cloud-code/src/tui/config.ts`, own zod schema |
| `<project>/.cloud-code/*` | project-local: `config`-adjacent TOML (`[workspace] additional_dir`), `plugins.json`, `agents/*.md`, `output-styles/` | workspace-local loaders |

There is no full project-level `config.toml`. TUI keys never go into `config.toml`; engine keys never go into `tui.toml`.

## Add a config key (recipe)

1. Add the field to the section's zod schema in `config/schema.ts` — or create a new section schema.
2. Add it to **both** `CloudCodeConfigSchema` and the matching `*PatchSchema` / `CloudCodeConfigPatchSchema` — write paths use the strict patch schema.
3. snake_case mapping and TOML round-trip are automatic; if the on-disk shape needs an upgrade, add a migration in `config/migrations.ts`.
4. If env-overridable, wire `resolveConfigValue` (or the section's established overlay) at the consumption site.
5. Add tests in `packages/agent-core/test/config/`; if the key is user-facing, update the default template in `print-defaults.ts`.

## Red lines (this topic)

- One schema home: `config/schema.ts` — full schema and strict patch schema must move together.
- snake_case on disk, camelCase in memory — never hand-map keys and never write camelCase to disk.
- Runtime state (model switch, plan mode) never rewrites `config.toml`; it lives in memory and the `config.update` wire record.
- Env overlays are resolved at the consumption site via `resolveConfigValue`; no ad-hoc `process.env` reads in business code.
- The `CLOUD_CODE_MODEL_*` env family (legacy `KIMI_MODEL_*` aliases) is runtime-only — never persisted. Reserved `__kimi_env__` keys keep their literal values for session-record compat.
- `tui.toml` and `config.toml` are separate schemas; do not cross-contaminate.
