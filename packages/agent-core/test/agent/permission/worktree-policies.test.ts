/**
 * Worktree permission policies: the teammate topology deny, the approval
 * posture (enter + keep approve; remove falls through), and the cwd-follow
 * of git-cwd-write-approve across an EnterWorktree switch.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@cloud-code/kaos';
import type { ToolCall } from '@cloud-code/kosong';
import { afterEach, describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { GitCwdWriteApprovePermissionPolicy } from '../../../src/agent/permission/policies/git-cwd-write-approve';
import { WorktreeTeammateDenyPermissionPolicy } from '../../../src/agent/permission/policies/worktree-teammate-deny';
import { WorktreeToolApprovePermissionPolicy } from '../../../src/agent/permission/policies/worktree-tool-approve';
import { ToolAccesses } from '../../../src/loop';
import { testAgent } from '../harness/agent';

const signal = new AbortController().signal;

function policyContext(
  toolName: string,
  args: Record<string, unknown> = {},
  accesses: PermissionPolicyContext['execution']['accesses'] = ToolAccesses.none(),
): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    execution: {
      accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('WorktreeTeammateDenyPermissionPolicy', () => {
  const fakeAgent = (isTeammate: boolean) => ({ isTeammate }) as never;

  it('denies EnterWorktree and ExitWorktree for teammates', () => {
    const policy = new WorktreeTeammateDenyPermissionPolicy(fakeAgent(true));
    for (const toolName of ['EnterWorktree', 'ExitWorktree']) {
      const result = policy.evaluate(policyContext(toolName));
      expect(result?.kind, toolName).toBe('deny');
      if (result?.kind !== 'deny') throw new Error('expected deny');
      expect(result.message).toContain('Teammates cannot enter or exit worktrees');
      expect(result.reason).toEqual({ teammate_worktree_switch: true });
    }
  });

  it('ignores other tools and non-teammate agents', () => {
    const policy = new WorktreeTeammateDenyPermissionPolicy(fakeAgent(true));
    expect(policy.evaluate(policyContext('Bash'))).toBeUndefined();
    const leaderPolicy = new WorktreeTeammateDenyPermissionPolicy(fakeAgent(false));
    expect(leaderPolicy.evaluate(policyContext('EnterWorktree'))).toBeUndefined();
    expect(leaderPolicy.evaluate(policyContext('ExitWorktree'))).toBeUndefined();
  });
});

describe('WorktreeToolApprovePermissionPolicy', () => {
  const agent = {} as never;

  it('approves EnterWorktree', () => {
    const policy = new WorktreeToolApprovePermissionPolicy(agent);
    expect(policy.evaluate(policyContext('EnterWorktree', { name: 'x' }))?.kind).toBe('approve');
  });

  it('approves ExitWorktree keep but not remove', () => {
    const policy = new WorktreeToolApprovePermissionPolicy(agent);
    expect(policy.evaluate(policyContext('ExitWorktree', { action: 'keep' }))?.kind).toBe(
      'approve',
    );
    expect(
      policy.evaluate(policyContext('ExitWorktree', { action: 'remove' })),
    ).toBeUndefined();
    expect(
      policy.evaluate(
        policyContext('ExitWorktree', { action: 'remove', discard_changes: true }),
      ),
    ).toBeUndefined();
  });

  it('reads the action from the wire arguments when parsed args are absent', () => {
    const policy = new WorktreeToolApprovePermissionPolicy(agent);
    const keepContext = { ...policyContext('ExitWorktree', { action: 'keep' }), args: undefined };
    const removeContext = { ...policyContext('ExitWorktree', { action: 'remove' }), args: undefined };
    expect(policy.evaluate(keepContext)?.kind).toBe('approve');
    expect(policy.evaluate(removeContext)).toBeUndefined();
  });
});

describe('permission path evaluation across the cwd switch', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git-cwd-write-approve follows the session cwd into the worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cloudcode-wt-policy-'));
    tempDirs.push(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');

    // Start the session inside a FOREIGN worktree of the repo: the worktree
    // this test creates then lives under the main checkout, outside the
    // session's original workspace — the only setup where the cwd switch
    // changes what "inside the workspace" means.
    const foreign = mkdtempSync(join(tmpdir(), 'cloudcode-wt-foreign-'));
    tempDirs.push(foreign);
    git(repo, 'worktree', 'add', '-q', '-b', 'foreign-branch', foreign, 'HEAD');

    const ctx = testAgent({ kaos: (await LocalKaos.create()).withCwd(foreign) });
    ctx.configure();
    ctx.agent.config.update({ cwd: foreign });
    const policy = new GitCwdWriteApprovePermissionPolicy(ctx.agent);
    const worktreeFile = join(repo, '.cloud-code', 'worktrees', 'policy-wt', 'a.txt');
    const writeContext = (path: string) =>
      policyContext('Write', { path }, ToolAccesses.writeFile(path));

    // Before the switch, the target path is outside the session workspace:
    // this policy abstains.
    expect(await policy.evaluate(writeContext(worktreeFile))).toBeUndefined();

    await ctx.agent.worktree.enter({ name: 'policy-wt' });

    // After the switch the same path is inside the session workspace of a
    // git work tree: approved without asking.
    expect((await policy.evaluate(writeContext(worktreeFile)))?.kind).toBe('approve');
  });
});
