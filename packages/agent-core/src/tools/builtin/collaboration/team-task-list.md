List the tasks on a team's shared task list, with status and owner for each.

Usage notes:
- `team_name` is optional when called from inside a teammate (defaults to that teammate's team); the leader must pass it explicitly.
- The list is the team's shared work queue: pending tasks with no owner are claimable via TeamTaskClaim; tasks owned by you are your current assignments.
- Check the list before creating tasks to avoid filing duplicates.
