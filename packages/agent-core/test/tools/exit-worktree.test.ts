/**
 * ExitWorktreeTool tests: schema/metadata, the no-op scope guard, keep/remove
 * flows, and the dirty-work refusal gate over real git repositories.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@cloud-code/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExitWorktreeInputSchema,
  ExitWorktreeTool,
  type ExitWorktreeInput,
} from '../../src/tools/builtin/worktree/exit-worktree';
import { executeTool } from './fixtures/execute-tool';
import { testAgent, type TestAgentContext } from '../agent/harness/agent';

const signal = new AbortController().signal;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudcode-exit-wt-'));
  tempDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial');
  return dir;
}

async function makeAgent(dir: string): Promise<TestAgentContext> {
  const ctx = testAgent({ kaos: (await LocalKaos.create()).withCwd(dir) });
  ctx.configure();
  ctx.agent.config.update({ cwd: dir });
  return ctx;
}

function call(tool: ExitWorktreeTool, args: ExitWorktreeInput) {
  return executeTool(tool, { turnId: '0', toolCallId: 'tc_exit', args, signal });
}

describe('ExitWorktreeTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const ctx = testAgent();
    const tool = new ExitWorktreeTool(ctx.agent);
    expect(tool.name).toBe('ExitWorktree');
    expect(tool.description).toContain('Exit a worktree session');
    expect(ExitWorktreeInputSchema.safeParse({ action: 'keep' }).success).toBe(true);
    expect(ExitWorktreeInputSchema.safeParse({ action: 'remove', discard_changes: true }).success).toBe(true);
    expect(ExitWorktreeInputSchema.safeParse({ action: 'merge' }).success).toBe(false);
  });

  it('is a no-op error without an active worktree session', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);

    const result = await call(new ExitWorktreeTool(ctx.agent), { action: 'keep' });

    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('No-op');
    expect(ctx.agent.config.cwd).toBe(repo);
  });

  it('keep: restores the original cwd and reports the preserved location', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'exit-keep' });

    const result = await call(new ExitWorktreeTool(ctx.agent), { action: 'keep' });

    expect(result).not.toMatchObject({ isError: true });
    const output = (result as { output: string }).output;
    expect(output).toContain(`Your work is preserved at ${state.path}`);
    expect(output).toContain(`Session is now back in ${repo}`);
    expect(result.display).toEqual({
      key: 'toolResult.worktree.exit.kept',
      params: { path: state.path, branch: state.branch, cwd: repo },
    });
    expect(ctx.agent.config.cwd).toBe(repo);
    expect(existsSync(state.path)).toBe(true);
  });

  it('remove: refuses dirty work and lists the changes, then discards when forced', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'exit-dirty' });
    writeFileSync(join(state.path, 'uncommitted.txt'), 'u\n');
    writeFileSync(join(state.path, 'committed.txt'), 'c\n');
    git(state.path, 'add', 'committed.txt');
    git(state.path, 'commit', '-qm', 'worktree commit');
    const tool = new ExitWorktreeTool(ctx.agent);

    const refused = await call(tool, { action: 'remove' });
    expect(refused).toMatchObject({ isError: true });
    const refusal = (refused as { output: string }).output;
    expect(refusal).toContain('1 uncommitted file');
    expect(refusal).toContain(`1 commit on ${state.branch}`);
    expect(refusal).toContain('discard_changes: true');
    // The refusal made no filesystem changes.
    expect(existsSync(state.path)).toBe(true);
    expect(ctx.agent.worktree.isActive).toBe(true);
    expect(ctx.agent.config.cwd).toBe(state.path);

    const removed = await call(tool, { action: 'remove', discard_changes: true });
    expect(removed).not.toMatchObject({ isError: true });
    const output = (removed as { output: string }).output;
    expect(output).toContain('Discarded 1 commit and 1 uncommitted file');
    expect(output).toContain(`Session is now back in ${repo}`);
    expect(removed.display).toEqual({
      key: 'toolResult.worktree.exit.removedWithDiscards',
      params: { path: state.path, cwd: repo, commits: 1, files: 1 },
    });
    expect(existsSync(state.path)).toBe(false);
    expect(ctx.agent.worktree.isActive).toBe(false);
    expect(ctx.agent.config.cwd).toBe(repo);
  });

  it('remove: refuses when the worktree state cannot be verified', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'exit-gone' });
    rmSync(state.path, { recursive: true, force: true });

    const result = await call(new ExitWorktreeTool(ctx.agent), { action: 'remove' });

    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('Could not verify worktree state');
    expect(ctx.agent.worktree.isActive).toBe(true);
  });

  it('remove: a clean worktree exits without requiring discard_changes', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'exit-clean' });

    const result = await call(new ExitWorktreeTool(ctx.agent), { action: 'remove' });

    expect(result).not.toMatchObject({ isError: true });
    const output = (result as { output: string }).output;
    expect(output).toContain(`Exited and removed worktree at ${state.path}.`);
    expect(output).not.toContain('Discarded');
    expect(result.display).toEqual({
      key: 'toolResult.worktree.exit.removed',
      params: { path: state.path, cwd: repo },
    });
    expect(existsSync(state.path)).toBe(false);
  });

  it('remove: refuses while subagents are anchored inside, succeeds once cleared', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'exit-anchored' });
    let anchors: readonly { agentId: string; teammateName?: string; cwd: string }[] = [
      { agentId: 'agent-1', teammateName: 'alpha', cwd: state.path },
      { agentId: 'agent-2', cwd: join(state.path, 'nested') },
    ];
    Object.defineProperty(ctx.agent, 'subagentHost', {
      value: {
        listAgentsAnchoredAt: async () => anchors,
        // refreshSystemPrompt re-renders the delegatable catalog on exit.
        delegatableSubagents: () => ({}),
      },
      configurable: true,
    });
    const tool = new ExitWorktreeTool(ctx.agent);

    const refused = await call(tool, { action: 'remove' });
    expect(refused).toMatchObject({ isError: true });
    const refusal = (refused as { output: string }).output;
    expect(refusal).toContain('2 subagents are still anchored');
    expect(refusal).toContain('alpha');
    expect(refusal).toContain('action: "keep"');
    expect(refused.display).toEqual({
      key: 'toolResult.worktree.exit.blockedByAgents',
      params: { path: state.path, count: 2, agents: 'alpha, agent-2' },
    });
    expect(existsSync(state.path)).toBe(true);
    expect(ctx.agent.worktree.isActive).toBe(true);

    // keep never consults the anchor gate.
    const kept = await call(tool, { action: 'keep' });
    expect(kept).not.toMatchObject({ isError: true });
    expect(existsSync(state.path)).toBe(true);

    // Anchors cleared (agents stopped) — removal proceeds.
    anchors = [];
    const ctx2 = await makeAgent(repo);
    await ctx2.agent.worktree.enter({ name: 'exit-anchored' });
    Object.defineProperty(ctx2.agent, 'subagentHost', {
      value: {
        listAgentsAnchoredAt: async () => anchors,
        delegatableSubagents: () => ({}),
      },
      configurable: true,
    });
    const removed = await call(new ExitWorktreeTool(ctx2.agent), { action: 'remove' });
    expect(removed).not.toMatchObject({ isError: true });
    expect(existsSync(state.path)).toBe(false);
  });
});
