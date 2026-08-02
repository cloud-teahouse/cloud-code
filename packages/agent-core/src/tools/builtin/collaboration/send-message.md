Send a message to a member of a team — the leader ("leader") or a teammate by name — through the team mailbox.

Usage notes:
- `team_name` is optional when called from inside a teammate (defaults to that teammate's team); the leader must pass it explicitly.
- The recipient must be a teammate of the team (spawned with Agent `name` + `team_name`) or "leader". Your own name as sender is taken from the runtime — you cannot send as someone else.
- Delivery: a running teammate receives messages mid-run, injected between steps; the leader receives them as a notification in a later turn. A teammate that is not running gets your message when it next resumes — no need to retry.
- To ask a teammate to shut down, send a structured message with type `shutdown_request` (leader only). The teammate gets a short wrap-up window and its task is then stopped; you are notified when it acknowledges.
- To answer a teammate's permission request, send a structured message with type `permission_response` (leader only) carrying the `request_id` from the request and `approve: true|false`. Unanswered requests time out as rejections, so answer promptly or let the timeout speak.
- For work items, prefer the shared task list (TeamTaskCreate) over chat — assignments there are durable and claimable by the whole team.
