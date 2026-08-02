Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- After receiving new multi-step instructions, capture the requirements as todos
- Before starting a tracked task, mark exactly one item as `in_progress`
- Immediately after finishing a tracked task, mark it `done`; do not batch completions at the end

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls — e.g. "fix the typo in the README heading"
- Trivial requests where tracking adds no clarity — e.g. "what does `parseConfig` return?"
- Purely conversational or informational replies
- Work so mechanical that the list would just restate the request — e.g. "rename `foo` to `bar` in this file"

**Examples of when to use the todo list:**

<example>
User: Add a dark mode toggle to the settings page, and make sure the tests pass when you're done.
Assistant: *Creates a todo list: 1. Add the toggle component to the settings page, 2. Wire up theme state management, 3. Add the dark-theme styles, 4. Update existing components for theme switching, 5. Run the test suite and fix any failures — then marks the first item `in_progress` and starts work.*

<reasoning>
The assistant used the todo list because this is a multi-step feature spanning UI, state management, and styles, and the user explicitly asked for tests at the end — capturing "run the tests" as the final item keeps that requirement from being dropped mid-implementation.
</reasoning>
</example>

<example>
User: Rename getCwd to getCurrentWorkingDirectory across the project.
Assistant: *Searches the codebase first, finds 15 occurrences across 8 files, then creates a todo list with one item per file so every occurrence gets updated and none is missed.*

<reasoning>
The assistant searched first to learn the scope, and only then built the list: many occurrences spread across many files make this a systematic multi-step task where an untracked pass would risk missing an instance.
</reasoning>
</example>

<example>
User: Implement user registration, product catalog, shopping cart, and checkout for my shop.
Assistant: *Creates a todo list that breaks each feature into concrete tasks based on the project architecture, then starts on the first registration task.*

<reasoning>
The user handed over several complex features in one message; the todo list turns that bundle into manageable, trackable units and keeps progress visible across the whole implementation.
</reasoning>
</example>

**Examples of when NOT to use the todo list:**

<example>
User: How do I print 'Hello World' in Python?
Assistant: *Answers directly with the one-line snippet and a short explanation.*

<reasoning>
A single trivial question answered in one step — tracking it would add ceremony, not clarity.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: *Explains what git status shows.*

<reasoning>
An informational request with no coding task behind it: there are no steps to organize, so a todo list has nothing to track.
</reasoning>
</example>

<example>
User: Run npm install and tell me what happens.
Assistant: *Runs npm install and summarizes the output.*

<reasoning>
One command with immediate results — a single straightforward action, not a multi-step task.
</reasoning>
</example>

**Avoid churn:**
- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `todos: [...]` to replace the full list. Statuses: pending / in_progress / done.
- Call with no `todos` argument to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Break complex items into smaller, manageable steps rather than tracking one opaque mega-item.
- Update statuses as you make progress.
- When work is underway, keep exactly one task `in_progress`.
- Complete the current task before starting a new one.
- Remove items that are no longer relevant from the list entirely.
- Only mark a task `done` when it is fully accomplished.
- Never mark a task `done` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.
- If you encounter a blocker, keep the blocked task `in_progress` or add a new pending task describing what must be resolved.

**Structured fields (all optional):**
- `id`: stable identifier for the item. Other items reference it in `blockedBy`/`blocks`; it is also the key used to detect created and completed items across writes. Items without an `id` are referenced by their title.
- `activeForm`: present continuous phrase shown in the UI while the item is `in_progress` (e.g. title "Run the test suite" → activeForm "Running the test suite").
- `owner`: who currently owns the item (e.g. a subagent name). Informational only.
- `metadata`: arbitrary key-value data attached to the item. Round-trips through the store untouched.

**Dependencies:**
- `blockedBy: [<id>, ...]` declares that this item cannot start until the referenced items are `done`. An item with unresolved blockers may be listed as `pending` but cannot be set to `in_progress` — the write is rejected with an explanation.
- A blocker resolves the moment the referenced item is `done`; references to items no longer in the list are ignored. There is no separate "unblock" step — completing the blocking item is what unblocks its dependents.
- `blocks: [<id>, ...]` is the advisory mirror of `blockedBy`. Only `blockedBy` gates starting, so keep both sides in sync yourself when you use it.
- Keep dependency graphs small and shallow. Do not model every ordering — only real blockers where starting early would produce wrong or wasted work. Plain list order already communicates sequence.

When in doubt, use this tool — visible progress tracking beats an invisible plan.
