import type { ExecutableTool } from '../../loop';

export type ToolSource = 'builtin' | 'user' | 'mcp';
export type ToolDisclosure = 'inline' | 'deferred';

/**
 * Per-tool truncation geometry for the graduated compaction tool-result
 * budget layer (the SnipHinter analog): when an old oversized result is
 * persisted to disk and replaced by a preview, the preview keeps the first
 * `headLines` and the last `tailLines` of the output instead of a fixed
 * character window. The marker embedding the archive path is unchanged.
 */
export interface ToolSnipHint {
  readonly headLines: number;
  readonly tailLines: number;
}

/**
 * Default geometry for read-only tools: their output carries the answer at
 * the front (the file content, the match list), so the head dominates.
 */
export const TOOL_SNIP_HINT_READ_ONLY: ToolSnipHint = { headLines: 80, tailLines: 12 };

/**
 * Default geometry for side-effect tools: both ends matter — the command
 * echo and setup at the front, the errors and summaries at the end.
 */
export const TOOL_SNIP_HINT_SIDE_EFFECT: ToolSnipHint = { headLines: 40, tailLines: 40 };

export interface BuiltinTool<Input = unknown> extends ExecutableTool<Input> {
  /**
   * Optional line-based preview geometry for the compaction budget layer.
   * Absent → the layer's default character-based preview is used.
   */
  readonly snipHint?: ToolSnipHint | undefined;
}

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}

export interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export interface McpServerRegistrationResult {
  readonly registered: readonly string[];
  readonly collisions: readonly McpToolCollision[];
}
