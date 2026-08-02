/**
 * SaveMemoryTool — write a durable memory into the file-based memory system.
 *
 * One call does the full two-step save (Claude Code's memdir convention):
 * the memory lands as its own `.md` file inside the chosen scope's memory
 * directory, and the directory's `MEMORY.md` index gains (or refreshes) a
 * one-line pointer to it. Validation is structured — relative `.md` path
 * confined to the memory dir, single-line description, non-empty content,
 * index capped at the same 200-line / 25 KB budget the prompt injection
 * enforces — and all of it runs before the first write, so a rejected save
 * leaves the memory dir untouched.
 *
 * The dirs are the same ones `loadMemoryForPrompt` reads, so a save in this
 * session is picked up by the next system prompt render.
 */

import { z } from 'zod';

import type { Kaos } from '@cloud-code/kaos';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  checkMemoryRelPath,
  MEMORY_ENTRYPOINT_NAME,
  resolveMemoryDirs,
  saveMemory,
  type MemoryScope,
} from '../../../memory';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './save-memory.md?raw';

export const SAVE_MEMORY_TOOL_NAME = 'SaveMemory' as const;

export const SaveMemoryInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Memory file path relative to the memory directory. Must end in .md and stay inside the directory; subdirectories are allowed (e.g. "feedback/testing.md"). Must not be MEMORY.md — the index is updated automatically.',
    ),
  description: z
    .string()
    .min(1)
    .describe(
      'Single line used as the index pointer in MEMORY.md. Keep it under ~150 characters.',
    ),
  content: z.string().min(1).describe('The full memory as markdown.'),
  scope: z
    .enum(['project', 'user'])
    .optional()
    .describe(
      'Where to save: "project" (default) for repository-specific memories, "user" for cross-project facts about the user and their preferences.',
    ),
});

export type SaveMemoryInput = z.Infer<typeof SaveMemoryInputSchema>;

export class SaveMemoryTool implements BuiltinTool<SaveMemoryInput> {
  readonly name = SAVE_MEMORY_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SaveMemoryInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly brandHome?: string,
  ) {}

  resolveExecution(args: SaveMemoryInput): ToolExecution {
    const check = checkMemoryRelPath(args.path);
    if (!check.ok) {
      return { isError: true, output: check.error };
    }
    const scope: MemoryScope = args.scope ?? 'project';
    return {
      description: `Saving memory ${check.relPath}`,
      display: { kind: 'file_io', operation: 'write', path: args.path, content: args.content },
      approvalRule: this.name,
      execute: () => this.execution(scope, check.relPath, args),
    };
  }

  private async execution(
    scope: MemoryScope,
    relPath: string,
    args: SaveMemoryInput,
  ): Promise<ExecutableToolResult> {
    const dirs = await resolveMemoryDirs(this.kaos, this.brandHome);
    const outcome = await saveMemory(this.kaos, dirs, {
      scope,
      path: relPath,
      description: args.description,
      content: args.content,
    });
    if (!outcome.ok) {
      return { isError: true, output: outcome.error };
    }
    return {
      output:
        `Saved memory to ${outcome.memoryPath} and updated ${outcome.indexPath}.\n` +
        `The ${MEMORY_ENTRYPOINT_NAME} index is injected into future sessions' system prompts; ` +
        'the memory file itself is read on demand.',
      display: {
        key: 'toolResult.memory.saved',
        params: { memoryPath: outcome.memoryPath, indexPath: outcome.indexPath },
      },
    };
  }
}
