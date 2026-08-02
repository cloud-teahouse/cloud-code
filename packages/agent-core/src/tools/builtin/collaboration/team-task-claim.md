Claim the next available task from your team's shared task list — the oldest pending task with no owner becomes yours (in_progress, owner = you).

Usage notes:
- Teammates only. Your identity comes from the teammate runtime context, so a claim can never be attributed to someone else, and two teammates racing for the same task can never both win it.
- `team_name` defaults to your own team; you almost never need to pass it.
- The claim returns the task as your work assignment — treat its subject and description as your new objective. When the work is done, mark it completed with TeamTaskUpdate.
- When no task is claimable, the queue is empty or everything is already owned — report back to the leader instead of polling in a loop.
