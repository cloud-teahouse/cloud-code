Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on the worktree created by EnterWorktree in this session. It will NOT touch:

- Worktrees created manually with `git worktree add`
- Worktrees from a different session (even if created by EnterWorktree there)
- The directory you're in if EnterWorktree was never called

If called without an active EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and changes nothing.

## When to use

- The user asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session.
- Do NOT call this proactively — only when the user asks.

## Parameters

- `action` (required): `"keep"` or `"remove"`
  - `"keep"` — leave the worktree directory and its branch on disk. Use this when the work should be revisited later or handed off (the branch can be merged from the original checkout).
  - `"remove"` — delete the worktree directory and its branch. Use this for a clean exit when the work is merged elsewhere or abandoned.
- `discard_changes` (optional, default false): only meaningful with `action: "remove"`. If the worktree has uncommitted files or commits not on the original branch, the tool REFUSES to remove it unless this is `true`. If the tool returns an error listing changes, confirm with the user before re-invoking with `discard_changes: true`.

## Subagent anchors

`action: "remove"` also REFUSES when any subagent (background agent or teammate) still has its working directory inside the worktree — removing the directory would strand it. Stop those agents first, or use `"keep"`. There is no override flag for this gate.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree; all tools follow.
- `"remove"` reports how many uncommitted files and commits were discarded; if git fails to remove the worktree, the session stays inside it and nothing is cleared.
- Once exited, EnterWorktree can be called again for a fresh worktree.
