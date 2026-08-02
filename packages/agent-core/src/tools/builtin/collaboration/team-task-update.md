Update a task on a team's shared task list: move it between statuses, complete it, or reassign it.

Usage notes:
- `team_name` is optional when called from inside a teammate (defaults to that teammate's team); the leader must pass it explicitly.
- A teammate may only update tasks it owns, and cannot reassign ownership; the leader can update any task, including reassigning `owner`.
- Mark a task `completed` as soon as its work is done so the rest of the team sees accurate state. Set `in_progress` when you start an assigned (owner = you) pending task.
- At least one of `status`, `owner`, `subject`, or `description` is required.
