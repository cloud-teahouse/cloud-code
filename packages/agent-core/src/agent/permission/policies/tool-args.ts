/**
 * Shared argument readers for permission policies that need a best-effort
 * record view of a tool call's arguments.
 */

/** Best-effort view of the raw tool-call arguments as a record. */
export function recordArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Fallback for hook contexts whose `args` is not yet a parsed record: the
 * wire form of the tool call carries the JSON argument string.
 */
export function parseArguments(argumentsJson: string | null): Record<string, unknown> | undefined {
  if (argumentsJson === null) return undefined;
  try {
    return recordArgs(JSON.parse(argumentsJson));
  } catch {
    return undefined;
  }
}
