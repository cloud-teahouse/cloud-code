import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkMemoryRelPath,
  MAX_ENTRYPOINT_LINES,
  saveMemory,
  upsertIndexEntry,
  type MemoryDirs,
} from '../../src/memory';
import { testKaos } from '../fixtures/test-kaos';

let workDir: string;
let brandHome: string;
let dirs: MemoryDirs;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'cloudcode-save-work-'));
  brandHome = await mkdtemp(join(tmpdir(), 'cloudcode-save-brand-'));
  dirs = {
    project: join(workDir, '.cloud-code', 'memory'),
    user: join(brandHome, 'memory'),
  };
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(brandHome, { recursive: true, force: true });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('checkMemoryRelPath', () => {
  it.each([
    { path: 'ok.md', relPath: 'ok.md' },
    { path: 'sub/dir/ok.md', relPath: 'sub/dir/ok.md' },
    { path: './ok.md', relPath: 'ok.md' },
    { path: 'UPPER.MD', relPath: 'UPPER.MD' },
  ])('accepts $path', ({ path, relPath }) => {
    expect(checkMemoryRelPath(path)).toEqual({ ok: true, relPath });
  });

  it.each([
    { path: '../x.md', why: 'inside the memory directory' },
    { path: 'a/../../x.md', why: 'inside the memory directory' },
    { path: '..\\win\\x.md', why: 'inside the memory directory' },
    { path: '/abs/x.md', why: 'not absolute' },
    { path: 'C:\\x.md', why: 'not absolute' },
    { path: '//server/share/x.md', why: 'not absolute' },
    { path: 'notes.txt', why: 'markdown' },
    { path: 'notes', why: 'markdown' },
    { path: 'MEMORY.md', why: 'the index' },
    { path: 'memory.md', why: 'the index' },
    { path: 'sub/Memory.MD', why: 'the index' },
  ])('rejects $path ($why)', ({ path, why }) => {
    const check = checkMemoryRelPath(path);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain(why);
  });

  it('rejects NUL bytes', () => {
    expect(checkMemoryRelPath('a\0.md').ok).toBe(false);
  });
});

describe('saveMemory', () => {
  it('writes the memory file and creates the index with a pointer line', async () => {
    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'feedback/testing.md',
      description: 'Use a real DB in tests',
      content: '# Testing\n\nAlways use a real database.',
    });

    expect(outcome.ok).toBe(true);
    const memoryPath = join(dirs.project, 'feedback', 'testing.md');
    const indexPath = join(dirs.project, 'MEMORY.md');
    expect(outcome).toMatchObject({ memoryPath, indexPath });
    expect(await readFile(memoryPath, 'utf-8')).toBe('# Testing\n\nAlways use a real database.');
    expect(await readFile(indexPath, 'utf-8')).toBe('- [Use a real DB in tests](feedback/testing.md)\n');
  });

  it('writes to the user scope when asked', async () => {
    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'user',
      path: 'user_role.md',
      description: 'User is a data scientist',
      content: 'The user is a data scientist.',
    });

    expect(outcome.ok).toBe(true);
    expect(await pathExists(join(dirs.user, 'user_role.md'))).toBe(true);
    expect(await pathExists(join(dirs.project, 'user_role.md'))).toBe(false);
  });

  it('refreshes the index line when saving to an existing path', async () => {
    await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'prefs.md',
      description: 'Old description',
      content: 'v1',
    });
    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'prefs.md',
      description: 'New description',
      content: 'v2',
    });

    expect(outcome.ok).toBe(true);
    const index = await readFile(join(dirs.project, 'MEMORY.md'), 'utf-8');
    expect(index).toBe('- [New description](prefs.md)\n');
    expect(await readFile(join(dirs.project, 'prefs.md'), 'utf-8')).toBe('v2');
  });

  it('appends a new entry after existing content and preserves other lines', async () => {
    const indexPath = join(dirs.project, 'MEMORY.md');
    await mkdir(dirs.project, { recursive: true });
    await writeFile(indexPath, '# My memory index\n\n- [Old](old.md)\n', 'utf-8');

    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'new.md',
      description: 'New entry',
      content: 'body',
    });

    expect(outcome.ok).toBe(true);
    expect(await readFile(indexPath, 'utf-8')).toBe(
      '# My memory index\n\n- [Old](old.md)\n- [New entry](new.md)\n',
    );
  });

  it('rejects an index update that would exceed the cap without writing anything', async () => {
    const indexPath = join(dirs.project, 'MEMORY.md');
    await mkdir(dirs.project, { recursive: true });
    const full = Array.from(
      { length: MAX_ENTRYPOINT_LINES },
      (_, i) => `- [Entry ${String(i)}](e${String(i)}.md)`,
    ).join('\n');
    await writeFile(indexPath, `${full}\n`, 'utf-8');

    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'overflow.md',
      description: 'One entry too many',
      content: 'body',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('index budget');
    expect(await pathExists(join(dirs.project, 'overflow.md'))).toBe(false);
    expect(await readFile(indexPath, 'utf-8')).toBe(`${full}\n`);
  });

  it('rejects an invalid path without touching the disk', async () => {
    const outcome = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: '../escape.md',
      description: 'nope',
      content: 'body',
    });

    expect(outcome.ok).toBe(false);
    expect(await pathExists(join(workDir, 'escape.md'))).toBe(false);
    expect(await pathExists(dirs.project)).toBe(false);
  });

  it('rejects an empty description and empty content', async () => {
    const noDescription = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'a.md',
      description: '   ',
      content: 'body',
    });
    expect(noDescription.ok).toBe(false);

    const noContent = await saveMemory(testKaos, dirs, {
      scope: 'project',
      path: 'a.md',
      description: 'fine',
      content: '  \n ',
    });
    expect(noContent.ok).toBe(false);
    expect(await pathExists(dirs.project)).toBe(false);
  });
});

describe('upsertIndexEntry', () => {
  it('drops duplicate index lines for the same file', () => {
    const index = '- [One](dup.md)\n- [Other](other.md)\n- [Two](dup.md)\n';

    const updated = upsertIndexEntry(index, 'dup.md', '- [Fresh](dup.md)');

    expect(updated).toBe('- [Fresh](dup.md)\n- [Other](other.md)\n');
  });

  it('matches entries that carry a trailing hook after the link', () => {
    const index = '- [Old](topic.md) — a one-line hook\n';

    const updated = upsertIndexEntry(index, 'topic.md', '- [New](topic.md)');

    expect(updated).toBe('- [New](topic.md)\n');
  });

  it('appends after the last non-empty line', () => {
    const updated = upsertIndexEntry('- [A](a.md)\n\n\n', 'b.md', '- [B](b.md)');

    expect(updated).toBe('- [A](a.md)\n- [B](b.md)\n\n\n');
  });
});
