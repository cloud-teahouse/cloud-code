import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ENTRYPOINT_LINES } from '../../src/memory';
import { SaveMemoryInputSchema, SaveMemoryTool } from '../../src/tools/builtin/memory/save-memory';
import { testKaos } from '../fixtures/test-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(args: Input, toolCallId = 'call_1') {
  return { turnId: '0', toolCallId, args, signal };
}

let homeDir: string;
let workDir: string;
let brandHome: string;
let tool: SaveMemoryTool;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'cloudcode-toolmem-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'cloudcode-toolmem-work-'));
  brandHome = await mkdtemp(join(tmpdir(), 'cloudcode-toolmem-brand-'));
  vi.spyOn(testKaos, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testKaos, 'getcwd').mockReturnValue(workDir);
  // Project-root discovery stats `.git`; a plain dir is enough.
  await mkdir(join(workDir, '.git'));
  tool = new SaveMemoryTool(testKaos, brandHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  await rm(brandHome, { recursive: true, force: true });
});

describe('SaveMemoryTool', () => {
  it('exposes parameters and saves into the project memory dir', async () => {
    expect(
      SaveMemoryInputSchema.safeParse({
        path: 'feedback/testing.md',
        description: 'Use a real DB in tests',
        content: 'Always use a real database.',
      }).success,
    ).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, description: { type: 'string' } },
    });

    const result = await executeTool(
      tool,
      context({
        path: 'feedback/testing.md',
        description: 'Use a real DB in tests',
        content: 'Always use a real database.',
      }),
    );

    const memoryDir = join(workDir, '.cloud-code', 'memory');
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`Saved memory to ${join(memoryDir, 'feedback', 'testing.md')}`);
    expect(result.display).toEqual({
      key: 'toolResult.memory.saved',
      params: {
        memoryPath: join(memoryDir, 'feedback', 'testing.md'),
        indexPath: join(memoryDir, 'MEMORY.md'),
      },
    });
    expect(await readFile(join(memoryDir, 'feedback', 'testing.md'), 'utf-8')).toBe(
      'Always use a real database.',
    );
    expect(await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- [Use a real DB in tests](feedback/testing.md)\n',
    );
  });

  it('saves into the user memory dir for scope user', async () => {
    const result = await executeTool(
      tool,
      context({
        path: 'user_role.md',
        description: 'User is a data scientist',
        content: 'The user is a data scientist.',
        scope: 'user',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(join(brandHome, 'memory', 'user_role.md'), 'utf-8')).toBe(
      'The user is a data scientist.',
    );
    expect(await readFile(join(brandHome, 'memory', 'MEMORY.md'), 'utf-8')).toBe(
      '- [User is a data scientist](user_role.md)\n',
    );
  });

  it('rejects traversal and the index file at resolve time', async () => {
    const traversal = tool.resolveExecution({
      path: '../escape.md',
      description: 'nope',
      content: 'body',
    });
    expect(traversal.isError).toBe(true);
    if (traversal.isError === true) {
      expect(traversal.output).toContain('inside the memory directory');
    }

    const index = tool.resolveExecution({ path: 'MEMORY.md', description: 'nope', content: 'body' });
    expect(index.isError).toBe(true);
    if (index.isError === true) {
      expect(index.output).toContain('the index');
    }
  });

  it('surfaces the index-cap rejection as a tool error', async () => {
    const memoryDir = join(workDir, '.cloud-code', 'memory');
    await mkdir(memoryDir, { recursive: true });
    const full = Array.from(
      { length: MAX_ENTRYPOINT_LINES },
      (_, i) => `- [Entry ${String(i)}](e${String(i)}.md)`,
    ).join('\n');
    await writeFile(join(memoryDir, 'MEMORY.md'), `${full}\n`, 'utf-8');

    const result = await executeTool(
      tool,
      context({ path: 'overflow.md', description: 'One entry too many', content: 'body' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('index budget');
    expect(await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8')).toBe(`${full}\n`);
  });
});
