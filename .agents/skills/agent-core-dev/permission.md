# Topic — Permission

The Cloud Code permission system: an ordered policy chain, first hit wins. Read this when touching `agent/permission/`, adding a tool with permission implications, or changing approval UX.

## The one-paragraph mental model

For each tool call, in the current agent and current mode, the chain answers: **allow / deny / ask the user?** `PermissionManager` (`agent/permission/index.ts`, one per `Agent`) holds an ordered `PermissionPolicy[]`; `evaluatePolicies()` iterates in order and the **first non-`undefined` result wins** — ordering *is* the safety model. A policy result is a behavior bundle, not a scalar: `approve` (optionally with execution metadata), `deny` (with a message), or `ask` (carrying the approval round-trip continuations). The agent loop consults the chain from the `authorizeToolExecution` hook in `agent/turn/`.

## The chain (current order)

Built by `createPermissionDecisionPolicies(agent)` in `agent/permission/policies/index.ts`. High-to-low safety cascade:

1. `PreToolCallHookPermissionPolicy` — external hooks may force a decision (`permissionDecision: "ask"` upgrades to human).
2. **Topology hard denies** — `AgentSwarmExclusiveDeny` (AgentSwarm must be the sole tool call in a response), `CoordinatorWorkerSpawnDeny` (coordinator workers cannot spawn Agent/AgentSwarm — the agent graph stays two levels), `TeammateSpawnDeny` (teammates cannot spawn teammates or background agents), `WorktreeTeammateDeny` (teammates cannot enter/exit worktrees). These are harness constraints: hard deny, no ask channel, sitting **above** every approve.
3. `AutoModeAskUserQuestionDeny`.
4. `PlanModeGuardDeny` — plan mode blocks writes outside the plan file.
5. `UserConfiguredDeny` — static deny rules from config.
6. `SessionApprovalHistory` — memorized "approve for session" grants.
7. `GitMutationGate` — graded ask / hard deny for git mutations (`permission.gitMutation` config).
8. `GuardianReview` — in `auto` mode, non-whitelisted actions go to the independent guardian model (see below).
9. `AutoModeApprove` → `UserConfiguredAsk` → `UserConfiguredAllow` → plan/goal/worktree conveniences → `SensitiveFileAccessAsk` / `GitControlPathAccessAsk` → `YoloModeApprove` → `SwarmModeAgentSwarmApprove` (auto-approves AgentSwarm while swarm mode is active) → `DefaultToolApprove` → `GitCwdWriteApprove` → `FallbackAsk`.

Placement rules when adding a policy: structural/harness denies go in group 2 (above `SessionApprovalHistory`, so no memorized approval can unlock them); risk adjudication below user-configured deny/ask; plain approves near the bottom. New *rule specifics* ("also deny `Bash(curl *)`") go through the **data path** — `permission.rules` — not a new policy. The chain encodes dimensions, not tools: adding a tool must not lengthen the chain.

## Modes

`PermissionMode = 'manual' | 'yolo' | 'auto'`. Set at session creation, changed via the `permission.setMode` RPC; defaults come from config (`yolo`, `defaultPermissionMode`). Mode changes are wire records (`permission.set_mode`) so they replay on resume. `yolo` approves nearly everything (`YoloModeApprove`); `auto` routes decisions through the guardian; `manual` asks.

## Rules DSL and matching

`agent/permission/matches-rule.ts`: `parsePattern()` parses the DSL — `Bash(rm *)`, `Read(/etc/**)`, bare `Write` — and `matchPermissionRule()` evaluates it. Compound Bash commands are segmented by the tree-sitter shell AST (`tools/support/shell-ast/`): a deny/ask hit on **any** segment triggers; allow requires **every** segment covered (multiple rules may union-cover); parse failure degrades to whole-string matching. Approving a compound command writes per-segment session rules.

Rule scopes: `turn-override`, `session-runtime`, `project`, `user`. Config schema: `permission.rules` in `config/schema.ts`; rules load as `initialRules` at session creation.

## The ask path

`requestToolApproval()` routes by agent topology:

- Main agent / ordinary subagent → `agent.rpc.requestApproval(...)` — the SDK callback into the TUI approval panel.
- **Teammate** → the leader's mailbox (`MailboxService.requestPermissionViaLeader`): the interaction borrows the leader's approval queue with a `requester` badge; the fallback track is a mailbox `permission_request` → `SendMessage` `permission_response` round-trip with a deterministic timeout-deny. Session grants land on the *requester*, not the leader.
- No channel (headless) → auto-approve.

Outcomes are recorded for replay, and `scope: 'session'` grants become in-memory `SessionApprovalGrant`s; `scope: 'always'` ("Approve always") appends `allow` rules to `permission.rules` in `~/.cloud-code/config.toml` via `persist-always-rules.ts`, degrading to session scope on write failure.

`requestSandboxEscalation()` is a separate **fail-closed** channel: when the sandbox (bubblewrap, `kaos/src/sandbox/`) rejects a Bash command, the heuristic recognizes sandbox denials and offers a one-time human exemption retry. File tools are not sandbox-gated — the policy chain governs them.

## Guardian (auto mode)

`agent/guardian/`, config `[guardian]`: in `auto` mode, non-whitelisted actions are sent to an independent review model (single call, no tools, strict JSON contract). Review failure falls back to human interaction (headless: deny). Circuit breaker: 3 consecutive denials, or 10 in a 50-window, trips back to human for the rest of the turn. Guardian approvals never crystallize into session rules. Assessments are observability records (`guardian.assessment/review_failed/circuit_breaker_tripped`).

## Extending the system

- **New rule specifics** → data path: add `PermissionRule` entries (config or session grants). Chain length unchanged.
- **New permission dimension (behavior)** → code path: a `PermissionPolicy` class under `agent/permission/policies/`, inserted at the correct precedence. Keep `evaluate` pure decision logic; side effects belong to the ask continuations.
- **New rule source** → add a `PermissionRuleScope`, extend the schema, and either pass via `initialRules` or have a policy read it (pattern: `user-configured-rules.ts`).
- **Tool-side** → declare accurate rule matching (`matchesRule`, literal patterns) and read-only-ness; bash-class tools get AST segmentation for free.

## Red lines (this topic)

- First hit wins — ordering is the safety model; a new policy without a deliberate precedence slot is a security bug.
- Harness constraints (topology denies, plan guard) are hard denies above `SessionApprovalHistory`; no approval may unlock them.
- The chain adjudicates risk; user specifics go through the data path (`permission.rules`), not new policies.
- `ask` is a workflow (RPC round-trip, hooks, recorded outcome), not an enum value — do not synthesize asks outside `requestToolApproval`.
- Teammate asks route through the leader bridge; never give a teammate its own interactive channel.
- Sandbox escalation is fail-closed and one-time; never auto-retry a sandbox denial.
- Guardian is advisory within `auto` only; guardian approvals never persist as rules.
- "Approve always" writes through `persist-always-rules.ts` only — never hand-edit `config.toml` from the permission layer.
