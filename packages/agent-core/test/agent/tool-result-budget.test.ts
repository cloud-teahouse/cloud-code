import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ContentPart } from '@cloud-code/kosong';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import {
  budgetToolResultForModel,
  exceedsToolResultBudget,
  persistedToolResultPath,
  resolveToolResultBudgetThresholds,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
  TOOL_RESULT_PREVIEW_HEAD_CHARS,
  TOOL_RESULT_PREVIEW_TAIL_CHARS,
} from '../../src/agent/turn/tool-result-budget';

const SESSION_DIRS: string[] = [];

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-budget-'));
  SESSION_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (SESSION_DIRS.length > 0) {
    rmSync(SESSION_DIRS.pop()!, { recursive: true, force: true });
  }
});

function outputPathOf(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  return /^output_path: (.+)$/m.exec(output)?.[1];
}

describe('budgetToolResultForModel', () => {
  it('passes results within the budget through untouched', async () => {
    const dir = sessionDir();
    const result = { output: 'small output' };
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_ok',
      result,
    });
    expect(budgeted).toBe(result);
    expect(existsSync(join(dir, 'tool-results'))).toBe(false);
  });

  it('persists oversized output and returns marker, path and head/tail preview', async () => {
    const dir = sessionDir();
    const head = 'HEAD-UNIQUE-START';
    const tail = 'TAIL-UNIQUE-END';
    const text = head + 'x'.repeat(TOOL_RESULT_MAX_BYTES) + tail;
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_big',
      result: { output: text },
    });

    expect(typeof budgeted.output).toBe('string');
    const output = budgeted.output as string;
    expect(output).toContain('Tool output exceeded the size limit');
    expect(output).toContain('tool_call_id: call_big');
    expect(output).toContain('[preview head]');
    expect(output).toContain('[preview tail]');
    expect(output).toContain(head);
    // The tail preview keeps the end of the output, where errors and
    // conclusions of build/test/log output land.
    expect(output).toContain(tail);
    expect(output.length).toBeLessThan(text.length);

    const outputPath = outputPathOf(output);
    expect(outputPath).toBeTruthy();
    expect(outputPath!).toContain('tool-results');
    expect(outputPath!).toContain('call_big');
    expect(readFileSync(outputPath!, 'utf8')).toBe(text);
  });

  it('triggers on the line budget even when the byte budget is not exceeded', async () => {
    const dir = sessionDir();
    const text = Array.from({ length: TOOL_RESULT_MAX_LINES + 1 }, (_, i) => `l${String(i)}`).join(
      '\n',
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(TOOL_RESULT_MAX_BYTES);
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_lines',
      result: { output: text },
    });
    expect(budgeted.output).not.toBe(text);
    expect(budgeted.output as string).toContain('output_path:');
    expect(readFileSync(outputPathOf(budgeted.output)!, 'utf8')).toBe(text);
  });

  it('keeps output at exactly the byte and line limits intact', async () => {
    const dir = sessionDir();
    const exactBytes = 'a'.repeat(TOOL_RESULT_MAX_BYTES);
    const exactLines = Array.from({ length: TOOL_RESULT_MAX_LINES }, () => 'b').join('\n');
    for (const [toolCallId, text] of [
      ['call_exact_bytes', exactBytes],
      ['call_exact_lines', exactLines],
    ] as const) {
      const result = { output: text };
      const budgeted = await budgetToolResultForModel({
        homedir: dir,
        toolName: 'Lookup',
        toolCallId,
        result,
      });
      expect(budgeted).toBe(result);
    }
    expect(existsSync(join(dir, 'tool-results'))).toBe(false);
  });

  it('never truncates media-bearing results', async () => {
    const dir = sessionDir();
    const content: ContentPart[] = [
      { type: 'text', text: 'x'.repeat(TOOL_RESULT_MAX_BYTES + 1) },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ];
    const result = { output: content };
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'ReadMediaFile',
      toolCallId: 'call_media',
      result,
    });
    expect(budgeted).toBe(result);
    expect(existsSync(join(dir, 'tool-results'))).toBe(false);
  });

  it('joins all-text content parts before budgeting', async () => {
    const dir = sessionDir();
    const half = 'y'.repeat(Math.ceil((TOOL_RESULT_MAX_BYTES + 10) / 2));
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_parts',
      result: {
        output: [
          { type: 'text', text: half },
          { type: 'text', text: half },
        ],
      },
    });
    const outputPath = outputPathOf(budgeted.output);
    expect(outputPath).toBeTruthy();
    expect(readFileSync(outputPath!, 'utf8')).toBe(half + half);
  });

  it('preserves the error flag on persisted error results', async () => {
    const dir = sessionDir();
    const text = 'e'.repeat(TOOL_RESULT_MAX_BYTES + 1);
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Bash',
      toolCallId: 'call_err',
      result: { output: text, isError: true },
    });
    expect(budgeted.isError).toBe(true);
    expect(budgeted.output as string).toContain('output_path:');
  });

  it('honors caller-provided thresholds', async () => {
    const dir = sessionDir();
    const text = 'z'.repeat(500);
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_custom',
      result: { output: text },
      thresholds: { maxBytes: 100, previewHeadChars: 10, previewTailChars: 10 },
    });
    const output = budgeted.output as string;
    expect(output).toContain('(100 bytes or 2000 lines)');
    expect(readFileSync(outputPathOf(output)!, 'utf8')).toBe(text);
  });
});

describe('exceedsToolResultBudget', () => {
  const thresholds = resolveToolResultBudgetThresholds();

  it('is false at the exact limits and true beyond them', () => {
    expect(exceedsToolResultBudget('a'.repeat(TOOL_RESULT_MAX_BYTES), thresholds)).toBe(false);
    expect(exceedsToolResultBudget('a'.repeat(TOOL_RESULT_MAX_BYTES + 1), thresholds)).toBe(true);
    const exactLines = Array.from({ length: TOOL_RESULT_MAX_LINES }, () => 'b').join('\n');
    expect(exceedsToolResultBudget(exactLines, thresholds)).toBe(false);
    expect(exceedsToolResultBudget(`${exactLines}\nc`, thresholds)).toBe(true);
  });
});

describe('persistedToolResultPath', () => {
  it('is deterministic for the same id and content, and content-sensitive', () => {
    const dir = sessionDir();
    const first = persistedToolResultPath(dir, 'call_x', 'content one');
    expect(persistedToolResultPath(dir, 'call_x', 'content one')).toBe(first);
    expect(persistedToolResultPath(dir, 'call_x', 'content two')).not.toBe(first);
    expect(first).toContain('call_x');
    expect(first).toContain('tool-results');
  });
});

describe('preview shape', () => {
  it('shows the full text when it fits the combined preview budget', async () => {
    const dir = sessionDir();
    // Over the line limit (so it still persists) but short in characters.
    const text = Array.from({ length: TOOL_RESULT_MAX_LINES + 1 }, () => '').join('\n');
    expect(text.length).toBeLessThanOrEqual(
      TOOL_RESULT_PREVIEW_HEAD_CHARS + TOOL_RESULT_PREVIEW_TAIL_CHARS,
    );
    const budgeted = await budgetToolResultForModel({
      homedir: dir,
      toolName: 'Lookup',
      toolCallId: 'call_short_lines',
      result: { output: text },
    });
    const output = budgeted.output as string;
    expect(output).toContain('[preview]');
    expect(output).not.toContain('[preview tail]');
    expect(output).toContain(text);
  });
});
