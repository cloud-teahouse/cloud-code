Use this tool when the user asks to work in a worktree, or when the task clearly benefits from an isolated checkout. This tool creates an isolated git worktree and switches the current session into it — every subsequent tool call (Bash, Read, Write, Edit, Grep, Glob) runs inside the worktree.

## When worktrees help

- Parallel feature branches: develop a feature in isolation while the original checkout stays on its current branch — no stash/switch dance, no cross-contamination between efforts.
- Risky refactors or experiments: sweep changes, dependency upgrades, or throwaway spikes that must not touch the user's working tree until proven.
- Side-by-side verification: run the test suite or build in the worktree while the original checkout keeps serving another purpose.

## When NOT to use

- The user asks to create or switch branches — use git commands instead.
- Ordinary bug fixes or features on the current branch — the normal git workflow is enough; do not pay the isolation cost unprompted.

## Behavior

- Creates a new git worktree at `<main-repo>/.cloud-code/worktrees/<name>/` on a new branch `worktree-<name>` based on `base` (default: current `HEAD`). The worktree starts clean from that commit; uncommitted changes and untracked files in the original checkout are NOT carried over (gitignored files listed in a `.worktreeinclude` file at the repo root, and `.cloud-code/local.toml`, are copied over).
- A worktree created earlier under the same `name` is re-attached as-is instead of being recreated.
- Switches the session's working directory into the worktree and reports the path and branch.
- Use ExitWorktree to leave mid-session (keep or remove). If the session ends while still inside, the worktree stays on disk with its branch, and resuming the session restores the worktree state.

## Requirements

- Must be inside a git repository (submodules and linked worktrees are handled).
- Must not already be inside a worktree created by this session.

## Parameters

- `name` (optional): a name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars. A random name is generated if omitted.
- `base` (optional): the git ref to start the worktree branch from (branch, tag, or commit). Defaults to `HEAD`.
