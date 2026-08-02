Create a durable, structured goal that the runtime will pursue across multiple turns.

Call `CreateGoal` only when:

- the user explicitly asks you to start a goal or work autonomously toward an outcome, or
- a host goal-intake prompt asks you to create one.

Do NOT create a goal for greetings, ordinary questions, or vague requests that lack a
verifiable completion condition. A goal needs a checkable end state.

When the request is vague, ask the user for the missing completion criterion before creating
the goal. If the user clearly insists after you warn them that the wording is vague or risky,
respect that and create the goal.

Include a `completionCriterion` when the user provides one, or when it can be stated without
inventing new requirements. Keep `objective` concise; reference long task descriptions by file
path rather than pasting them.

Set `sizeHint` to your estimate of the goal scope: `small` for a single-file change or one
focused problem, `medium` for a multi-file feature, `large` for a broad refactor or open-ended
research. The tier picks the default turn/token budget caps the goal starts with (when omitted,
the tier is inferred from the objective length). A budget the user states explicitly always
wins over these defaults — never let `sizeHint` override it.

Creating a goal fails if one already exists, so use `replace: true` only when the user explicitly
wants to abandon the current goal and start a new one.
