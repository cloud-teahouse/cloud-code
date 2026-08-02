import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ContentPart } from '@cloud-code/kosong';
import { join } from 'pathe';

import type { ExecutableToolResult } from '../../loop';

/**
 * Execution-time overflow budget for a single tool result (F10). A result
 * exceeding EITHER limit is persisted to `<sessionDir>/tool-results/` and the
 * model sees a preview plus the file path instead of the full text.
 */
export const TOOL_RESULT_MAX_BYTES = 50 * 1024;
export const TOOL_RESULT_MAX_LINES = 2_000;
export const TOOL_RESULT_PREVIEW_HEAD_CHARS = 2_000;
export const TOOL_RESULT_PREVIEW_TAIL_CHARS = 2_000;

export interface ToolResultBudgetThresholds {
  readonly maxBytes?: number | undefined;
  readonly maxLines?: number | undefined;
  readonly previewHeadChars?: number | undefined;
  readonly previewTailChars?: number | undefined;
  /**
   * Line-based preview geometry (a tool's `snipHint`). When BOTH are present
   * they take precedence over the character window: the preview keeps the
   * first `previewHeadLines` and last `previewTailLines` lines.
   */
  readonly previewHeadLines?: number | undefined;
  readonly previewTailLines?: number | undefined;
}

export interface ResolvedToolResultBudgetThresholds {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly previewHeadChars: number;
  readonly previewTailChars: number;
  readonly previewHeadLines?: number | undefined;
  readonly previewTailLines?: number | undefined;
}

export function resolveToolResultBudgetThresholds(
  thresholds?: ToolResultBudgetThresholds,
): ResolvedToolResultBudgetThresholds {
  return {
    maxBytes: thresholds?.maxBytes ?? TOOL_RESULT_MAX_BYTES,
    maxLines: thresholds?.maxLines ?? TOOL_RESULT_MAX_LINES,
    previewHeadChars: thresholds?.previewHeadChars ?? TOOL_RESULT_PREVIEW_HEAD_CHARS,
    previewTailChars: thresholds?.previewTailChars ?? TOOL_RESULT_PREVIEW_TAIL_CHARS,
    previewHeadLines: thresholds?.previewHeadLines,
    previewTailLines: thresholds?.previewTailLines,
  };
}

interface BudgetToolResultOptions {
  readonly homedir?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
  readonly thresholds?: ToolResultBudgetThresholds;
}

/**
 * Replace an oversized text tool result with a preview plus a pointer to the
 * persisted full output. Returns the input result untouched when the output is
 * not plain text (media results never go through text truncation), when it
 * fits the budget, when the tool already truncated it, or when there is no
 * session directory to persist to.
 */
export async function budgetToolResultForModel(
  options: BudgetToolResultOptions,
): Promise<ExecutableToolResult> {
  const thresholds = resolveToolResultBudgetThresholds(options.thresholds);
  const text = extractToolResultText(options.result.output);
  if (text === undefined || !exceedsToolResultBudget(text, thresholds)) return options.result;
  if (options.result.truncated === true) return options.result;
  if (options.homedir === undefined) return options.result;

  const outputPath = await saveToolResult(
    { homedir: options.homedir, toolName: options.toolName, toolCallId: options.toolCallId },
    text,
  );
  if (outputPath === undefined) return options.result;
  const output = renderPersistedToolResult({
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    text,
    outputPath,
    thresholds,
  });
  return options.result.isError === true
    ? { ...options.result, output, isError: true }
    : { ...options.result, output };
}

/**
 * Plain-text view of a tool result output, or `undefined` when any part is not
 * text (image/audio/video). Media-bearing results are exempt from the text
 * truncation path everywhere it is used.
 */
export function extractToolResultText(output: ExecutableToolResult['output']): string | undefined {
  if (typeof output === 'string') return output;
  if (
    !output.every((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
  ) {
    return undefined;
  }
  return output.map((part) => part.text).join('');
}

export function exceedsToolResultBudget(
  text: string,
  thresholds: Pick<ResolvedToolResultBudgetThresholds, 'maxBytes' | 'maxLines'>,
): boolean {
  if (Buffer.byteLength(text, 'utf8') > thresholds.maxBytes) return true;
  return countLines(text) > thresholds.maxLines;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/**
 * Model-facing replacement for a persisted tool result. The preview keeps the
 * head AND the tail of the output: the head carries provenance (the command
 * echo, headers, opening context) while the tail carries conclusions (errors
 * and summaries of build/test/log output land at the end); the middle is the
 * least information-dense region and remains a `Read` away in the file.
 */
export function renderPersistedToolResult(options: {
  readonly toolCallId: string;
  readonly toolName?: string | undefined;
  readonly text: string;
  readonly outputPath: string;
  readonly thresholds: ResolvedToolResultBudgetThresholds;
}): string {
  const { toolCallId, toolName, text, outputPath, thresholds } = options;
  const lines = [
    `Tool output exceeded the size limit (${String(thresholds.maxBytes)} bytes or ${String(thresholds.maxLines)} lines); the full output was saved to a file.`,
    ...(toolName !== undefined ? [`tool_name: ${toolName}`] : []),
    `tool_call_id: ${toolCallId}`,
    `output_size_chars: ${String(text.length)}`,
    `output_size_bytes: ${String(Buffer.byteLength(text, 'utf8'))}`,
    `output_path: ${outputPath}`,
    'next_step: Use Read with output_path (offset/limit) or Grep to search the full output instead of re-running the tool.',
  ];
  if (text.length <= thresholds.previewHeadChars + thresholds.previewTailChars) {
    lines.push('', '[preview]', text);
  } else if (
    thresholds.previewHeadLines !== undefined &&
    thresholds.previewTailLines !== undefined
  ) {
    // Line-based geometry (the tool's snipHint): the head/tail windows count
    // lines, not chars — read-only tools keep a dominant head, side-effect
    // tools keep both ends.
    const textLines = text.split('\n');
    const headLines = Math.max(0, thresholds.previewHeadLines);
    const tailLines = Math.max(0, thresholds.previewTailLines);
    if (textLines.length <= headLines + tailLines) {
      lines.push('', '[preview]', text);
    } else {
      lines.push(
        '',
        '[preview head]',
        textLines.slice(0, headLines).join('\n'),
        '',
        '[preview tail]',
        textLines.slice(textLines.length - tailLines).join('\n'),
      );
    }
  } else {
    lines.push(
      '',
      '[preview head]',
      text.slice(0, thresholds.previewHeadChars),
      '',
      '[preview tail]',
      text.slice(text.length - thresholds.previewTailChars),
    );
  }
  return lines.join('\n');
}

/**
 * Deterministic persist path for the compaction tool-result budget layer:
 * derived from the tool call id and a content digest, so a replayed session
 * re-derives the identical path (and an identical rewrite is a no-op).
 */
export function persistedToolResultPath(
  homedir: string,
  toolCallId: string,
  text: string,
): string {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return join(homedir, 'tool-results', `${safeToolResultFileStem(toolCallId)}-${digest}.txt`);
}

/**
 * Idempotently write a persisted tool result. Callers use deterministic paths
 * (`persistedToolResultPath`), so rewriting the same content is harmless.
 */
export async function writePersistedToolResult(outputPath: string, text: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, text, 'utf8');
}

async function saveToolResult(
  options: { readonly homedir: string; readonly toolName: string; readonly toolCallId: string },
  text: string,
): Promise<string | undefined> {
  try {
    const dir = join(options.homedir, 'tool-results');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(
      dir,
      `${safeToolResultFileStem(`${options.toolName}-${options.toolCallId}`)}-${randomUUID()}.txt`,
    );
    await writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx' });
    return outputPath;
  } catch {
    return undefined;
  }
}

function safeToolResultFileStem(label: string): string {
  const stem = label
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return stem || 'tool-result';
}
