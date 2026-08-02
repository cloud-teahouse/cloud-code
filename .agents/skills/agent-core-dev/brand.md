# Topic — Brand

The Cloud Code brand rules and the Moonshot service contract. Read this before touching any user-visible string, env var, file name, credential key, URL, or package metadata. The normative sources are root `AGENTS.md` §品牌与命名 and `docs/rebrand-audit.md` §1; this file restates them.

## The product identity

Cloud Code CLI is an independent product forked from kimi-code:

- Display name **"Cloud Code CLI"**, product **"Cloud Code"**.
- Primary bin `cloudcode`; `cloud-code` is the compatibility alias.
- Config home `~/.cloud-code` (`$CLOUD_CODE_HOME` override).
- Env family `CLOUD_CODE_*`.
- npm package `cloudcode-cli`; workspace packages `@cloud-code/*`.
- Package author remains "Moonshot AI" (attribution, not branding).

**No user-visible surface may contain "Kimi Code" / "kimi-code"** — product name, config dirs, env vars, log/temp file names, skill names, TUI copy, CLI output, error messages, docs, package.json descriptions, default-config comments, i18n dictionaries. Brand-guard tests assert prompts and surfaces stay clean; a leak is a review blocker.

## The Moonshot service contract (DO NOT CHANGE)

These identifiers name the Moonshot **service**, not the product. They are contract-locked: changing them breaks auth, billing, the provider, or the plugin market. If a rebrand touched one of these, that is an "A-bug" — revert it.

- Provider literal `'kimi'`.
- Managed provider key `managed:kimi-code`.
- OAuth credential keys `oauth/kimi-code` and `kimi-code.json`.
- `X-Msh-Platform` header (value `kimi_code_cli`).
- Credential env vars: `KIMI_API_KEY` and the self-consistent runtime env family (`KIMI_MODEL_*`, `KIMI_LOG_LEVEL`, `KIMI_CRON_*`, `KIMI_SUBAGENT_TIMEOUT_MS`, `KIMI_NOW`, `KIMI_USER_LANGUAGE`).
- Model IDs (`kimi-code/kimi-for-coding` etc.).
- Service URLs: `code.kimi.com`, `cdn.kimi.com`, `auth.kimi.com`, `platform.kimi.ai`.

Compatibility-locked formats (changing them breaks the upstream plugin market and historical data):

- Plugin manifests `kimi.plugin.json` / `.kimi-plugin/`.
- Session metadata key `imported_from_kimi_cli`.
- Upstream export manifest field `kimiCodeVersion`.

**Real-name exceptions** — when UI genuinely refers to the upstream product or the Moonshot service itself, the real name stays: `/login` "Kimi Code (OAuth)", `/import` "Kimi Code" import source, "Kimi Platform (API key)", the "Kimi For Coding" subscription name, and official plugin names (Kimi Datasource etc.).

## Classification rules (A/B/C/D)

When you find a `kimi` reference, classify before touching:

- **A — service-contract hit** (the lists above): keep. Wrongly rebranded → revert.
- **B — user-visible brand leak** (TUI copy, CLI output, errors, docs, package descriptions, config comments, log/temp file names, i18n dictionaries): rebrand to Cloud Code unless the real-name exception applies.
- **C — internal identifiers** (class/file names, template variables, prompt XML tags, memory keys — e.g. `KimiChatProvider`, `${KIMI_SKILL_DIR}`, `<kimi-plugin-instructions>`): registered, not changed. Renames are a separate dedicated project, not a drive-by.
- **D — test fixtures/snapshots**: follow the source they mirror.

Decision order: is it contract? → is it user-visible? → does the real-name exception apply? → otherwise fix it. The reverse-mutation check (`managed:cloud-code`, `CLOUD_CODE_API_KEY`, `X-Cloud*`) must yield zero hits — those forms do not exist.

Historical facts stay: the fork attribution in `AGENTS.md` / `NOTICE`, upstream issue references in code comments, and upstream PR/commit links in old `CHANGELOG.md` entries are history, not branding.

## Red lines (this topic)

- Zero user-visible "Kimi Code" / "kimi-code" — except the service contract and the real-name exceptions.
- The service contract list is untouchable: provider literal, managed key, OAuth keys, header, `KIMI_*` env family, model IDs, `*.kimi.com` URLs, locked formats.
- Classify A/B/C/D before any rebrand edit; never batch-rename internal identifiers as a side effect of another change.
- Reverse mutations (`managed:cloud-code`, `CLOUD_CODE_API_KEY`, `X-Cloud*`) are always wrong.
- When porting upstream code, rebrand the B-class strings it carries and preserve every A-class identifier.
