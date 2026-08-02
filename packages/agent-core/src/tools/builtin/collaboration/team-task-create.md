Create a task on a team's shared task list — the work queue teammates pull from with TeamTaskClaim.

Usage notes:
- `team_name` is optional when called from inside a teammate (defaults to that teammate's team); the leader must pass it explicitly.
- Pass `owner` to assign the task to a specific teammate directly (it starts as pending; the assignee moves it to in_progress when starting). Leave `owner` unset to make the task claimable by any teammate through TeamTaskClaim.
- Task ids are per-team increasing integers, never reused — reference tasks as `#N` in subjects and descriptions.
- Use `description` for the full spec: the claiming teammate has not seen this conversation.
