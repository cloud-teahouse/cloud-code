import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatMcpServerInstructions,
  loadAgentsMd,
  prepareSystemPromptContext,
} from '../../src/profile/context';
import { _clearGitStatusSnapshotCacheForTests } from '../../src/session/git-context';
import { testKaos } from '../fixtures/test-kaos';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

let homeDir: string;
let workDir: string;
let extraDirs: string[];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  extraDirs = [];
  vi.spyOn(testKaos, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testKaos, 'getcwd').mockReturnValue(workDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _clearGitStatusSnapshotCacheForTests();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  await Promise.all(extraDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.cloud-code'), { recursive: true });
    await writeFile(join(homeDir, '.cloud-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.cloud-code'), { recursive: true });
    await writeFile(join(homeDir, '.cloud-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});

describe('loadAgentsMd brand home (CLOUD_CODE_HOME)', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
  });

  afterEach(async () => {
    await rm(brandHome, { recursive: true, force: true });
  });

  it('loads the branded AGENTS.md from the brand home and generic from the real home', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand home instructions', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'real home generic', 'utf-8');

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand home instructions');
    expect(result).toContain('real home generic');
  });

  it('ignores the real-home .cloud-code/AGENTS.md when the brand home is elsewhere', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand wins', 'utf-8');
    await mkdir(join(homeDir, '.cloud-code'), { recursive: true });
    await writeFile(join(homeDir, '.cloud-code', 'AGENTS.md'), 'stale real-home brand', 'utf-8');

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand wins');
    expect(result).not.toContain('stale real-home brand');
  });

  it('falls back to the real-home .cloud-code/AGENTS.md when no brand home is given', async () => {
    await mkdir(join(homeDir, '.cloud-code'), { recursive: true });
    await writeFile(join(homeDir, '.cloud-code', 'AGENTS.md'), 'fallback branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('fallback branded');
  });
});

describe('loadAgentsMd oversized content', () => {
  it('keeps the full content when AGENTS.md exceeds the recommended size', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain(largeContent);
    expect(result).not.toContain('truncated or omitted');
  });
});

describe('prepareSystemPromptContext AGENTS.md size warning', () => {
  it('returns agentsMdWarning and keeps full content when oversized', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.agentsMd).toContain(largeContent);
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('exceeds the recommended');
  });

  it('does not return agentsMdWarning when within the recommended size', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.agentsMdWarning).toBeUndefined();
  });
});

describe('prepareSystemPromptContext additional directories', () => {
  it('includes additional directory listings without loading their AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-'));
    extraDirs.push(extraDir);

    await writeFile(join(workDir, 'AGENTS.md'), 'repo project instructions', 'utf-8');
    await writeFile(join(extraDir, 'AGENTS.md'), 'extra project instructions', 'utf-8');
    await writeFile(join(extraDir, 'extra-file.txt'), 'extra listing entry', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      additionalDirs: [extraDir],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.cwdListing).toBeTypeOf('string');
    expect(result.additionalDirsInfo).toContain(`### ${extraDir}`);
    expect(result.additionalDirsInfo).toContain('extra-file.txt');
    expect(agentsMd).toContain('repo project instructions');
    expect(agentsMd).not.toContain('extra project instructions');
    expect(agentsMd.split('<!-- From:').length - 1).toBe(1);
  });

  it('loads user-level AGENTS.md once and skips additional directory AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDirA = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-a-'));
    const extraDirB = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-b-'));
    extraDirs.push(extraDirA, extraDirB);

    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'shared user instructions', 'utf-8');
    await writeFile(join(extraDirA, 'AGENTS.md'), 'extra A instructions', 'utf-8');
    await writeFile(join(extraDirB, 'AGENTS.md'), 'extra B instructions', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      additionalDirs: [extraDirA, extraDirB],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.additionalDirsInfo).toContain(`### ${extraDirA}`);
    expect(result.additionalDirsInfo).toContain(`### ${extraDirB}`);
    expect(agentsMd.split('shared user instructions').length - 1).toBe(1);
    expect(agentsMd).not.toContain('extra A instructions');
    expect(agentsMd).not.toContain('extra B instructions');
  });
});

describe('prepareSystemPromptContext memory', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-mem-brand-'));
    extraDirs.push(brandHome);
  });

  it('returns no memory when neither memory dir exists', async () => {
    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.memory).toBeUndefined();
  });

  it('renders project and user memory indexes, project first', async () => {
    await mkdir(join(workDir, '.cloud-code', 'memory'), { recursive: true });
    await writeFile(join(workDir, '.cloud-code', 'memory', 'MEMORY.md'), '- [Proj](proj.md)', 'utf-8');
    await mkdir(join(brandHome, 'memory'), { recursive: true });
    await writeFile(join(brandHome, 'memory', 'MEMORY.md'), '- [User](user.md)', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.memory).toBeDefined();
    expect(result.memory).toContain('## Project memory');
    expect(result.memory).toContain('- [Proj](proj.md)');
    expect(result.memory).toContain('## User memory');
    expect(result.memory).toContain('- [User](user.md)');
    expect(result.memory!.indexOf('## Project memory')).toBeLessThan(
      result.memory!.indexOf('## User memory'),
    );
  });
});

describe('prepareSystemPromptContext git status snapshot', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-git-brand-'));
    extraDirs.push(brandHome);
  });

  it('leaves gitStatus undefined outside a git repository', async () => {
    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      includeGitStatus: true,
    });

    expect(result.gitStatus).toBeUndefined();
  });

  it('leaves gitStatus undefined in a git repository when the option is off', async () => {
    await git(workDir, 'init', '-b', 'feature-x');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.gitStatus).toBeUndefined();
  });

  it('collects a snapshot naming the current and main branches in a git repository', async () => {
    await git(workDir, 'init', '-b', 'feature-x');

    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      includeGitStatus: true,
    });

    expect(result.gitStatus).toContain('This is the git status at the start of the conversation.');
    expect(result.gitStatus).toContain('Current branch: feature-x');
    // No origin remote and no local main/master — the fallback is 'main'.
    expect(result.gitStatus).toContain('Main branch (you will usually use this for PRs): main');
    expect(result.gitStatus).toContain('Status:\n(clean)');
  });

  it('computes the snapshot once per session and reuses it on refresh', async () => {
    await git(workDir, 'init', '-b', 'feature-x');
    const execSpy = vi.spyOn(testKaos, 'exec');

    const first = await prepareSystemPromptContext(testKaos, brandHome, {
      includeGitStatus: true,
    });
    const probeCount = () =>
      execSpy.mock.calls.filter((args) => args.includes('--is-inside-work-tree')).length;
    expect(probeCount()).toBe(1);

    // A post-compaction (or post-resume, same-process) refresh must render the
    // byte-identical snapshot without re-running git — the system prompt is a
    // stable prefix for prompt caching. (A resumed native session instead
    // replays its persisted system prompt and never re-enters collection.)
    const refreshed = await prepareSystemPromptContext(testKaos, brandHome, {
      includeGitStatus: true,
    });

    expect(refreshed.gitStatus).toBe(first.gitStatus);
    expect(probeCount()).toBe(1);
  });
});

describe('formatMcpServerInstructions', () => {
  it('returns an empty string when no server advertises instructions', () => {
    expect(formatMcpServerInstructions([])).toBe('');
    expect(
      formatMcpServerInstructions([{ name: 'plain', instructions: '   ' }]),
    ).toBe('');
  });

  it('aggregates connected servers into Claude-style blocks', () => {
    const block = formatMcpServerInstructions([
      { name: 'github', instructions: 'Use the GitHub tools for PRs.' },
      { name: 'blank', instructions: ' ' },
      { name: 'db', instructions: 'Read-only queries only.' },
    ]);

    expect(block).toBe('## github\nUse the GitHub tools for PRs.\n\n## db\nRead-only queries only.');
  });
});
