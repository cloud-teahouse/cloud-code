import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadMemoryForPrompt,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  resolveMemoryDirs,
  truncateEntrypointContent,
} from '../../src/memory';
import { testKaos } from '../fixtures/test-kaos';

let homeDir: string;
let workDir: string;
let brandHome: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'cloudcode-mem-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'cloudcode-mem-work-'));
  brandHome = await mkdtemp(join(tmpdir(), 'cloudcode-mem-brand-'));
  vi.spyOn(testKaos, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testKaos, 'getcwd').mockReturnValue(workDir);
  // A plain `.git` dir is enough — project-root discovery only stats it.
  await mkdir(join(workDir, '.git'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  await rm(brandHome, { recursive: true, force: true });
});

async function writeProjectIndex(content: string): Promise<void> {
  const dir = join(workDir, '.cloud-code', 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf-8');
}

async function writeUserIndex(content: string): Promise<void> {
  const dir = join(brandHome, 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf-8');
}

describe('resolveMemoryDirs', () => {
  it('resolves the project dir at the git root when cwd is a subdirectory', async () => {
    const sub = join(workDir, 'packages', 'foo');
    await mkdir(sub, { recursive: true });
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(sub);

    const dirs = await resolveMemoryDirs(testKaos, brandHome);

    expect(dirs.project).toBe(join(workDir, '.cloud-code', 'memory'));
    expect(dirs.user).toBe(join(brandHome, 'memory'));
  });

  it('falls back to the work dir outside a git repository', async () => {
    await rm(join(workDir, '.git'), { recursive: true, force: true });

    const dirs = await resolveMemoryDirs(testKaos, brandHome);

    expect(dirs.project).toBe(join(workDir, '.cloud-code', 'memory'));
  });

  it('falls back to ~/.cloud-code when no brand home is given', async () => {
    const dirs = await resolveMemoryDirs(testKaos);

    expect(dirs.user).toBe(join(homeDir, '.cloud-code', 'memory'));
  });
});

describe('loadMemoryForPrompt', () => {
  it('returns undefined when neither memory dir exists', async () => {
    expect(await loadMemoryForPrompt(testKaos, brandHome)).toBeUndefined();
  });

  it('renders only the scopes that exist', async () => {
    await writeProjectIndex('- [Proj](proj.md)');

    const projectOnly = await loadMemoryForPrompt(testKaos, brandHome);
    expect(projectOnly).toContain('## Project memory');
    expect(projectOnly).toContain('- [Proj](proj.md)');
    expect(projectOnly).not.toContain('## User memory');

    await rm(join(workDir, '.cloud-code'), { recursive: true, force: true });
    await writeUserIndex('- [User](user.md)');

    const userOnly = await loadMemoryForPrompt(testKaos, brandHome);
    expect(userOnly).toContain('## User memory');
    expect(userOnly).toContain('- [User](user.md)');
    expect(userOnly).not.toContain('## Project memory');
  });

  it('renders project memory before user memory with their index paths', async () => {
    await writeProjectIndex('- [Proj](proj.md)');
    await writeUserIndex('- [User](user.md)');

    const result = await loadMemoryForPrompt(testKaos, brandHome);

    expect(result).toBeDefined();
    expect(result!.indexOf('## Project memory')).toBeLessThan(result!.indexOf('## User memory'));
    expect(result).toContain(join(workDir, '.cloud-code', 'memory', 'MEMORY.md'));
    expect(result).toContain(join(brandHome, 'memory', 'MEMORY.md'));
  });

  it('renders an empty marker when the index is missing or blank', async () => {
    await mkdir(join(workDir, '.cloud-code', 'memory'), { recursive: true });

    const missing = await loadMemoryForPrompt(testKaos, brandHome);
    expect(missing).toContain('## Project memory');
    expect(missing).toContain('(empty');

    await writeProjectIndex('  \n\n');

    const blank = await loadMemoryForPrompt(testKaos, brandHome);
    expect(blank).toContain('(empty');
  });

  it('caps an oversized index and keeps the warning marker', async () => {
    const lines = Array.from({ length: 210 }, (_, i) => `- [Entry ${String(i)}](e${String(i)}.md)`);
    await writeProjectIndex(lines.join('\n'));

    const result = await loadMemoryForPrompt(testKaos, brandHome);

    expect(result).toContain('- [Entry 199](e199.md)');
    expect(result).not.toContain('- [Entry 200](e200.md)');
    expect(result).toContain(`WARNING: MEMORY.md is 210 lines (limit: ${String(MAX_ENTRYPOINT_LINES)})`);
  });

  it('renders byte-identically across loads when the files are unchanged', async () => {
    await writeProjectIndex('- [Proj](proj.md)');
    await writeUserIndex('- [User](user.md)');

    const first = await loadMemoryForPrompt(testKaos, brandHome);
    const second = await loadMemoryForPrompt(testKaos, brandHome);

    expect(second).toBe(first);
  });
});

describe('truncateEntrypointContent', () => {
  it('returns under-cap content trimmed but intact', () => {
    const result = truncateEntrypointContent('\n- [a](a.md)\n- [b](b.md)\n\n');

    expect(result).toMatchObject({
      content: '- [a](a.md)\n- [b](b.md)',
      lineCount: 2,
      wasLineTruncated: false,
      wasByteTruncated: false,
    });
  });

  it('truncates at the line cap and names it', () => {
    const raw = Array.from({ length: 250 }, (_, i) => `line ${String(i)}`).join('\n');

    const result = truncateEntrypointContent(raw);

    expect(result.wasLineTruncated).toBe(true);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.content).toContain('line 199');
    expect(result.content).not.toContain('line 200');
    expect(result.content).toContain(`250 lines (limit: ${String(MAX_ENTRYPOINT_LINES)})`);
  });

  it('truncates at the byte cap on a newline boundary and names it', () => {
    // 100 lines x 300 chars ≈ 30 KB — under the line cap, over the byte cap.
    const raw = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')} ${'x'.repeat(296)}`).join('\n');

    const result = truncateEntrypointContent(raw);

    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(true);
    const [kept] = result.content.split('\n\n> WARNING:');
    expect(Buffer.byteLength(kept!, 'utf8')).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    // Cut at a whole line: the kept part still parses as complete entries.
    expect(kept!.split('\n').every((line) => line.endsWith('x'))).toBe(true);
    expect(result.content).toContain('bytes (limit: 25000)');
    expect(result.content).toContain('index entries are too long');
  });

  it('counts true UTF-8 bytes, so CJK text hits the byte cap early', () => {
    // 8400 chars x 3 bytes = 25200 bytes: under a char-count cap, over the real one.
    const raw = '汉'.repeat(8400);

    const result = truncateEntrypointContent(raw);

    expect(result.wasByteTruncated).toBe(true);
  });

  it('cuts a single huge line without splitting a multibyte character', () => {
    const raw = '汉'.repeat(9000);

    const result = truncateEntrypointContent(raw);

    const [kept] = result.content.split('\n\n> WARNING:');
    expect(Buffer.byteLength(kept!, 'utf8')).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    expect(Buffer.byteLength(kept!, 'utf8') % 3).toBe(0);
    expect(kept).not.toContain('�');
  });
});
