---
name: check-cloud-code-docs
description: Answer questions about the Cloud Code CLI product and codebase using this repository's own documentation — CLI usage, configuration, architecture, features, and design decisions. Use when the user asks how Cloud Code CLI works, how to set something up, or where a behavior is documented.
---

# Check Cloud Code CLI docs (check-cloud-code-docs)

Answer Cloud Code CLI questions from the documentation in this repository, not from memory. Cloud Code CLI has no hosted documentation site — the repository itself is the single source of truth.

## Where to look

| Question topic | Where to look |
| --- | --- |
| Project overview, repo layout, build/test/lint commands, cross-repo conventions | `AGENTS.md` at the repo root, plus the nested `AGENTS.md` closest to the code in question (e.g. `apps/cloud-code/AGENTS.md`, `packages/agent-core/src/services/AGENTS.md`) |
| Roadmap and landed enhancements | `docs/plan.md` |
| Feature design docs (sandbox, tree-sitter permissions, shadow-git rewind) | `docs/phase2/` |
| Research / porting notes from other coding agents | `docs/research/`, `docs/porting/` |
| What a package or app does | that package's `README.md` (e.g. `apps/cloud-code/README.md`, `packages/agent-core/README.md`) |
| `config.toml` fields: providers, models, thinking, permission, hooks | `packages/agent-core/src/config/schema.ts` — the zod schemas are authoritative for key names, types, and allowed values |
| `tui.toml` fields: theme, editor, notifications, upgrade | `apps/cloud-code/src/tui/config.ts` |
| Theme color tokens for custom themes | `apps/cloud-code/src/tui/theme/theme-schema.json` |

If no row fits the question, Grep the repo for the feature name, config key, or error message.

## How to answer

1. **Read the file before answering** — answer strictly from what you read, never from memory.
2. Cite the file path(s) you used (`path:line`) at the end of the answer.
3. If the repo does not document the behavior, say so plainly and mark which parts of the answer are inferred from code rather than written documentation. **Never invent config keys, command names, model IDs, or product behaviors.**
