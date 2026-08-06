import type { Kaos } from '@cloud-code/kaos';
import type { ToolCall } from '@cloud-code/kosong';
import * as posixPath from 'node:path/posix';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { buildReplay } from '../../src';
import { PermissionModeInjector } from '../../src/agent/injection/permission-mode';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../src/agent/records';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
  type PermissionPolicyContext,
  type PermissionRule,
} from '../../src/agent/permission';
import {
  matchPermissionRule,
  collectCoveredSubjects,
  parsePattern,
  type PermissionRuleMatchExecution,
} from '../../src/agent/permission/matches-rule';
import { AgentSwarmExclusiveDenyPermissionPolicy } from '../../src/agent/permission/policies/agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicy } from '../../src/agent/permission/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from '../../src/agent/permission/policies/auto-mode-ask-user-question-deny';
import { FallbackAskPermissionPolicy } from '../../src/agent/permission/policies/fallback-ask';
import { createPermissionDecisionPolicies } from '../../src/agent/permission/policies';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from '../../src/agent/permission/policies/swarm-mode-agent-swarm-approve';
import { YoloModeApprovePermissionPolicy } from '../../src/agent/permission/policies/yolo-mode-approve';
import { ToolAccesses } from '../../src/loop';
import { BashTool } from '../../src/tools/builtin/shell/bash';
import { ExecSessionTool } from '../../src/tools/builtin/shell/exec-session';
import { ShellSessionManager } from '../../src/agent/shell-session';
import type { ToolInputDisplay } from '../../src/tools/display';
import {
  literalRulePattern,
  matchesPathRuleSubject,
  matchesGlobRuleSubject,
} from '../../src/tools/support/rule-match';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createBackgroundManager } from './background/helpers';
import { createCommandKaos, testAgent } from './harness/agent';
import { createScriptedGenerate } from './harness/scripted-generate';

describe('Agent permission', () => {
  it('auto mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('auto-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running without asking.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed auto-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in auto mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "auto" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in auto mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in auto mode" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n- Do not insert \`sleep\` between commands that can run immediately — just run them. Never retry a failing command in a sleep loop; diagnose the root cause instead.\\n- If you must poll an external process (for example a CI run), use a check command such as \`gh run view\` rather than sleeping first; if a sleep is unavoidable, keep it short (1-5 seconds) so the user is not blocked.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n\\n**Git operations:**\\n- Mutating git commands (commit, push, reset, rebase, amending, …) ask for user approval by default — if one is denied, do not retry the same mutation or route around it; adjust your approach or ask the user.\\n- Commit only when the user explicitly asks. When asked to commit, first gather state with parallel Bash calls in one response: \`git status\` (never \`-uall\`, which can blow up on large repos), \`git diff\` for staged and unstaged changes, and \`git log\` to match the repository's commit-message style.\\n- Draft a short message focused on the *why*. Do not stage files that likely contain secrets (\`.env\`, credentials) — warn the user if they asked for those. Stage specific files by name; never \`git add -A\` or \`git add .\`, which can sweep in secrets or large binaries.\\n- Pass the commit message via a HEREDOC to preserve formatting:\\n\\n  \`\`\`sh\\n  git commit -m \\"$(cat <<'EOF'\\n  Commit message here.\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Then run \`git status\` after the commit to verify.\\n- Never update the git config, never skip hooks (\`--no-verify\`, \`--no-gpg-sign\`) unless the user explicitly asks, and never use interactive flags (\`git rebase -i\`, \`git add -i\`) — interactive input is not supported.\\n- If a pre-commit hook fails, the commit did NOT happen — fix the issue, re-stage, and create a NEW commit. Never \`--amend\` after a hook failure: it would rewrite the PREVIOUS commit and can destroy work.\\n- For pull requests use the \`gh\` CLI. Before writing the PR, gather in parallel: \`git status\`, \`git diff\`, whether the branch tracks a remote and is up to date, and \`git log\` plus \`git diff <base>...HEAD\` for the full branch history. Review ALL commits going into the PR, not just the latest. Keep the title under 70 characters and pass the body via a HEREDOC with \`## Summary\` and \`## Test plan\` sections:\\n\\n  \`\`\`sh\\n  gh pr create --title \\"the pr title\\" --body \\"$(cat <<'EOF'\\n  ## Summary\\n  <1-3 bullet points>\\n\\n  ## Test plan\\n  <bulleted checklist>\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Return the PR URL when done.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "additionalProperties": false, "properties": { "command": { "description": "The command to execute.", "minLength": 1, "type": "string" }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "exclusiveMinimum": 0, "maximum": 9007199254740991, "type": "integer" } }, "required": [ "command" ], "type": "object" } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running without asking." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running without asking." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "auto-output" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "auto-output" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "auto-output" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 176, "maxContextTokens": 1000000, "contextUsage": 0.000176, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 147, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999828, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed auto-output." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed auto-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 176, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 176, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 176, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 187, "maxContextTokens": 1000000, "contextUsage": 0.000187, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 323, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 323, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 323, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in auto mode"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Running without asking."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "auto-output"
    `);
    await ctx.expectResumeMatches();
  });

  it('yolo mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('yolo-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'Running in yolo mode.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed yolo-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in yolo mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n- Do not insert \`sleep\` between commands that can run immediately — just run them. Never retry a failing command in a sleep loop; diagnose the root cause instead.\\n- If you must poll an external process (for example a CI run), use a check command such as \`gh run view\` rather than sleeping first; if a sleep is unavoidable, keep it short (1-5 seconds) so the user is not blocked.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n\\n**Git operations:**\\n- Mutating git commands (commit, push, reset, rebase, amending, …) ask for user approval by default — if one is denied, do not retry the same mutation or route around it; adjust your approach or ask the user.\\n- Commit only when the user explicitly asks. When asked to commit, first gather state with parallel Bash calls in one response: \`git status\` (never \`-uall\`, which can blow up on large repos), \`git diff\` for staged and unstaged changes, and \`git log\` to match the repository's commit-message style.\\n- Draft a short message focused on the *why*. Do not stage files that likely contain secrets (\`.env\`, credentials) — warn the user if they asked for those. Stage specific files by name; never \`git add -A\` or \`git add .\`, which can sweep in secrets or large binaries.\\n- Pass the commit message via a HEREDOC to preserve formatting:\\n\\n  \`\`\`sh\\n  git commit -m \\"$(cat <<'EOF'\\n  Commit message here.\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Then run \`git status\` after the commit to verify.\\n- Never update the git config, never skip hooks (\`--no-verify\`, \`--no-gpg-sign\`) unless the user explicitly asks, and never use interactive flags (\`git rebase -i\`, \`git add -i\`) — interactive input is not supported.\\n- If a pre-commit hook fails, the commit did NOT happen — fix the issue, re-stage, and create a NEW commit. Never \`--amend\` after a hook failure: it would rewrite the PREVIOUS commit and can destroy work.\\n- For pull requests use the \`gh\` CLI. Before writing the PR, gather in parallel: \`git status\`, \`git diff\`, whether the branch tracks a remote and is up to date, and \`git log\` plus \`git diff <base>...HEAD\` for the full branch history. Review ALL commits going into the PR, not just the latest. Keep the title under 70 characters and pass the body via a HEREDOC with \`## Summary\` and \`## Test plan\` sections:\\n\\n  \`\`\`sh\\n  gh pr create --title \\"the pr title\\" --body \\"$(cat <<'EOF'\\n  ## Summary\\n  <1-3 bullet points>\\n\\n  ## Test plan\\n  <bulleted checklist>\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Return the PR URL when done.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "additionalProperties": false, "properties": { "command": { "description": "The command to execute.", "minLength": 1, "type": "string" }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "exclusiveMinimum": 0, "maximum": 9007199254740991, "type": "integer" } }, "required": [ "command" ], "type": "object" } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running in yolo mode." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running in yolo mode." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "yolo-output" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "yolo-output" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "yolo-output" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 36, "maxContextTokens": 1000000, "contextUsage": 0.000036, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999968, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed yolo-output." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed yolo-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 47, "maxContextTokens": 1000000, "contextUsage": 0.000047, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in yolo mode"

      call 2:
        messages:
          <last>
          assistant: text "Running in yolo mode."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "yolo-output"
    `);
    await ctx.expectResumeMatches();
  });
  it('injects a reminder when leaving auto mode', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Auto turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use auto first' }] });
    await ctx.untilTurnEnd();

    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({ type: 'text', text: 'Manual turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Back to manual' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "manual", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 152, "maxContextTokens": 1000000, "contextUsage": 0.000152, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 145, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 145, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Back to manual" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 1, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Back to manual" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-exit-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999848, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 5, "turnStep": "1.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 1, "delta": "Manual turn done." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "1", "step": 1, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "Manual turn done." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "1", "step": 1, "usage": { "inputOther": 217, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 217, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 217, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 225, "maxContextTokens": 1000000, "contextUsage": 0.000225, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 362, "output": 15, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 362, "output": 15, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 217, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Use auto first"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Auto turn done."
          user: text "Back to manual"
          user: text <auto-mode-exit-reminder>
    `);
    await ctx.expectResumeMatches();
  });

  it('does not execute rejected builtin tools and feeds the rejection back to the LLM', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
    };
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will try Bash.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try to run Bash' }] });
    expect(await ctx.untilApproval(false)).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Try to run Bash" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Try to run Bash" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n- Do not insert \`sleep\` between commands that can run immediately — just run them. Never retry a failing command in a sleep loop; diagnose the root cause instead.\\n- If you must poll an external process (for example a CI run), use a check command such as \`gh run view\` rather than sleeping first; if a sleep is unavoidable, keep it short (1-5 seconds) so the user is not blocked.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n\\n**Git operations:**\\n- Mutating git commands (commit, push, reset, rebase, amending, …) ask for user approval by default — if one is denied, do not retry the same mutation or route around it; adjust your approach or ask the user.\\n- Commit only when the user explicitly asks. When asked to commit, first gather state with parallel Bash calls in one response: \`git status\` (never \`-uall\`, which can blow up on large repos), \`git diff\` for staged and unstaged changes, and \`git log\` to match the repository's commit-message style.\\n- Draft a short message focused on the *why*. Do not stage files that likely contain secrets (\`.env\`, credentials) — warn the user if they asked for those. Stage specific files by name; never \`git add -A\` or \`git add .\`, which can sweep in secrets or large binaries.\\n- Pass the commit message via a HEREDOC to preserve formatting:\\n\\n  \`\`\`sh\\n  git commit -m \\"$(cat <<'EOF'\\n  Commit message here.\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Then run \`git status\` after the commit to verify.\\n- Never update the git config, never skip hooks (\`--no-verify\`, \`--no-gpg-sign\`) unless the user explicitly asks, and never use interactive flags (\`git rebase -i\`, \`git add -i\`) — interactive input is not supported.\\n- If a pre-commit hook fails, the commit did NOT happen — fix the issue, re-stage, and create a NEW commit. Never \`--amend\` after a hook failure: it would rewrite the PREVIOUS commit and can destroy work.\\n- For pull requests use the \`gh\` CLI. Before writing the PR, gather in parallel: \`git status\`, \`git diff\`, whether the branch tracks a remote and is up to date, and \`git log\` plus \`git diff <base>...HEAD\` for the full branch history. Review ALL commits going into the PR, not just the latest. Keep the title under 70 characters and pass the body via a HEREDOC with \`## Summary\` and \`## Test plan\` sections:\\n\\n  \`\`\`sh\\n  gh pr create --title \\"the pr title\\" --body \\"$(cat <<'EOF'\\n  ## Summary\\n  <1-3 bullet points>\\n\\n  ## Test plan\\n  <bulleted checklist>\\n  EOF\\n  )\\"\\n  \`\`\`\\n\\n  Return the PR URL when done.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "additionalProperties": false, "properties": { "command": { "description": "The command to execute.", "minLength": 1, "type": "string" }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "exclusiveMinimum": 0, "maximum": 9007199254740991, "type": "integer" } }, "required": [ "command" ], "type": "object" } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will try Bash." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will try Bash." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Try to run Bash"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'I will not run the command.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "result": { "decision": "rejected", "selectedLabel": "reject" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "Tool \\"Bash\\" was not run because the user rejected the approval request. Do not re-attempt the exact same call — think about why it was rejected, then adjust your approach or ask the user what they would prefer.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "Tool \\"Bash\\" was not run because the user rejected the approval request. Do not re-attempt the exact same call — think about why it was rejected, then adjust your approach or ask the user what they would prefer.", "isError": true }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 82, "maxContextTokens": 1000000, "contextUsage": 0.000082, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                         { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999973, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "300fd6e43b6f379a9c3b20a1cba151a07a3d12e486256f4ed512ab8d05b5d1c0", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "I will not run the command." }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "I will not run the command." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 93, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 93, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 93, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 103, "maxContextTokens": 1000000, "contextUsage": 0.000103, "planMode": false, "swarmMode": false, "coordinatorMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 98, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 98, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 98, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will try Bash."  calls call_bash:Bash { "command": "printf should-not-run", "timeout": 60 }
        tool[call_bash]: text "<system>ERROR: Tool execution failed.</system>\\nTool \\"Bash\\" was not run because the user rejected the approval request. Do not re-attempt the exact same call — think about why it was rejected, then adjust your approach or ask the user what they would prefer."
    `);
    await ctx.expectResumeMatches();
  });
});

describe('Permission auto mode', () => {
  it('tells the agent not to ask questions in auto mode', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'auto' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Do NOT call AskUserQuestion while auto mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
  });

  it('reinjects the auto mode reminder after context compaction', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'auto' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();
    appendSystemReminder.mockClear();
    injector.onContextCompacted();
    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Do NOT call AskUserQuestion while auto mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
  });

  it('keeps the auto mode exit reminder after compaction if the mode changes', async () => {
    const appendSystemReminder = vi.fn();
    const permission = { mode: 'auto' as PermissionMode };
    const agent = {
      permission,
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();
    appendSystemReminder.mockClear();
    injector.onContextCompacted();
    permission.mode = 'manual';
    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Auto permission mode is no longer active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
  });

  it('blocks AskUserQuestion in auto mode before execution', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining(
        'AskUserQuestion is disabled while auto permission mode is active',
      ),
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('allows AskUserQuestion in yolo mode so it can reach question rpc', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)('applies deny rules before %s mode bypass', async (mode) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)(
    'bypasses approval in %s mode without requesting approval',
    async (mode) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('bypasses approval for plan-mode Bash in auto mode', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({
        decision: 'approved',
      }),
      { planModeActive: true },
    );
    manager.setMode('auto');

    await expect(manager.beforeToolCall(hookContext({ id: 'call_plan_bash' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)(
    'does not request approval for default-allowed tools in %s mode',
    async (mode) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_read',
            toolName: 'Read',
            args: { path: '/workspace/notes.md' },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Write', { path: '/tmp/notes.md', content: 'x' }, 'write', 'write file'],
    ['Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }, 'edit', 'edit file'],
  ] as const)(
    'requests approval in manual mode for %s outside the cwd',
    async (toolName, args, operation, action) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode('manual');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName,
          action,
          display: {
            kind: 'file_io',
            operation,
            path: args.path,
          },
        }),
        expect.any(Object),
      );
    },
  );

  it.each([
    ['Write', { path: '/tmp/notes.md', content: 'x' }],
    ['Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }],
  ] as const)('approves %s outside the cwd in yolo mode', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');

    await expect(
      manager.beforeToolCall(hookContext({ id: `call_${toolName}_yolo_outside`, toolName, args })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(
    (['manual', 'yolo'] as const).flatMap((mode) =>
      [
        [mode, 'Read', { path: '/tmp/notes.md' }],
        [mode, 'ReadMediaFile', { path: '/tmp/image.png' }],
        [mode, 'Grep', { pattern: 'TODO', path: '/tmp' }],
      ] as const,
    ),
  )(
    'does not ask in %s mode for %s outside the cwd (read/search are not write)',
    async (mode, toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_${mode}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Read', { path: '/tmp/notes.md' }],
    ['ReadMediaFile', { path: '/tmp/image.png' }],
    ['Write', { path: '/tmp/notes.md', content: 'x' }],
    ['Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }],
  ] as const)('approves %s outside the cwd in auto mode', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['Write', { path: '/workspace/notes.md', content: 'x' }],
    ['Edit', { path: '/workspace/notes.md', old_string: 'a', new_string: 'b' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
  ] as const)(
    'does not request approval for %s inside the workspace in yolo mode',
    async (toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode('yolo');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('approves Grep search outside the cwd in auto mode', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_grep_auto',
          toolName: 'Grep',
          args: { pattern: 'TODO', path: '/tmp' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps explicit deny rules higher priority than yolo outside-workspace approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Read',
      reason: 'reads disabled',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_denied',
          toolName: 'Read',
          args: { path: '/tmp/notes.md' },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Read" was denied by permission rule. Reason: reads disabled',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_bash_ask_allow',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('reuses approve-for-session even when an ask rule still matches the call', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
    });
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_bash_session_after_ask',
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('approves repeated outside-workspace writes in yolo mode without session approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('yolo');
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_session',
          toolName: 'Write',
          args: { path: '/tmp/notes.md', content: 'x' },
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(manager.sessionApprovalRulePatterns).toEqual([]);
    expect(manager.data().rules).toEqual([]);
  });
});

describe('Permission policy chain', () => {
  it('keeps built-in policies in document order', () => {
    expect(createPermissionDecisionPolicies({} as Agent).map((policy) => policy.name)).toEqual([
      'pre-tool-call-hook',
      'agent-swarm-exclusive-deny',
      'coordinator-worker-spawn-deny',
      'teammate-spawn-deny',
      'worktree-teammate-deny',
      'auto-mode-ask-user-question-deny',
      'plan-mode-guard-deny',
      'user-configured-deny',
      'session-approval-history',
      'git-mutation-gate',
      'guardian-review',
      'auto-mode-approve',
      'user-configured-ask',
      'user-configured-allow',
      'exit-plan-mode-review-ask',
      'goal-start-review-ask',
      'plan-mode-tool-approve',
      'worktree-tool-approve',
      'sensitive-file-access-ask',
      'git-control-path-access-ask',
      'yolo-mode-approve',
      'swarm-mode-agent-swarm-approve',
      'default-tool-approve',
      'git-cwd-write-approve',
      'fallback-ask',
    ]);
  });

  it('denies invalid AgentSwarm batches before auto-mode approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.mode = 'auto';
    const agentSwarmCall = toolCall('call_agent_swarm', 'AgentSwarm', {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const readCall = toolCall('call_read', 'Read', { path: 'src/a.ts' });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_agent_swarm',
          toolName: 'AgentSwarm',
          toolCalls: [agentSwarmCall, readCall],
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('AgentSwarm must be the only tool call'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('Simple permission policy direct behavior', () => {
  it('approves only in auto mode for AutoModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new AutoModeApprovePermissionPolicy(agent);

    expect(policy.evaluate()).toBeUndefined();
    Object.assign(agent.permission, { mode: 'auto' });
    expect(policy.evaluate()).toEqual({ kind: 'approve' });
  });

  it('denies AskUserQuestion only in auto mode', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new AutoModeAskUserQuestionDenyPermissionPolicy(agent);

    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_manual',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toBeUndefined();

    Object.assign(agent.permission, { mode: 'auto' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_auto',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_bash_auto',
          toolName: 'Bash',
        }),
      ),
    ).toBeUndefined();
  });

  it('approves only in yolo mode for YoloModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new YoloModeApprovePermissionPolicy(agent);

    expect(policy.evaluate()).toBeUndefined();
    Object.assign(agent.permission, { mode: 'yolo' });
    expect(policy.evaluate()).toEqual({ kind: 'approve' });
  });

  it('approves only AgentSwarm when swarm mode is active', () => {
    const swarmMode = { isActive: false };
    const agent = { swarmMode } as unknown as Agent;
    const policy = new SwarmModeAgentSwarmApprovePermissionPolicy(agent);

    expect(
      policy.evaluate(hookContext({ id: 'call_agent_swarm_inactive', toolName: 'AgentSwarm' })),
    ).toBeUndefined();
    Object.assign(swarmMode, { isActive: true });
    expect(
      policy.evaluate(hookContext({ id: 'call_agent_swarm_active', toolName: 'AgentSwarm' })),
    ).toEqual({ kind: 'approve' });
    expect(
      policy.evaluate(hookContext({ id: 'call_agent_active', toolName: 'Agent' })),
    ).toBeUndefined();
  });

  it('denies AgentSwarm mixed with other tool calls in the same response', () => {
    const policy = new AgentSwarmExclusiveDenyPermissionPolicy();
    const agentSwarmCall = toolCall('call_agent_swarm', 'AgentSwarm', {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const readCall = toolCall('call_read', 'Read', { path: 'src/a.ts' });

    expect(
      policy.evaluate(
        hookContext({
          id: 'call_agent_swarm',
          toolName: 'AgentSwarm',
          toolCalls: [agentSwarmCall, readCall],
        }),
      ),
    ).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('AgentSwarm must be the only tool call'),
      reason: {
        agent_swarm_tool_calls: 1,
        tool_calls: 2,
      },
    });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_read',
          toolName: 'Read',
          args: { path: 'src/a.ts' },
          toolCalls: [agentSwarmCall, readCall],
        }),
      ),
    ).toMatchObject({ kind: 'deny' });
  });

  it('denies multiple AgentSwarm calls with one-at-a-time guidance', () => {
    const policy = new AgentSwarmExclusiveDenyPermissionPolicy();
    const first = toolCall('call_agent_swarm_1', 'AgentSwarm', {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const second = toolCall('call_agent_swarm_2', 'AgentSwarm', {
      description: 'Review tests',
      prompt_template: 'Review {{item}}',
      items: ['test/a.ts', 'test/b.ts'],
    });

    const result = policy.evaluate(
      hookContext({
        id: 'call_agent_swarm_1',
        toolName: 'AgentSwarm',
        toolCalls: [first, second],
      }),
    );

    expect(result).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('Multiple AgentSwarm calls are not forbidden'),
      reason: {
        agent_swarm_tool_calls: 2,
        tool_calls: 2,
      },
    });
    expect(result).toMatchObject({
      message: expect.stringContaining('call one AgentSwarm, wait for its result'),
    });
    expect(result).toMatchObject({
      message: expect.stringContaining('merge the work into a single AgentSwarm'),
    });
  });

  it('allows a single AgentSwarm call for later permission policies', () => {
    const policy = new AgentSwarmExclusiveDenyPermissionPolicy();
    const agentSwarmCall = toolCall('call_agent_swarm', 'AgentSwarm', {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    expect(
      policy.evaluate(
        hookContext({
          id: 'call_agent_swarm',
          toolName: 'AgentSwarm',
          toolCalls: [agentSwarmCall],
        }),
      ),
    ).toBeUndefined();
  });

  it('always asks in FallbackAskPermissionPolicy', () => {
    const policy = new FallbackAskPermissionPolicy();

    expect(policy.evaluate(hookContext({ id: 'call_fallback_direct' }))).toEqual({ kind: 'ask' });
  });
});

describe('PreToolUse permission policy', () => {
  it('blocks before approval', async () => {
    const trigger = vi.fn(async () => [{ action: 'block' as const, reason: 'blocked by hook' }]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_block' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'blocked by hook',
      });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith('PreToolUse', {
      matcherValue: 'Bash',
      signal: expect.any(AbortSignal),
      inputData: {
        toolName: 'Bash',
        toolInput: { command: 'printf first', timeout: 60 },
        toolCallId: 'call_hook_block',
      },
      ifContext: {
        toolName: 'Bash',
        execution: expect.objectContaining({ approvalRule: expect.any(String) }),
      },
    });
  });

  it.each(['auto', 'yolo'] as const)('runs before %s mode bypass', async (mode) => {
    const trigger = vi.fn(async () => [
      { action: 'block' as const, reason: `${mode} hook block` },
    ]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: `call_hook_${mode}` }))).resolves
      .toMatchObject({
        block: true,
        reason: `${mode} hook block`,
      });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('continues through later policies when the hook does not block', async () => {
    const trigger = vi.fn(async () => []);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_allow' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('passes an empty hook input object for non-plain arguments', async () => {
    const trigger = vi.fn(async () => [
      { action: 'block' as const, reason: 'array args blocked' },
    ]);
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }), {
      hooks: { trigger } as unknown as Agent['hooks'],
    });

    await manager.beforeToolCall(
      hookContext({
        id: 'call_array_args',
        toolName: 'Custom',
        args: [] as unknown as Record<string, unknown>,
      }),
    );

    expect(trigger).toHaveBeenCalledWith(
      'PreToolUse',
      expect.objectContaining({
        inputData: {
          toolName: 'Custom',
          toolInput: {},
          toolCallId: 'call_array_args',
        },
      }),
    );
  });

  it('escalates to the approval broker when the hook returns permissionDecision ask', async () => {
    const trigger = vi.fn(async () => [
      { action: 'allow' as const, permissionDecision: 'ask' as const },
    ]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_ask' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('blocks with the rejection message when a hook-asked approval is rejected', async () => {
    const trigger = vi.fn(async () => [
      { action: 'allow' as const, permissionDecision: 'ask' as const },
    ]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'rejected' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_ask_reject' }))).resolves
      .toMatchObject({
        block: true,
        reason: expect.stringContaining('rejected'),
      });

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('rewrites the call args when the hook returns updatedInput', async () => {
    const updatedInput = { command: 'printf rewritten', timeout: 60 };
    const trigger = vi.fn(async () => [{ action: 'allow' as const, updatedInput }]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_rewrite' }))).resolves
      .toEqual({ updatedArgs: updatedInput });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps the updatedInput rewrite when a hook-asked approval is approved', async () => {
    const updatedInput = { command: 'printf rewritten', timeout: 60 };
    const trigger = vi.fn(async () => [
      { action: 'allow' as const, permissionDecision: 'ask' as const, updatedInput },
    ]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(
      manager.beforeToolCall(hookContext({ id: 'call_hook_ask_rewrite' })),
    ).resolves.toEqual({ updatedArgs: updatedInput });

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('lets a deny decision win over a simultaneous ask or updatedInput', async () => {
    const trigger = vi.fn(async () => [
      { action: 'allow' as const, permissionDecision: 'ask' as const },
      { action: 'block' as const, reason: 'deny wins' },
      { action: 'allow' as const, updatedInput: { command: 'printf rewritten' } },
    ]);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { trigger } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_deny_wins' }))).resolves
      .toMatchObject({ block: true, reason: 'deny wins' });

    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('Default tool approve policy', () => {
  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
  ] as const)('approves %s in manual mode without requesting approval', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
  ] as const)('does not default-approve %s', async (toolName, args) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_not_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_auto_question_default',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('AskUserQuestion is disabled'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('Permission live derive', () => {
  it('derives parent mode until the child records a local mode', () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    expect(child.manager.mode).toBe('manual');
    parent.manager.setMode('yolo');
    expect(child.manager.mode).toBe('yolo');
    expect(child.manager.data().mode).toBe('yolo');

    child.manager.setMode('manual');
    parent.manager.setMode('auto');
    expect(child.manager.mode).toBe('manual');
  });

  it('applies rule decision priority across child and parent rules', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent deny',
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });
    child.manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'child allow',
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_parent_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: parent deny',
      });
    expect(child.requestApproval).not.toHaveBeenCalled();

    const parentAllow = makePermissionManager(async () => ({ decision: 'approved' }));
    parentAllow.manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent allow',
    });
    const childDeny = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parentAllow.manager,
    });
    childDeny.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'child deny',
    });

    await expect(childDeny.manager.beforeToolCall(hookContext({ id: 'call_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: child deny',
      });
    expect(childDeny.requestApproval).not.toHaveBeenCalled();
  });

  it('ignores legacy session-runtime rules in user-configured matching', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'legacy approve for session',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_legacy_session_rule' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('falls back to parent rules and session approvals when no child rule matches', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_parent',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_child' }))).resolves
      .toBeUndefined();

    expect(child.requestApproval).not.toHaveBeenCalled();
    expect(child.manager.rules).toEqual([]);
    expect(child.manager.data().rules).toEqual([]);
    expect(child.manager.sessionApprovalRulePatterns).toContain('Bash(printf first)');
  });

  it('uses child local mode for inherited non-deny decisions', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.setMode('yolo');
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_inherited_yolo' }))).resolves
      .toBeUndefined();
    expect(child.requestApproval).not.toHaveBeenCalled();

    child.manager.setMode('manual');
    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_local_manual' }))).resolves
      .toBeUndefined();
    expect(child.requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe('User-configured permission policies', () => {
  it('denies with argument-aware matching and ignores non-matching arguments', async () => {
    const denied = makePermissionManager(async () => ({ decision: 'approved' }));
    denied.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      denied.manager.beforeToolCall(
        hookContext({
          id: 'call_git_denied',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: git is blocked',
    });
    expect(denied.requestApproval).not.toHaveBeenCalled();

    const allowed = makePermissionManager(async () => ({ decision: 'approved' }));
    allowed.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      allowed.manager.beforeToolCall(
        hookContext({
          id: 'call_npm_not_denied',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(allowed.requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ reason: undefined }, 'Tool "Bash" was denied by permission rule.'],
    [{ reason: '' }, 'Tool "Bash" was denied by permission rule.'],
  ] as const)('formats deny messages without an empty reason suffix', async (rule, message) => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: rule.reason,
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_deny_reason' }))).resolves
      .toMatchObject({
        block: true,
        reason: message,
      });
  });

  it('continues past malformed user rule patterns', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *',
      reason: 'malformed rule',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bad_rule' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('uses the first matching deny rule in effective order', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push(
      {
        decision: 'deny',
        scope: 'project',
        pattern: 'Bash(git *)',
        reason: 'project deny',
      },
      {
        decision: 'deny',
        scope: 'user',
        pattern: 'Bash(git status)',
        reason: 'user deny',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_first_deny',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: project deny',
    });
  });

  it('adds sub-agent guidance to user-configured deny messages', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }), {
      agentType: 'sub',
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by parent',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_sub_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: expect.stringContaining("don't retry the same call"),
      });
  });

  it('requests approval for argument-aware ask rules', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash(git *)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_ask_git',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('lets non-matching ask rules fall through to matching allow rules', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash(git *)',
      },
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(npm *)',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_npm',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('falls back to approval when an allow rule argument does not match', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash(git *)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_miss',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each(['turn-override', 'project', 'user'] as const)(
    'matches %s scoped user-configured rules',
    async (scope) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.rules.push({
        decision: 'allow',
        scope,
        pattern: 'Bash',
      });

      await expect(manager.beforeToolCall(hookContext({ id: `call_scope_${scope}` }))).resolves
        .toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );
});

describe('Plan mode tool approve policy', () => {
  it('approves EnterPlanMode in manual mode without requesting approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_enter_plan',
          toolName: 'EnterPlanMode',
          args: {},
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['Write', 'Edit'] as const)(
    'approves %s when it only writes the active plan file',
    async (toolName) => {
      const planFilePath = '/workspace/.kimi/plans/current.md';
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { planModeActive: true, planFilePath },
      );
      const args =
        toolName === 'Write'
          ? { path: planFilePath, content: '# Plan' }
          : { path: planFilePath, old_string: '# Draft', new_string: '# Plan' };

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: `call_${toolName}_plan_approve`,
            toolName,
            args,
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('denies active plan-mode writes that have no file write access', async () => {
    const planFilePath = '/workspace/.kimi/plans/current.md';
    const args = { path: planFilePath, content: '# Plan' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_no_access',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('Plan mode is active'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('approves ExitPlanMode directly when plan mode is inactive', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_inactive',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('approves ExitPlanMode while active when there is no plan review display', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_generic_display',
          toolName: 'ExitPlanMode',
          args: {},
          execution: {
            ...testExecution('ExitPlanMode', {}),
            display: genericDisplay(),
            approvalRule: 'ExitPlanMode',
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('approves ExitPlanMode while active when the plan review is blank', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_blank_plan',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '  \n\t', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('defers non-empty plan reviews to the review approval policy', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_review',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Exited plan mode.'),
      },
    });

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe('Plan mode Bash permission policy', () => {
  it('uses ordinary Bash approval in manual plan mode', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'manual',
      approval: { decision: 'approved' },
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_plan_bash',
          toolName: 'Bash',
          args: { command: 'ls -la', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_plan_bash',
        toolName: 'Bash',
        action: 'run command',
        display: {
          kind: 'command',
          command: 'ls -la',
        },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reuses ordinary Bash approve-for-session in plan mode', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'manual',
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_ordinary_bash',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(ls -la)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_plan_bash',
          toolName: 'Bash',
          args: { command: 'ls -la', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(manager.data().rules).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toContain('Bash(ls -la)');
  });

  it.each(['yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission behavior in plan mode',
    async (mode) => {
      const { manager, requestApproval } = makePlanPermissionManager({
        mode,
        approval: { decision: 'rejected' },
      });

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_plan_bash',
            toolName: 'Bash',
            args: { command: 'rm generated.txt', timeout: 60 },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );
});

describe('ExitPlanMode permission policy', () => {
  const planOptions = [
    { label: 'Approach A', description: 'Use the small change.' },
    { label: 'Approach B', description: 'Use the complete refactor.' },
  ];

  it('allows ExitPlanMode directly in auto mode without requesting approval', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'auto',
      plan: '# Auto Plan',
    });

    const result = await manager.beforeToolCall(
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
    );

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requests plan-review approval in yolo mode and returns formatted output', async () => {
    const { manager, record, requestApproval, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Plan\n\n- Step',
      path: '/tmp/plan.md',
      approval: { decision: 'approved', selectedLabel: 'Approach B' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_exit',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: {
          kind: 'plan_review',
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: undefined,
      result: { decision: 'approved', selectedLabel: 'Approach B' },
    });
    expect(exit).toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Selected approach: Approach B'),
      },
    });
  });

  it('reuses session approval for ExitPlanMode without re-prompting plan review', async () => {
    const { manager, requestApproval, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Updated Plan',
      approval: { decision: 'approved' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'previous_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: 'ExitPlanMode',
      result: { decision: 'approved', scope: 'session' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Updated Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(requestApproval).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('returns a synthetic stop-turn result when the user rejects the plan', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    });
  });

  it('keeps plan mode active when plan approval is cancelled', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'cancelled', feedback: 'dismissed' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
  });

  it('keeps plan mode active when plan approval request fails', async () => {
    const { manager, exit, record } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');

    expect(exit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps plan mode active and returns revision feedback as a synthetic result', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
  });

  it('returns approved plan output without a saved-to line when display has no path', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_no_path',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('## Approved Plan:\n# Draft Plan'),
      },
    });
    expect(result?.syntheticResult?.output).not.toContain('Plan saved to:');
  });

  it('attaches a structured approved outcome with path, choice, and feedback', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved', selectedLabel: 'Approach B', feedback: 'also update the README' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Draft Plan',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        structured: {
          outcome: 'approved',
          chosen: 'Approach B',
          path: '/tmp/plan.md',
          feedback: 'also update the README',
        },
      },
    });
  });

  it('attaches a structured approved outcome without optional fields', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured_bare',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: { structured: { outcome: 'approved' } },
    });
    expect(result?.syntheticResult?.structured).toEqual({ outcome: 'approved' });
  });

  it('attaches a structured rejected outcome on plain rejection', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured_reject',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result?.syntheticResult?.structured).toEqual({ outcome: 'rejected' });
  });

  it('attaches the feedback to the structured outcome on revise-with-feedback', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Revise', feedback: 'Add verification.' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured_feedback',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result?.syntheticResult?.structured).toEqual({
      outcome: 'rejected',
      feedback: 'Add verification.',
    });
    expect(result?.syntheticResult?.display).toBeUndefined();
  });

  it('attaches a structured revise_requested outcome and display ref on bare revise', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Revise' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured_revise',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result?.syntheticResult?.structured).toEqual({ outcome: 'revise_requested' });
    expect(result?.syntheticResult?.display).toEqual({
      key: 'toolResult.exitPlanMode.revisionsRequested',
    });
  });

  it('attaches a structured dismissed outcome and display ref on cancellation', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'cancelled' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_structured_dismissed',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result?.syntheticResult?.structured).toEqual({ outcome: 'dismissed' });
    expect(result?.syntheticResult?.display).toEqual({ key: 'toolResult.exitPlanMode.dismissed' });
  });

  it('does not force a selected-approach prefix for labels that are not in the options', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved', selectedLabel: 'Approach C' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_unknown_option',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Draft Plan',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(result?.syntheticResult?.output).not.toContain('Selected approach:');
  });

  it('returns the exit failure when reject-and-exit cannot leave plan mode', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject and Exit' },
    });
    exit.mockImplementation(() => {
      throw new Error('state transition failure');
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_reject_exit_failure',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        output: 'Failed to exit plan mode: state transition failure',
      },
    });
  });

  it('rethrows approval transport errors', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_approval_error',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');
  });
});

describe('Agent-local approve for session', () => {
  it('turns approved session-scoped responses into an agent-local runtime rule cache', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    const firstArgs = { command: 'printf first', timeout: 60 };
    const firstRule = 'Bash(printf first)';

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: firstRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    expect(manager.data().rules).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toContain(firstRule);

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_2',
          args: firstArgs,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_3',
          args: { command: 'printf second', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('caches session approvals for tools without argument matchers at tool granularity', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_1',
          toolName: 'Custom',
          args: { query: 'first' },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_2',
          toolName: 'Custom',
          args: { query: 'second' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(manager.sessionApprovalRulePatterns).toContain('Custom');
  });

  it('stores runtime rules with literal glob escaping', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_literal',
          args: { command: 'printf *', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_other',
          args: { command: 'printf hello', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('keeps approved once responses one-shot', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();
    await expect(manager.beforeToolCall(hookContext({ id: 'call_2' }))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(1, {
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(record).toHaveBeenNthCalledWith(2, {
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_2',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(manager.data().rules).toEqual([]);
  });

  it('does not let session approval override an explicit deny rule', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
      },
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    const result = await manager.beforeToolCall(hookContext({ id: 'call_1' }));

    expect(result).toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('continues across non-matching and malformed session approval patterns', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_bad_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(unterminated',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_other_session',
      toolName: 'Custom',
      action: 'call custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_matching_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: { decision: 'approved', scope: 'session' },
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_session_match_late' }))).resolves
      .toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not reuse a session approval whose tool name does not match', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_custom_session',
      toolName: 'Custom',
      action: 'call custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bash_no_session' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('replays session approval wire events into agent permission state', () => {
    const ctx = testAgent();
    const sessionApprovalRule = 'Bash(printf first)';

    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    expect(ctx.agent.permission.data().rules).toEqual([]);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
  });

  it('replays one-shot approval wire events without adding session rules', () => {
    const ctx = testAgent();
    const record = {
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      result: {
        decision: 'approved',
        selectedLabel: 'Approve once',
      },
    } as const;

    const event = {
      type: 'permission.record_approval_result',
      ...record,
    } as const;

    ctx.dispatch(event);

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'approval_result',
        record: event,
      }),
    );
    expect(ctx.agent.permission.data().rules).toEqual([]);
  });
});

describe('Approval hooks', () => {
  it('fires observer hooks while waiting for user approval', async () => {
    const trigger = vi.fn(async () => []);
    const fireAndForgetTrigger = vi.fn(async () => []);
    const { manager, requestApproval } = makePermissionManager(
      async () => {
        expect(fireAndForgetTrigger).toHaveBeenCalledWith('PermissionRequest', {
          matcherValue: 'Bash',
          inputData: {
            turnId: 0,
            toolCallId: 'call_approval_hooks',
            toolName: 'Bash',
            action: 'run command',
            toolInput: { command: 'printf first', timeout: 60 },
            display: expect.objectContaining({ kind: 'command' }),
          },
        });
        expect(fireAndForgetTrigger).not.toHaveBeenCalledWith(
          'PermissionResult',
          expect.anything(),
        );
        return {
          decision: 'approved',
          selectedLabel: 'Approve once',
        };
      },
      {
        hooks: { trigger, fireAndForgetTrigger } as unknown as Agent['hooks'],
      },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_approval_hooks' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('PermissionResult', {
      matcherValue: 'Bash',
      inputData: {
        turnId: 0,
        toolCallId: 'call_approval_hooks',
        toolName: 'Bash',
        action: 'run command',
        decision: 'approved',
        selectedLabel: 'Approve once',
        scope: undefined,
        feedback: undefined,
      },
    });
  });

  it('does not fire approval observer hooks without an approval request', async () => {
    const trigger = vi.fn(async () => []);
    const fireAndForgetTrigger = vi.fn(async () => []);
    const { manager, requestApproval } = makePermissionManager(
      async () => ({
        decision: 'approved',
      }),
      {
        approvalRpc: false,
        hooks: { trigger, fireAndForgetTrigger } as unknown as Agent['hooks'],
      },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_no_approval_rpc' }))).resolves
      .toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(fireAndForgetTrigger).not.toHaveBeenCalledWith(
      'PermissionRequest',
      expect.anything(),
    );
    expect(fireAndForgetTrigger).not.toHaveBeenCalledWith(
      'PermissionResult',
      expect.anything(),
    );
  });

  it('blocks the tool when the approval request is cancelled', async () => {
    const { manager } = makePermissionManager(async () => ({
      decision: 'cancelled',
      feedback: 'request closed',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('approval request was cancelled'),
    });
  });
});

describe('Default git CWD Write/Edit permission', () => {
  const DIR_MODE = 0o040_755;
  const FILE_MODE = 0o100_644;
  const SYMLINK_MODE = 0o120_777;

  function statResult(mode: number): Awaited<ReturnType<Kaos['stat']>> {
    return {
      stMode: mode,
      stIno: 1,
      stDev: 1,
      stNlink: 1,
      stUid: 1000,
      stGid: 1000,
      stSize: 0,
      stAtime: 0,
      stMtime: 0,
      stCtime: 0,
    };
  }

  function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  }

  function sshNotFound(path: string): Error {
    const error = Object.assign(new Error(`No such file: ${path}`), { code: 2 });
    error.name = 'KaosFileNotFoundError';
    return error;
  }

  function gitKaos(options: {
    readonly markerPath?: string | undefined;
    readonly markerMode?: number | undefined;
    readonly statModes?: Readonly<Record<string, number>> | undefined;
    readonly readText?: Kaos['readText'] | undefined;
    readonly missingError?: (path: string) => Error;
  } = {}): { kaos: Kaos; stat: ReturnType<typeof vi.fn<Kaos['stat']>> } {
    const markerPath = options.markerPath ?? '/workspace/.git';
    const statModes: Readonly<Record<string, number>> = {
      '/workspace': DIR_MODE,
      '/workspace/src': DIR_MODE,
      [markerPath]: options.markerMode ?? DIR_MODE,
      ...options.statModes,
    };
    const stat = vi
      .fn<Kaos['stat']>()
      .mockImplementation(async (path) => {
        const mode = statModes[path];
        if (mode !== undefined) return statResult(mode);
        throw options.missingError?.(path) ?? notFound(path);
      });
    return {
      kaos: createFakeKaos({ stat, readText: options.readText }),
      stat,
    };
  }

  function nonGitKaos(): Kaos {
    return createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockRejectedValue(new Error('ENOENT')),
    });
  }

  function writeHook(args: Record<string, unknown>, id = 'call_write'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Write', args });
  }

  function editHook(args: Record<string, unknown>, id = 'call_edit'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Edit', args });
  }

  it('still requests approval for Bash inside a git cwd in manual mode', async () => {
    const { kaos, stat } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bash_git_cwd' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        action: 'run command',
      }),
      expect.any(Object),
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('still requests approval for Bash when the cwd is an additionalDir', async () => {
    const { kaos, stat } = gitKaos({
      markerPath: '/extra/.git',
      statModes: { '/extra': DIR_MODE },
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '/extra', kaos, additionalDirs: ['/extra'] },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_bash_additional_dir_cwd',
          args: { command: 'printf from-additional-dir', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        action: 'run command',
      }),
      expect.any(Object),
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('bypasses approval for Write to a relative path inside a git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('bypasses approval for Edit on an absolute path inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        editHook({ path: '/workspace/src/a.ts', old_string: 'A', new_string: 'B' }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['Write', { path: '/extra/src/a.ts', content: 'x' }],
    ['Edit', { path: '/extra/src/a.ts', old_string: 'A', new_string: 'B' }],
  ] as const)('approves %s on an additionalDir path in manual mode', async (toolName, args) => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos, additionalDirs: ['/extra'] },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_${toolName.toLowerCase()}_additional_dir`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('still requests approval when cwd is not inside a git work tree', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos: nonGitKaos() },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('rechecks missing git marker checks across repeated Write/Edit calls in the same cwd', async () => {
    const stat = vi.fn<Kaos['stat']>().mockRejectedValue(new Error('ENOENT'));
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos: createFakeKaos({ stat }) },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' }, 'call_1')),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(
        editHook({ path: 'src/b.ts', old_string: 'A', new_string: 'B' }, 'call_2'),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
    ]);
  });

  it('still requests approval when a relative path escapes cwd via ..', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '../outside.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for an absolute path outside the cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/tmp/outside.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for a shared-prefix path outside additionalDirs', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos, additionalDirs: ['/extra'] },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/extra-evil/outside.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for a path inside the git root but outside the cwd', async () => {
    const { kaos } = gitKaos({ markerPath: '/a/.git' });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '/a/b/c', kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/a/x.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each(['.git/config', '.git/hooks/pre-commit'])(
    'still requests approval for git control file %s',
    async (path) => {
      const { kaos } = gitKaos();
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'x' }))).resolves
        .toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it('still requests approval for a git control file inside an additionalDir', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos, additionalDirs: ['/extra'] },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/extra/.git/config', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for case-variant git control files', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '.GIT/config', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for a linked-worktree gitdir inside cwd', async () => {
    const { kaos } = gitKaos({
      markerMode: FILE_MODE,
      statModes: { '/workspace/.gitdir': DIR_MODE },
      readText: vi.fn<Kaos['readText']>(async (path) => {
        if (path === '/workspace/.git') return 'gitdir: .gitdir\n';
        throw notFound(path);
      }),
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/workspace/.gitdir/config', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not ask for ordinary file access when a git marker exists', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_regular_git_cwd',
          toolName: 'Read',
          args: { path: '/workspace/src/a.ts' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('asks before accessing the .git marker path itself', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_dot_git',
          toolName: 'Read',
          args: { path: '/workspace/.git' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not check git control paths when cwd is empty', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_empty_cwd_git',
          toolName: 'Read',
          args: { path: '/workspace/.git/config' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('detects Win32 .git path components case-insensitively', async () => {
    const kaos = createFakeKaos({ pathClass: () => 'win32' });
    const args = { path: 'C:\\repo\\.GIT\\config' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_git',
          toolName: 'Read',
          args,
          execution: {
            ...testExecution('Read', args),
            accesses: ToolAccesses.readFile('C:\\repo\\.GIT\\config'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'Read',
      { path: '/workspace/src/a.ts' },
      { path: '/workspace/.gitdir/config' },
    ],
    [
      'Grep',
      { pattern: 'TODO', path: '/workspace/src' },
      { pattern: 'TODO', path: '/workspace/.gitdir' },
    ],
    [
      'Glob',
      { pattern: '**/*.ts', path: '/workspace/src' },
      { pattern: '*', path: '/workspace/.gitdir' },
    ],
  ] as const)(
    'rechecks git marker changes before default-approving %s access',
    async (toolName, firstArgs, secondArgs) => {
      let markerReady = false;
      const stat = vi.fn<Kaos['stat']>(async (path) => {
        if (markerReady && path === '/workspace/.git') return statResult(FILE_MODE);
        throw notFound(path);
      });
      const readText = vi.fn<Kaos['readText']>(async (path) => {
        if (path === '/workspace/.git') return 'gitdir: .gitdir\n';
        throw notFound(path);
      });
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos: createFakeKaos({ stat, readText }) },
      );

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_before`, toolName, args: firstArgs })),
      ).resolves.toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();

      markerReady = true;
      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_after`, toolName, args: secondArgs })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it('bypasses approval for a lexical path inside git cwd without resolving parent symlinks', async () => {
    const { kaos } = gitKaos({
      statModes: { '/workspace/out': SYMLINK_MODE },
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'out/hosts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('bypasses approval for a lexical target inside git cwd without resolving target symlinks', async () => {
    const { kaos } = gitKaos({
      statModes: { '/workspace/link.txt': SYMLINK_MODE },
    });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'link.txt', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('still requests approval for a sensitive file inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '.env', content: 'SECRET=1' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for a sensitive file inside an additionalDir', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos, additionalDirs: ['/extra'] },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/extra/.env', content: 'SECRET=1' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each(['.env.local', '.aws/credentials'])(
    'still requests approval for sensitive file %s',
    async (path) => {
      const { kaos } = gitKaos({
        statModes: path.includes('/') ? { '/workspace/.aws': DIR_MODE } : {},
      });
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'secret' }))).resolves
        .toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['src/config.ts', '.env.example', '.env.sample', '.env.template', 'id_rsa.pub'])(
    'does not treat non-sensitive or exempt file %s as sensitive',
    async (path) => {
      const { kaos } = gitKaos({
        statModes: path.includes('/') ? { '/workspace/src': DIR_MODE } : {},
      });
      const { manager, requestApproval } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'x' }))).resolves
        .toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('requests approval for sensitive read access before default approval', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_env',
          toolName: 'Read',
          args: { path: '.env' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('detects sensitive Win32 paths case-insensitively', async () => {
    const kaos = createFakeKaos({ pathClass: () => 'win32' });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_credentials',
          toolName: 'Read',
          args: { path: 'C:\\repo\\.AWS\\Credentials' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('bypasses approval for new files when SSH Kaos reports numeric no-such-file', async () => {
    const { kaos } = gitKaos({ missingError: sshNotFound });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/new.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('lets an explicit `ask` rule keep the approval prompt for Write', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Write',
      reason: 'user requested manual confirmation',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit `allow` rule take the original allow path', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Write',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps explicit `deny` rules higher priority than the bypass', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Write',
      reason: 'no writes here',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('no writes here'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not fire in auto mode because auto-mode-approve takes over', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not fire on Windows path semantics (Windows stMode unverified)', async () => {
    const stat = vi
      .fn<Kaos['stat']>()
      .mockImplementation(async (path) =>
        path === '/workspace/.git'
          ? statResult(0o040_755)
          : Promise.reject(new Error('ENOENT')),
      );
    const kaos = createFakeKaos({ stat, pathClass: () => 'win32' });
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not approve when cwd is empty', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '', kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not approve Write when execution has no write file access', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_no_file_access',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('approves multiple write accesses when all are inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_multi_inside_write',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'readwrite', path: '/workspace/src/b.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not approve when any write access is outside the cwd', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_multi_outside_write',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'write', path: '/tmp/outside.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not approve non-Write/Edit tools even if they report write access', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_write_access',
          toolName: 'Custom',
          args: {},
          execution: {
            ...testExecution('Custom', {}),
            accesses: ToolAccesses.writeFile('/workspace/src/a.ts'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('rechecks git marker hits across repeated Write/Edit calls in the same cwd', async () => {
    const { kaos, stat } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' }, 'call_1')),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(editHook({ path: 'src/b.ts', old_string: 'A', new_string: 'B' }, 'call_2')),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    const markerCalls = stat.mock.calls.filter(([path]) => path === '/workspace/.git');
    expect(markerCalls).toHaveLength(4);
  });
});

describe('Permission rule helpers', () => {
  it('parses permission patterns used by rule matching', () => {
    expect(parsePattern('Write')).toEqual({ toolName: 'Write' });
    expect(parsePattern('Read(/etc/**)')).toEqual({
      toolName: 'Read',
      argPattern: '/etc/**',
    });
    expect(parsePattern('Edit(!./src/**)')).toEqual({
      toolName: 'Edit',
      argPattern: '!./src/**',
    });
    expect(parsePattern('  mcp__github__*  ')).toEqual({ toolName: 'mcp__github__*' });
    expect(parsePattern('Read()')).toEqual({ toolName: 'Read' });
    expect(() => parsePattern('Read(/etc/**')).toThrow(/missing closing paren/);
    expect(() => parsePattern('')).toThrow(/empty string/);
  });

  it('matches rules against the tool-specific argument fields', () => {
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'git status' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'git status'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'npm test' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'npm test'),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read(/etc/**)'), 'Read', { path: '/etc/passwd' }, {
        matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, '/etc/passwd'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './README.md' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/README.md', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './src/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/src/a.ts', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Agent(review-*)'), 'Agent', {
        subagent_type: 'review-code',
      }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'review-code'),
      }),
    ).toBe(true);
    expect(ruleMatches(permissionRule('mcp__github__*'), 'mcp__github__list_issues', {})).toBe(
      true,
    );
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 42 }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, '42'),
      }),
    ).toBe(false);
    expect(ruleMatches(permissionRule('Bad(unclosed'), 'Bad', {})).toBe(false);
  });

  it('does not match rule arguments without an execution matcher', () => {
    expect(
      ruleMatches(permissionRule('Custom("query":"a.b")'), 'Custom', {
        nested: { value: 1 },
        query: 'a.b',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash("command":"git status")'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'npm test',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read([invalid'), 'Read', {
        path: '/workspace/a.ts',
      }),
    ).toBe(false);
    expect(ruleMatches(permissionRule('AgentSwarm(swarm)'), 'AgentSwarm', {})).toBe(false);
  });

  it('treats empty arg patterns as tool-name-only matches', () => {
    expect(ruleMatches(permissionRule('Read()'), 'Read', { path: '/workspace/a.ts' })).toBe(true);
    expect(ruleMatches(permissionRule('Custom()'), 'Custom', { anything: 1 })).toBe(true);
    expect(ruleMatches(permissionRule('Read()'), 'Write', { path: '/workspace/a.ts' })).toBe(false);
  });

  it('matches paths case-insensitively so case-only variants cannot bypass rules', () => {
    expect(
      ruleMatches(permissionRule('Edit(/repo/secrets.env)'), 'Edit', { path: '/repo/Secrets.env' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/Secrets.env', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(/repo/Sub/**)'), 'Edit', { path: '/repo/sub/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/sub/a.ts', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
  });

  it('delegates rule argument semantics to execution.matchesRule when available', () => {
    const execution = {
      matchesRule: vi.fn((ruleArgs: string) => ruleArgs === 'semantic match'),
    };

    expect(
      ruleMatches(permissionRule('Read(semantic match)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(true);
    expect(execution.matchesRule).toHaveBeenCalledWith('semantic match');
    expect(
      ruleMatches(permissionRule('Read(other)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(false);
  });

});

describe('Compound Bash permission (tree-sitter ruleMatch)', () => {
  it('dispatches on rule decision: deny/ask match ∃, allow matches ∀', async () => {
    const execution = await bashRuleMatchExecution('git st && rm x');
    const deny = permissionRule('Bash(rm *)', 'deny');
    const ask = permissionRule('Bash(rm *)', 'ask');
    const allowRm = permissionRule('Bash(rm *)', 'allow');
    const allowGit = permissionRule('Bash(git *)', 'allow');

    expect(matchPermissionRule({ rule: deny, toolName: 'Bash', execution })).toBeDefined();
    expect(matchPermissionRule({ rule: ask, toolName: 'Bash', execution })).toBeDefined();
    // A single allow rule covering only one segment must NOT match.
    expect(matchPermissionRule({ rule: allowRm, toolName: 'Bash', execution })).toBeUndefined();
    expect(matchPermissionRule({ rule: allowGit, toolName: 'Bash', execution })).toBeUndefined();

    const allGit = await bashRuleMatchExecution('git st && git push');
    expect(matchPermissionRule({ rule: allowGit, toolName: 'Bash', execution: allGit })).toBeDefined();
  });

  it('matches negated deny rules per segment', async () => {
    // `ls` is "not rm", so `Bash(!rm *)` fires on the compound even though
    // `echo hi` also matches — ∃ over segments, same as opencode.
    const execution = await bashRuleMatchExecution('ls && echo hi');
    const deny = permissionRule('Bash(!rm *)', 'deny');
    expect(matchPermissionRule({ rule: deny, toolName: 'Bash', execution })).toBeDefined();
  });

  it('collectCoveredSubjects unions allow rules across segments', async () => {
    const execution = await bashRuleMatchExecution('git add . && git push origin main');
    const cover = collectCoveredSubjects({
      rules: [permissionRule('Bash(git add *)'), permissionRule('Bash(git push *)')],
      toolName: 'Bash',
      execution,
    });
    expect(cover?.fullyCovered).toBe(true);
    expect(cover?.firstMatch).toBeDefined();

    const partial = collectCoveredSubjects({
      rules: [permissionRule('Bash(git add *)')],
      toolName: 'Bash',
      execution,
    });
    expect(partial?.fullyCovered).toBe(false);

    // Tool-name-only rules cover every subject.
    const nameOnly = collectCoveredSubjects({
      rules: [permissionRule('Bash')],
      toolName: 'Bash',
      execution,
    });
    expect(nameOnly?.fullyCovered).toBe(true);

    // Executions without ruleMatch opt out of the union path entirely.
    expect(
      collectCoveredSubjects({ rules: [permissionRule('Bash')], toolName: 'Bash', execution: {} }),
    ).toBeUndefined();
  });

  it('does not match bare commands against their own prefix rule (known limitation)', async () => {
    // `git push *` requires a trailing argument, so a bare `git push` is
    // asked again even after approval — inherited from opencode, documented
    // in design §4 alongside the other glob caveats.
    const execution = await bashRuleMatchExecution('git push');
    expect(execution.approvalRules).toEqual(['Bash(git push *)']);
    const cover = collectCoveredSubjects({
      rules: [permissionRule('Bash(git push *)')],
      toolName: 'Bash',
      execution,
    });
    expect(cover?.fullyCovered).toBe(false);
  });

  it('approves a compound command when session rules union-cover all segments', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, ['Bash(git add *)', 'Bash(git push *)']);

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_covered', 'git add . && git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('asks while a segment is uncovered, then approves with a complementary user allow rule', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, ['Bash(git add *)', 'Bash(git push *)']);

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_uncovered', 'git add . && npm i')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    manager.rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(npm *)' });
    await expect(
      manager.beforeToolCall(await compoundHookContext('call_now_covered', 'git add . && npm i')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps deny rules above session-approved coverage', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, ['Bash(git add *)', 'Bash(git push *)']);
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(rm *)',
      reason: 'rm is blocked',
    });

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_deny_wins', 'git add . && rm x')),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: rm is blocked',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('fires ask rules when any segment matches', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({ decision: 'ask', scope: 'user', pattern: 'Bash(rm *)' });

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_ask_segment', 'git status && rm x')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('writes one session rule per segment and replays exact and prefix-matching commands', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    const compound = 'git add . && git push origin main';

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_compound_1', compound)),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.record_approval_result',
        sessionApprovalRule: literalRulePattern('Bash', compound),
        sessionApprovalRules: ['Bash(git add *)', 'Bash(git push *)'],
      }),
    );
    expect(manager.sessionApprovalRulePatterns).toEqual(
      expect.arrayContaining(['Bash(git add *)', 'Bash(git push *)']),
    );

    // Exact replay: no second prompt.
    await expect(
      manager.beforeToolCall(await compoundHookContext('call_compound_2', compound)),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Prefix variant: each segment is covered by its session rule.
    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_compound_3', 'git add src && git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Single command covered by one of the stored prefixes.
    await expect(
      manager.beforeToolCall(await compoundHookContext('call_single', 'git push origin main')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy literal single-command session rules working', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, [literalRulePattern('Bash', 'printf hello')]);

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_legacy_literal', 'printf hello')),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('lets legacy literal compound session rules lapse into a fresh prompt', async () => {
    // Documented tradeoff (design §4): pre-F2 escaped whole-string rules
    // cannot match any single segment, so the user is asked once more and
    // the new approval stores per-segment rules.
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, [literalRulePattern('Bash', 'git add . && git push')]);

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_legacy_compound', 'git add . && git push')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('preserves pre-F2 whole-string semantics for degraded analyses', async () => {
    // The degraded form has a single subject (the whole command), so ∃/∀
    // collapse to the old glob behavior — including its known looseness
    // (`git *` matching the whole compound string), which the AST form fixes.
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(git *)' });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_degraded_loose',
          args: { command: 'git st && rm x', timeout: 60 },
          execution: degradedLikeExecution('git st && rm x'),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();

    // Same rule against the AST form: the uncovered `rm x` segment blocks
    // the allow and the call falls through to a prompt.
    await expect(
      manager.beforeToolCall(await compoundHookContext('call_ast_strict', 'git st && rm x')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe('ExecSession Bash rule namespace', () => {
  async function execSessionExecution(
    command: string,
  ): Promise<PermissionPolicyContext['execution']> {
    const tool = new ExecSessionTool(
      createFakeKaos(),
      '/workspace',
      new ShellSessionManager(createBackgroundManager().manager),
    );
    const execution = await tool.resolveExecution({ command });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    return execution;
  }

  async function execSessionHookContext(
    id: string,
    command: string,
  ): Promise<PermissionPolicyContext> {
    return hookContext({
      id,
      toolName: 'ExecSession',
      args: { command },
      execution: await execSessionExecution(command),
    });
  }

  it('matches rules in the Bash namespace via ruleToolName, not the tool call name', async () => {
    const execution = await execSessionExecution('git push origin main');
    expect(execution.ruleToolName).toBe('Bash');
    expect(execution.approvalRule).toBe(literalRulePattern('Bash', 'git push origin main'));
    expect(execution.approvalRules).toEqual(['Bash(git push *)']);

    // Bash-namespace rules match the ExecSession call…
    expect(
      matchPermissionRule({
        rule: permissionRule('Bash(git push *)'),
        toolName: 'ExecSession',
        execution,
      }),
    ).toBeDefined();
    // …while rules written in the tool's own name do not.
    expect(
      matchPermissionRule({
        rule: permissionRule('ExecSession(git push *)'),
        toolName: 'ExecSession',
        execution,
      }),
    ).toBeUndefined();

    const cover = collectCoveredSubjects({
      rules: [permissionRule('Bash(git push *)')],
      toolName: 'ExecSession',
      execution,
    });
    expect(cover?.fullyCovered).toBe(true);
  });

  it('reuses a session approval across ExecSession and one-shot Bash calls (RFC §3.4)', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));

    // The first session creation asks; the approval stores Bash-namespace rules.
    await expect(
      manager.beforeToolCall(await execSessionHookContext('call_session_1', 'git push origin main')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.record_approval_result',
        toolName: 'ExecSession',
        sessionApprovalRule: literalRulePattern('Bash', 'git push origin main'),
        sessionApprovalRules: ['Bash(git push *)'],
      }),
    );

    // Same-prefix session creation is covered without re-asking.
    await expect(
      manager.beforeToolCall(
        await execSessionHookContext('call_session_2', 'git push origin develop'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // The same grant also covers a one-shot Bash call with the same prefix.
    await expect(
      manager.beforeToolCall(await compoundHookContext('call_bash_covered', 'git push origin develop')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // A different prefix still asks.
    await expect(
      manager.beforeToolCall(await execSessionHookContext('call_session_3', 'git status')),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('lets a user-configured allow Bash(git push *) cover ExecSession creation', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(git push *)' });

    await expect(
      manager.beforeToolCall(
        await execSessionHookContext('call_session_allow', 'git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('honors a user-configured deny in the Bash namespace for ExecSession', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(rm *)',
      reason: 'no rm',
    });

    await expect(
      manager.beforeToolCall(await execSessionHookContext('call_session_deny', 'rm -rf x')),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('no rm'),
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('Git mutation gate policy (C3 P3)', () => {
  async function execSessionGateContext(
    id: string,
    command: string,
  ): Promise<PermissionPolicyContext> {
    const tool = new ExecSessionTool(
      createFakeKaos(),
      '/workspace',
      new ShellSessionManager(createBackgroundManager().manager),
    );
    const execution = await tool.resolveExecution({ command });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    return hookContext({ id, toolName: 'ExecSession', args: { command }, execution });
  }

  function approvalActionOf(requestApproval: ReturnType<typeof vi.fn>): string {
    const request = requestApproval.mock.calls[0]?.[0] as { action?: unknown } | undefined;
    return typeof request?.action === 'string' ? request.action : '';
  }

  it('lets session-approved rules unlock before the gate ever fires', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    seedSessionApprovalRules(manager, ['Bash(git push *)']);

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_gate_session', 'git push origin main')),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('approves straight through when configured allow rules union-cover every segment', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      { decision: 'allow', scope: 'user', pattern: 'Bash(git add *)' },
      { decision: 'allow', scope: 'user', pattern: 'Bash(git push *)' },
    );

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_allow_union', 'git add . && git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('stays out of the way in yolo mode', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.mode = 'yolo';

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_gate_yolo', 'git push origin main')),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('denies fail-closed without an interactive approval channel', async () => {
    const { manager } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { approvalRpc: false },
    );

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_headless', 'git push origin main'),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('no interactive approval channel is available'),
    });
  });

  it('asks with a graded prompt line per git class', async () => {
    const cases = [
      {
        command: 'git push origin main',
        text: 'sends shared state to a remote',
        gitClass: 'shared-remote',
      },
      { command: 'git reset --hard HEAD~1', text: 'rewrites git history', gitClass: 'history-write' },
      { command: 'git commit -m x', text: 'modifies local repository state', gitClass: 'local-write' },
      { command: 'git -c alias.x=!rm co', text: 'inline git config', gitClass: 'config-injection' },
      { command: 'git co', text: 'unknown git subcommand', gitClass: 'unknown' },
    ] as const;
    for (const { command, text, gitClass } of cases) {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      await expect(
        manager.beforeToolCall(await compoundHookContext(`call_gate_${gitClass}`, command)),
      ).resolves.toBeUndefined();
      expect(requestApproval, command).toHaveBeenCalledTimes(1);
      expect(approvalActionOf(requestApproval), command).toContain('Git mutation gate');
      expect(approvalActionOf(requestApproval), command).toContain(text);
    }
  });

  it('names the most consequential class when several segments mutate', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_ranked', 'git commit -m x && git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(approvalActionOf(requestApproval)).toContain('sends shared state to a remote');
  });

  it('catches a sudo-wrapped git mutation via wrapper-stripped classification', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_sudo', 'sudo git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(approvalActionOf(requestApproval)).toContain('sends shared state to a remote');
  });

  it('gates ExecSession creation exactly like a Bash call', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        await execSessionGateContext('call_gate_exec_session', 'git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(approvalActionOf(requestApproval)).toContain('Git mutation gate');
  });

  it('does not touch session transport tools (WriteStdin)', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.mode = 'auto';

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_gate_writestdin',
          toolName: 'WriteStdin',
          args: { session_id: 'session-1', chars: 'git push origin main\n' },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('ignores read-level git commands', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.mode = 'auto';

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_gate_read', 'git status')),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('turns the gate off with git_mutation = "allow"', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cloudCodeConfig: { providers: {}, permission: { gitMutation: 'allow' } } },
    );
    manager.mode = 'auto';

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_gate_off', 'git push origin main')),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('hard-blocks with git_mutation = "deny" and never offers a prompt', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cloudCodeConfig: { providers: {}, permission: { gitMutation: 'deny' } } },
    );

    await expect(
      manager.beforeToolCall(await compoundHookContext('call_gate_deny', 'git push origin main')),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('permission.git_mutation = "deny"'),
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('still honors configured allow rules under git_mutation = "deny"', async () => {
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cloudCodeConfig: { providers: {}, permission: { gitMutation: 'deny' } } },
    );
    manager.rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(git push *)' });

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_deny_exempt', 'git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('Session approval grants (C3 P5)', () => {
  it('records grant metadata, defaulting to the tool-approval surface', () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.recordApprovalResult({
      turnId: 3,
      toolCallId: 'call_grant',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(git push *)',
      result: { decision: 'approved', scope: 'session' },
    });

    expect(manager.sessionApprovalGrants).toEqual([
      {
        pattern: 'Bash(git push *)',
        toolName: 'Bash',
        grantedAtTurnId: 3,
        surface: 'tool-approval',
      },
    ]);
    // The pattern getter derives its keys from the same store.
    expect(manager.sessionApprovalRulePatterns).toEqual(['Bash(git push *)']);
  });

  it('marks grants approved through the git mutation gate with its surface', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));

    await expect(
      manager.beforeToolCall(
        await compoundHookContext('call_gate_grant', 'git add . && git push origin main'),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // One grant per approved segment, both surfaced to the gate.
    expect(manager.sessionApprovalGrants).toEqual([
      {
        pattern: 'Bash(git add *)',
        toolName: 'Bash',
        grantedAtTurnId: 0,
        surface: 'git-mutation-gate',
      },
      {
        pattern: 'Bash(git push *)',
        toolName: 'Bash',
        grantedAtTurnId: 0,
        surface: 'git-mutation-gate',
      },
    ]);
  });

  it('replays wire records into grants, deriving the surface from the recorded action', () => {
    const ctx = testAgent();
    // Pre-P5 record shape: a generic prompt text carries no gate prefix and
    // falls back to the tool-approval surface.
    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 1,
      toolCallId: 'call_old',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(make *)',
      result: { decision: 'approved', scope: 'session' },
    });
    // A gate-approved record is identified by the gate's graded prompt line.
    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 2,
      toolCallId: 'call_gate_replay',
      toolName: 'Bash',
      action:
        'Git mutation gate: this command sends shared state to a remote — pushed refs ' +
        'cannot be taken back. Review the command before approving.',
      sessionApprovalRule: 'Bash(git push *)',
      result: { decision: 'approved', scope: 'session' },
    });

    expect(ctx.agent.permission.sessionApprovalGrants).toEqual([
      { pattern: 'Bash(make *)', toolName: 'Bash', grantedAtTurnId: 1, surface: 'tool-approval' },
      {
        pattern: 'Bash(git push *)',
        toolName: 'Bash',
        grantedAtTurnId: 2,
        surface: 'git-mutation-gate',
      },
    ]);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toEqual([
      'Bash(make *)',
      'Bash(git push *)',
    ]);
  });

  it('stores no grant for one-shot or rejected approvals', () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_once',
      toolName: 'Bash',
      action: 'run command',
      result: { decision: 'approved' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_rejected',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(make *)',
      result: { decision: 'rejected' },
    });

    expect(manager.sessionApprovalGrants).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toEqual([]);
  });
});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf permission-output","timeout":60}',
  };
}

function makePermissionManager(
  handleApproval: (request: unknown) => Promise<ApprovalResponse>,
  options: {
    readonly parent?: PermissionManager | undefined;
    readonly planModeActive?: boolean;
    readonly planFilePath?: string | null | undefined;
    readonly kaos?: Kaos;
    readonly cwd?: string;
    readonly additionalDirs?: readonly string[];
    readonly agentType?: Agent['type'];
    readonly hooks?: Agent['hooks'];
    readonly approvalRpc?: boolean;
    readonly swarmModeActive?: boolean;
    readonly cloudCodeConfig?: Agent['cloudCodeConfig'];
  } = {},
): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  let manager!: PermissionManager;
  const requestApproval = vi.fn(handleApproval);
  const record = vi.fn();
  const agent = {
    type: options.agentType ?? 'main',
    config: { cwd: options.cwd ?? '/workspace' },
    kaos: options.kaos ?? createFakeKaos(),
    cloudCodeConfig: options.cloudCodeConfig,
    getAdditionalDirs: () => options.additionalDirs ?? [],
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: options.approvalRpc === false ? undefined : { requestApproval },
    hooks: options.hooks,
    planMode: {
      get isActive() {
        return options.planModeActive ?? false;
      },
      get planFilePath() {
        return options.planFilePath ?? null;
      },
      data: vi.fn(async () => null),
      exit: vi.fn(),
    },
    swarmMode: {
      get isActive() {
        return options.swarmModeActive ?? false;
      },
    },
  } as unknown as Agent;
  manager = new PermissionManager(agent, options);
  Object.assign(agent, { permission: manager });
  return { manager, record, requestApproval };
}

function makePlanPermissionManager(input: {
  readonly mode: PermissionMode;
  readonly plan?: string | null | undefined;
  readonly path?: string | undefined;
  readonly approval?: ApprovalResponse | undefined;
  readonly approvalError?: Error | undefined;
}): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(async () => {
    if (input.approvalError !== undefined) throw input.approvalError;
    return input.approval ?? { decision: 'approved' };
  });
  const record = vi.fn();
  const exit = vi.fn();
  const path = input.path ?? '/tmp/plan.md';
  const agent = {
    type: 'main',
    config: { cwd: '/workspace' },
    kaos: createFakeKaos(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    planMode: {
      get isActive() {
        return true;
      },
      get planFilePath() {
        return path;
      },
      data: vi.fn(async () => {
        if (input.plan === null) return null;
        return {
          content: input.plan ?? '# Plan',
          path,
        };
      }),
      exit,
    },
    swarmMode: {
      get isActive() {
        return false;
      },
    },
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  manager.mode = input.mode;
  return { manager, record, requestApproval, exit };
}

function hookContext(input: {
  readonly id: string;
  readonly toolName?: string | undefined;
  readonly args?: Record<string, unknown> | undefined;
  readonly execution?: PermissionPolicyContext['execution'] | undefined;
  readonly toolCalls?: readonly ToolCall[] | undefined;
}): PermissionPolicyContext {
  const toolName = input.toolName ?? 'Bash';
  const args = input.args ?? { command: 'printf first', timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id: input.id,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    toolCalls: input.toolCalls ?? [toolCall],
    args,
    execution: input.execution ?? testExecution(toolName, args),
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function permissionRule(
  pattern: string,
  decision: PermissionRule['decision'] = 'allow',
): PermissionRule {
  return {
    decision,
    scope: 'turn-override',
    pattern,
  };
}

function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  args: unknown,
  execution: PermissionRuleMatchExecution = {},
): boolean {
  void args;
  return matchPermissionRule({ rule, toolName, execution }) !== undefined;
}

function genericDisplay(): ToolInputDisplay {
  return { kind: 'generic', summary: 'Approve tool', detail: {} };
}

function planReviewExecution(input: {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly { readonly label: string; readonly description: string }[] | undefined;
}): PermissionPolicyContext['execution'] {
  return {
    description: 'Presenting plan and exiting plan mode',
    display: {
      kind: 'plan_review',
      plan: input.plan,
      path: input.path,
      options: input.options,
    },
    accesses: ToolAccesses.none(),
    approvalRule: 'ExitPlanMode',
    execute: async () => ({ output: '' }),
  };
}

function testExecution(
  toolName: string,
  args: Record<string, unknown>,
): PermissionPolicyContext['execution'] {
  const ruleSubject = testRuleSubject(toolName, args);
  return {
    description: testDescription(toolName, args),
    display: testDisplay(toolName, args),
    accesses: testAccesses(toolName, args),
    approvalRule: ruleSubject === undefined ? toolName : literalRulePattern(toolName, ruleSubject),
    matchesRule:
      ruleSubject === undefined
        ? undefined
        : (ruleArgs) => testMatchesRuleSubject(toolName, ruleArgs, ruleSubject),
    execute: async () => ({ output: '' }),
  };
}

function testRuleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return canonicalTestPath(stringArg(args, 'path', '/workspace/file.txt'));
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function testMatchesRuleSubject(
  toolName: string,
  ruleArgs: string,
  ruleSubject: string,
): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, ruleSubject);
    default:
      return matchesGlobRuleSubject(ruleArgs, ruleSubject);
  }
}

function testDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'ExitPlanMode':
      return 'review plan';
    case 'Read':
      return 'read file';
    case 'ReadMediaFile':
      return 'read media file';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    case 'Grep':
      return `Searching for '${stringArg(args, 'pattern')}' in ${stringArg(args, 'path', '/workspace')}`;
    case 'Glob':
      return `Searching ${stringArg(args, 'pattern')}`;
    default:
      return `call ${toolName}`;
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function testDisplay(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = typeof args['path'] === 'string' ? args['path'] : '/workspace/file.txt';
  switch (toolName) {
    case 'Bash':
      return {
        kind: 'command',
        command: typeof args['command'] === 'string' ? args['command'] : '',
      };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    case 'Grep':
      return { kind: 'file_io', operation: 'grep', path };
    case 'Glob':
      return { kind: 'file_io', operation: 'glob', path };
    default:
      return genericDisplay();
  }
}

function testAccesses(toolName: string, args: Record<string, unknown>) {
  const path = typeof args['path'] === 'string' ? canonicalTestPath(args['path']) : undefined;
  if (toolName === 'Read' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'ReadMediaFile' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'Write' && path !== undefined) return ToolAccesses.writeFile(path);
  if (toolName === 'Edit' && path !== undefined) return ToolAccesses.readWriteFile(path);
  if ((toolName === 'Grep' || toolName === 'Glob') && path !== undefined) {
    return ToolAccesses.searchTree(path);
  }
  return ToolAccesses.none();
}

function canonicalTestPath(path: string): string {
  return posixPath.isAbsolute(path) ? posixPath.normalize(path) : posixPath.resolve('/workspace', path);
}

/** Real BashTool execution for `command` — exercises the tree-sitter ruleMatch path end to end. */
async function bashRuleMatchExecution(
  command: string,
): Promise<PermissionPolicyContext['execution']> {
  const tool = new BashTool(
    createFakeKaos(),
    '/workspace',
    createBackgroundManager().manager,
    {},
  );
  const execution = await tool.resolveExecution({ command, timeout: 60 });
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution;
}

async function compoundHookContext(id: string, command: string): Promise<PermissionPolicyContext> {
  return hookContext({
    id,
    args: { command, timeout: 60 },
    execution: await bashRuleMatchExecution(command),
  });
}

function seedSessionApprovalRules(
  manager: PermissionManager,
  patterns: readonly string[],
): void {
  manager.recordApprovalResult({
    turnId: 0,
    toolCallId: 'seed',
    toolName: 'Bash',
    action: 'run command',
    sessionApprovalRule: patterns[0],
    sessionApprovalRules: patterns,
    result: { decision: 'approved', scope: 'session' },
  });
}

/** The degraded analysis form: one subject (the whole command), one literal rule. */
function degradedLikeExecution(command: string): PermissionPolicyContext['execution'] {
  return {
    description: 'run command',
    approvalRule: literalRulePattern('Bash', command),
    approvalRules: [literalRulePattern('Bash', command)],
    matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, command),
    ruleMatch: {
      subjects: [command],
      matches: (ruleArgs, subject) => matchesGlobRuleSubject(ruleArgs, subject),
    },
    execute: async () => ({ output: '' }),
  };
}

/* ------------------------------------------------------------------ */
/*  Guardian AI approval reviewer (F3) — integration through the       */
/*  policy chain with the scripted-generate harness.                   */
/* ------------------------------------------------------------------ */

describe('Guardian review policy', () => {
  function guardianBashCall(command: string, id = 'call_guardian_bash'): ToolCall {
    return {
      type: 'function',
      id,
      name: 'Bash',
      arguments: JSON.stringify({ command, timeout: 60 }),
    };
  }

  function wireEvents(ctx: ReturnType<typeof testAgent>, name: string) {
    return ctx.allEvents.filter(
      (event) => event.type === '[wire]' && event.event === name,
    ) as Array<{ readonly args: Record<string, unknown> }>;
  }

  function guardianReviewCalls(ctx: ReturnType<typeof testAgent>) {
    return ctx.llmCalls.filter((call) => call.tools.length === 0);
  }

  function guardianReviewPromptText(ctx: ReturnType<typeof testAgent>): string {
    const call = guardianReviewCalls(ctx)[0];
    if (call === undefined) throw new Error('expected a guardian review call');
    return call.history
      .map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
      )
      .join('\n');
  }

  it('approves a reviewed action without writing a session rule (auto mode)', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('guardian-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running it.' }, guardianBashCall('printf hi'));
    ctx.mockNextResponse({ type: 'text', text: '{"outcome":"allow"}' });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run the command' }] });
    await ctx.untilTurnEnd();

    // The reviewer was consulted exactly once, through agent.generate.
    expect(guardianReviewCalls(ctx)).toHaveLength(1);
    // The command ran.
    const results = ctx.allEvents.filter(
      (event) => event.type === '[rpc]' && event.event === 'tool.result',
    );
    expect(JSON.stringify(results)).toContain('guardian-ok');
    // Wire: assessment logged with the allow outcome; llm.request carries
    // kind 'guardian' and points at the empty-tools snapshot.
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.assessment')[0]!.args).toMatchObject({
      toolName: 'Bash',
      outcome: 'allow',
      riskLevel: 'low',
      userAuthorization: 'unknown',
      model: 'mock-model',
    });
    const guardianRequests = wireEvents(ctx, 'llm.request').filter(
      (event) => event.args['kind'] === 'guardian',
    );
    expect(guardianRequests).toHaveLength(1);
    const emptyToolsSnapshot = wireEvents(ctx, 'llm.tools_snapshot').find(
      (event) => Array.isArray(event.args['tools']) && event.args['tools'].length === 0,
    );
    expect(emptyToolsSnapshot).toBeDefined();
    expect(guardianRequests[0]!.args['toolsHash']).toBe(emptyToolsSnapshot!.args['hash']);
    // An AI grant is one-shot: no human approval record, no session rule.
    expect(wireEvents(ctx, 'permission.record_approval_result')).toHaveLength(0);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toEqual([]);
    // Replay of the wire (guardian records included) has no side effects.
    await ctx.expectResumeMatches();
  });

  it('blocks a denied action with rationale and anti-circumvention instructions', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not run'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      // git_mutation = "allow": the gate is off, so the mutation reaches the
      // guardian (design doc §5 — the default "ask" would route it to a
      // human prompt before the review).
      initialConfig: {
        providers: {},
        guardian: { enabled: true },
        permission: { gitMutation: 'allow' },
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'Pushing.' },
      guardianBashCall('git push --force'),
    );
    ctx.mockNextResponse({
      type: 'text',
      text: '{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Force-push could destroy unpushed work."}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Understood, stopping.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'push it' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(wireEvents(ctx, 'guardian.assessment')[0]!.args).toMatchObject({
      outcome: 'deny',
      riskLevel: 'high',
    });
    const results = JSON.stringify(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'tool.result'),
    );
    expect(results).toContain('rejected due to unacceptable risk');
    expect(results).toContain('Force-push could destroy unpushed work.');
    expect(results).toContain('must not attempt to achieve the same outcome via workaround');
  });

  it('recovers an assessment wrapped in prose', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('prose-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf prose'));
    ctx.mockNextResponse({
      type: 'text',
      text: 'Thinking out loud here.\n{"outcome":"allow","rationale":"Benign print."}\nDone.',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Finished.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(wireEvents(ctx, 'guardian.assessment')[0]!.args).toMatchObject({
      outcome: 'allow',
      rationale: 'Benign print.',
    });
    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(0);
  });

  it('falls back to human approval on a malformed review (interactive)', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('human-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf human'));
    ctx.mockNextResponse({ type: 'text', text: 'I cannot produce JSON today.' });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.review_failed')[0]!.args).toMatchObject({
      failureKind: 'parse',
      fallback: 'ask',
    });
    // The human decision flows through the normal approval record.
    expect(wireEvents(ctx, 'permission.record_approval_result')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.circuit_breaker_tripped')).toHaveLength(0);
  });

  it('falls back to human approval on a review timeout (interactive)', async () => {
    const scripted = createScriptedGenerate();
    const ctx = testAgent({
      kaos: createCommandKaos('timeout-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true, timeoutMs: 25 } },
      generate: (provider, systemPrompt, tools, history, callbacks, options) => {
        if (tools.length === 0) {
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('review deadline'));
            });
          });
        }
        return scripted.generate(provider, systemPrompt, tools, history, callbacks, options);
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    scripted.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf t'));
    scripted.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    expect(wireEvents(ctx, 'guardian.review_failed')[0]!.args).toMatchObject({
      failureKind: 'timeout',
      fallback: 'ask',
    });
  });

  it('trips the circuit breaker after three consecutive denials and stops reviewing', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('breaker-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    const deny = (rationale: string) =>
      ({ type: 'text', text: `{"outcome":"deny","rationale":"${rationale}"}` }) as const;
    ctx.mockNextResponse({ type: 'text', text: 'one' }, guardianBashCall('rm -rf a', 'c1'));
    ctx.mockNextResponse(deny('first'));
    ctx.mockNextResponse({ type: 'text', text: 'two' }, guardianBashCall('rm -rf b', 'c2'));
    ctx.mockNextResponse(deny('second'));
    ctx.mockNextResponse({ type: 'text', text: 'three' }, guardianBashCall('rm -rf c', 'c3'));
    ctx.mockNextResponse(deny('third'));
    ctx.mockNextResponse({ type: 'text', text: 'four' }, guardianBashCall('printf ok', 'c4'));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'clean up' }] });

    // The fourth action is not reviewed — the breaker tripped on the third
    // denial, so it falls back to a human.
    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(3);
    expect(wireEvents(ctx, 'guardian.circuit_breaker_tripped')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.circuit_breaker_tripped')[0]!.args).toMatchObject({
      turnId: 0,
      consecutiveDenials: 3,
      windowDenials: 3,
    });
    const warnings = ctx.allEvents.filter(
      (event) => event.type === '[rpc]' && event.event === 'warning',
    );
    expect(JSON.stringify(warnings)).toContain('guardian-circuit-breaker-tripped');
  });

  it('never trips the breaker on repeated review failures', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('fail-soft'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    for (let i = 1; i <= 3; i++) {
      ctx.mockNextResponse(
        { type: 'text', text: `try ${String(i)}` },
        guardianBashCall(`printf ${String(i)}`, `f${String(i)}`),
      );
      ctx.mockNextResponse({ type: 'text', text: 'garbage, not json' });
    }
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run three' }] });

    // Each failed review falls back to a human; approve all three.
    for (let i = 0; i < 3; i++) {
      const approval = await ctx.takeApprovalRequest();
      approval.respond({ decision: 'approved' });
    }
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(3);
    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(3);
    expect(wireEvents(ctx, 'guardian.circuit_breaker_tripped')).toHaveLength(0);
    expect(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'warning'),
    ).toHaveLength(0);
  });

  it('does nothing when guardian is disabled (regression baseline)', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('plain-auto') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf plain'));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(guardianReviewCalls(ctx)).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(0);
    await ctx.expectResumeMatches();
  });

  it('does not review in manual mode', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('manual-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf m'));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
  });

  it('does not review in yolo mode', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('yolo-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf y'));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
  });

  it('passes default-approved read-only tools through without a review', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['TaskList'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'Checking.' },
      { type: 'function', id: 'call_tasks', name: 'TaskList', arguments: '{}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'list tasks' }] });
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
  });

  it('keeps user-configured deny rules ahead of the guardian', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not run'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      initialConfig: { providers: {}, guardian: { enabled: true } },
      permission: {
        initialRules: [{ decision: 'deny', scope: 'turn-override', pattern: 'Bash(rm *)' }],
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Deleting.' }, guardianBashCall('rm -rf x'));
    ctx.mockNextResponse({ type: 'text', text: 'Stopped.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'delete it' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(guardianReviewCalls(ctx)).toHaveLength(0);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
  });

  it('does not re-review a command the human approved for the session', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('session-grant-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    // First call: the review fails → human fallback → approve for session.
    // Second call (same command): the session grant must short-circuit
    // before the guardian — no second review, no second prompt.
    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf human', 'c1'));
    ctx.mockNextResponse({ type: 'text', text: 'not json' });
    ctx.mockNextResponse({ type: 'text', text: 'Again.' }, guardianBashCall('printf human', 'c2'));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it twice' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    });
    await ctx.untilTurnEnd();

    // Exactly one review (the failed first one) and one approval prompt.
    expect(guardianReviewCalls(ctx)).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(0);
    expect(wireEvents(ctx, 'permission.record_approval_result')).toHaveLength(1);
    expect(ctx.agent.permission.sessionApprovalRulePatterns.length).toBeGreaterThan(0);
    // Both commands ran.
    const results = JSON.stringify(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'tool.result'),
    );
    expect(results.match(/session-grant-ok/g)).toHaveLength(2);
  });

  it('still reviews a command the human approved for once only', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('once-only-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    // Same shape as above, but the human approves the fallback for ONCE:
    // nothing is memorized, so the repeat call goes back to the guardian.
    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf once', 'c1'));
    ctx.mockNextResponse({ type: 'text', text: 'not json' });
    ctx.mockNextResponse({ type: 'text', text: 'Again.' }, guardianBashCall('printf once', 'c2'));
    ctx.mockNextResponse({ type: 'text', text: '{"outcome":"allow"}' });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it twice' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'approved' });
    await ctx.untilTurnEnd();

    expect(guardianReviewCalls(ctx)).toHaveLength(2);
    expect(wireEvents(ctx, 'guardian.review_failed')).toHaveLength(1);
    expect(wireEvents(ctx, 'guardian.assessment')).toHaveLength(1);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toEqual([]);
    const results = JSON.stringify(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'tool.result'),
    );
    expect(results.match(/once-only-ok/g)).toHaveLength(2);
  });

  it('sends compound-command segments in the review action JSON (F2)', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not run'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      // git_mutation = "allow": `git add` is a local-write mutation that the
      // default gate would intercept before the guardian ever sees it.
      initialConfig: {
        providers: {},
        guardian: { enabled: true },
        permission: { gitMutation: 'allow' },
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'Committing.' },
      guardianBashCall('git add . && rm -rf /'),
    );
    ctx.mockNextResponse({
      type: 'text',
      text: '{"risk_level":"critical","outcome":"deny","rationale":"One segment deletes the filesystem root."}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Stopped.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'commit and clean' }] });
    await ctx.untilTurnEnd();

    const prompt = guardianReviewPromptText(ctx);
    expect(prompt).toContain('"segments": [');
    expect(prompt).toContain('git add .');
    expect(prompt).toContain('rm -rf /');
    expect(prompt).toContain('"ast_degraded": false');
    // The whole call is blocked when the reviewer denies any segment.
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(wireEvents(ctx, 'guardian.assessment')[0]!.args).toMatchObject({ outcome: 'deny' });
  });

  it('marks AST-degraded commands in the review action JSON', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('degraded-ok'),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('((('));
    ctx.mockNextResponse({ type: 'text', text: '{"outcome":"allow"}' });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(guardianReviewPromptText(ctx)).toContain('"ast_degraded": true');
  });

  it('denies fail-closed when a review fails without an approval channel (headless)', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not run'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      initialConfig: { providers: {}, guardian: { enabled: true } },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    // Headless: keep event emission, drop the approval channel.
    const rpc = ctx.agent.rpc as { emitEvent?: unknown } | undefined;
    (ctx.agent as unknown as { rpc?: unknown }).rpc = { emitEvent: rpc?.emitEvent };

    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf h'));
    ctx.mockNextResponse({ type: 'text', text: 'not json either' });
    ctx.mockNextResponse({ type: 'text', text: 'Understood.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(wireEvents(ctx, 'guardian.review_failed')[0]!.args).toMatchObject({
      failureKind: 'parse',
      fallback: 'deny',
    });
    const results = JSON.stringify(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'tool.result'),
    );
    expect(results).toContain('no interactive approval channel is available');
    expect(results).not.toContain('rejected due to unacceptable risk');
  });

  it('uses timeout-specific feedback for a headless review timeout', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not run'));
    const scripted = createScriptedGenerate();
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      initialConfig: { providers: {}, guardian: { enabled: true, timeoutMs: 25 } },
      generate: (provider, systemPrompt, tools, history, callbacks, options) => {
        if (tools.length === 0) {
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('review deadline'));
            });
          });
        }
        return scripted.generate(provider, systemPrompt, tools, history, callbacks, options);
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    const rpc = ctx.agent.rpc as { emitEvent?: unknown } | undefined;
    (ctx.agent as unknown as { rpc?: unknown }).rpc = { emitEvent: rpc?.emitEvent };

    scripted.mockNextResponse({ type: 'text', text: 'Running.' }, guardianBashCall('printf x'));
    scripted.mockNextResponse({ type: 'text', text: 'Understood.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run it' }] });
    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(wireEvents(ctx, 'guardian.review_failed')[0]!.args).toMatchObject({
      failureKind: 'timeout',
      fallback: 'deny',
    });
    const results = JSON.stringify(
      ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'tool.result'),
    );
    // The timeout copy must not read like an explicit reviewer denial.
    expect(results).toContain('did not finish before its deadline');
    expect(results).toContain('Do not assume the action is unsafe based on the timeout alone');
    expect(results).not.toContain('rejected due to unacceptable risk');
  });

  it('replays guardian records as UI state only, without re-reviewing', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'guardian.assessment',
        turnId: 0,
        toolCallId: 'c1',
        toolName: 'Bash',
        outcome: 'deny',
        riskLevel: 'high',
        userAuthorization: 'low',
        rationale: 'Too risky.',
        model: 'mock-model',
        durationMs: 12,
      },
      {
        type: 'guardian.review_failed',
        turnId: 0,
        toolCallId: 'c2',
        toolName: 'Bash',
        failureKind: 'timeout',
        fallback: 'deny',
        durationMs: 30_000,
      },
      {
        type: 'guardian.circuit_breaker_tripped',
        turnId: 0,
        consecutiveDenials: 3,
        windowDenials: 3,
      },
    ]);

    const replay = await buildReplay(persistence);

    expect(replay).toEqual([
      expect.objectContaining({
        type: 'guardian_assessment',
        record: expect.objectContaining({ outcome: 'deny', rationale: 'Too risky.' }),
      }),
    ]);
  });
});
