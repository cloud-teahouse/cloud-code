Save a durable memory to the file-based memory system: writes a markdown memory file into a memory directory and records a one-line pointer to it in that directory's `MEMORY.md` index (created when missing). Both indexes are injected into the system prompt at session start, so anything saved here is recallable in future sessions.

When to use:

- The user explicitly asks you to remember something — save it immediately.
- You learn durable user preferences or feedback on how to work ("don't do X", "always do Y" — include the *why* when given), project gotchas, decisions and their rationale, or pointers to external systems (dashboards, trackers, chat channels).

When NOT to use:

- Session state: progress, plans, task tracking. Memory is for what future sessions need.
- Anything derivable from the code, git history, or `AGENTS.md` (architecture, file layout, code patterns) — re-discover it instead of duplicating it.
- Secrets, credentials, or other sensitive values.

Parameters:

- `scope`: `project` (default) writes to `<projectRoot>/.cloud-code/memory/` — memory about this repository. Use `user` for cross-project facts about the user and their preferences.
- `path`: memory file path relative to the memory directory; must end in `.md` and must not be `MEMORY.md`. Subdirectories are allowed (e.g. `feedback/testing.md`).
- `description`: a single line used as the index pointer in `MEMORY.md` — keep it under ~150 characters.
- `content`: the full memory as markdown.

Saving to an existing `path` overwrites the file and refreshes its index line instead of adding a duplicate — prefer updating an existing memory over creating near-duplicates, and remove or rewrite memories that turn out to be wrong. The index is capped (200 lines / 25 KB); if an update would exceed the cap, the save is rejected — consolidate existing entries first. To forget something, delete the memory file and remove its index line with the file tools.
