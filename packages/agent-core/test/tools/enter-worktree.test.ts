/**
 * EnterWorktreeTool tests: schema/metadata, and the execute paths over real
 * git repositories (creation, re-attach, not-a-repo, invalid names).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@cloud-code/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EnterWorktreeInputSchema,
  EnterWorktreeTool,
} from '../../src/tools/builtin/worktree/enter-worktree';
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

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudcode-enter-wt-'));
  tempDirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = makeTempDir();
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

describe('EnterWorktreeTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const ctx = testAgent();
    const tool = new EnterWorktreeTool(ctx.agent);
    expect(tool.name).toBe('EnterWorktree');
    expect(tool.description).toContain('isolated git worktree');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' }, base: { type: 'string' } },
    });
  });

  it('accepts valid names and rejects traversal and illegal characters in the schema', () => {
    expect(EnterWorktreeInputSchema.safeParse({}).success).toBe(true);
    expect(EnterWorktreeInputSchema.safeParse({ name: 'feature-x', base: 'main' }).success).toBe(
      true,
    );
    expect(EnterWorktreeInputSchema.safeParse({ name: 'user/feature' }).success).toBe(true);
    for (const name of ['..', '../escape', '/abs', 'has space', 'a+b', 'x'.repeat(65)]) {
      expect(EnterWorktreeInputSchema.safeParse({ name }).success, name).toBe(false);
    }
  });

  it('reports an error outside a git repository', async () => {
    const plainDir = makeTempDir();
    const ctx = await makeAgent(plainDir);

    const result = await executeTool(new EnterWorktreeTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_1',
      args: { name: 'nowhere' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('not inside a git repository');
    expect(ctx.agent.worktree.isActive).toBe(false);
    expect(ctx.agent.config.cwd).toBe(plainDir);
  });

  it('surfaces slug validation errors when the tool layer is reached directly', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);

    const result = await executeTool(new EnterWorktreeTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_2',
      args: { name: '../escape' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('Invalid worktree name');
    expect(ctx.agent.worktree.isActive).toBe(false);
  });

  it('creates the worktree, reports path and branch, and switches the session', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);

    const result = await executeTool(new EnterWorktreeTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_3',
      args: { name: 'tool-enter' },
      signal,
    });

    expect(result).not.toMatchObject({ isError: true });
    const output = (result as { output: string }).output;
    const expectedPath = join(repo, '.cloud-code', 'worktrees', 'tool-enter');
    expect(output).toContain(`Created worktree at ${expectedPath}`);
    expect(output).toContain('worktree-tool-enter');
    expect(output).toContain('The session is now working in the worktree');
    expect(result.display).toMatchObject({
      key: 'toolResult.worktree.enter.created',
      params: { path: expectedPath, branch: 'worktree-tool-enter' },
    });
    expect(ctx.agent.config.cwd).toBe(expectedPath);
  });

  it('generates a random valid name when none is given', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);

    const result = await executeTool(new EnterWorktreeTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_4',
      args: {},
      signal,
    });

    expect(result).not.toMatchObject({ isError: true });
    const name = ctx.agent.worktree.current?.name ?? '';
    expect(name.length).toBeGreaterThan(0);
    expect(() => EnterWorktreeInputSchema.parse({ name })).not.toThrow();
  });

  it('reports re-attach when the worktree already exists', async () => {
    const repo = initRepo();
    const ctx = await makeAgent(repo);
    await ctx.agent.worktree.enter({ name: 'again' });
    await ctx.agent.worktree.exit({ action: 'keep' });

    const result = await executeTool(new EnterWorktreeTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_5',
      args: { name: 'again' },
      signal,
    });

    expect(result).not.toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('Re-attached to existing worktree');
    expect(result.display).toMatchObject({ key: 'toolResult.worktree.enter.resumed' });
  });
});
