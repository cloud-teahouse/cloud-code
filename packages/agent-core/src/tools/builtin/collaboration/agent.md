Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- Teammates: pass `name` to spawn the agent as a named teammate (optionally with `team_name`). A teammate always runs in the background as a first-class task — you are notified when it completes — and keeps its stable identity across resumes, so you can address the same worker again later by resuming its agent id. Use teammates for long-lived workers you will return to; use plain subagents for one-shot delegation.
- Model selection: the subagent inherits your model by default. Pass `model` with a model alias to run it on a different model, or `model="secondary"` to use the `[secondary_model]` config (falls back to your model when unconfigured; its configured thinking effort applies while the secondary model is in use). An agent type whose profile pins a model ignores `model`.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.
- Subagents use a fixed 30-minute timeout. If one times out, resume the same agent instead of starting over.
- Foreground vs background: run in the foreground (the default) when you need the subagent's result before you can proceed — for example research whose findings inform your next step. Use `run_in_background=true` only when you have genuinely independent work to do in parallel.
- A background subagent notifies you automatically when it completes — do not sleep, poll, or repeatedly check on its progress; continue with other work or respond to the user instead.
- The subagent's outputs should generally be trusted.
- To launch multiple subagents in parallel, send a single message with multiple Agent tool calls — one per subagent — rather than launching them one at a time.

When NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.

Forking with `inherit_context`:
- A normal subagent starts with zero context — that isolation is what keeps your context lean, and it is the right default. Pass `inherit_context=true` to fork instead: the subagent starts with a copy of your full message history as of right now, followed by your prompt. Fork when the task genuinely needs everything you have already learned — a deep dive into something you just researched, or fanning out several workers over findings that would be expensive to re-brief. For self-contained tasks, a fresh subagent with a well-written prompt is cheaper and just as capable.
- Forking always uses the default agent type — omit `subagent_type`. It cannot be combined with `resume` or `name`/`team_name`, is unavailable in coordinator mode (coordinator workers always start fresh), and teammates cannot fork.
- The copy is a snapshot: messages you exchange after the fork starts are not seen by it. Resuming a forked agent continues its own history — it never re-copies your newer messages. (After a session restart, a resumed fork keeps its own turns but not the inherited prefix.)
- The inherited context is real tokens on every request the fork makes — there is no cache shortcut — and a fork of a long conversation may start near the context limit (the fork's own compaction handles that). Fork deliberately, not by default.
