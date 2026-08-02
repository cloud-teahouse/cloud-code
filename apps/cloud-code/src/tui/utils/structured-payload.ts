/**
 * Raw structured payload detection for the tool-result body convention: a
 * tool result that is one JSON document (object or array) renders without
 * the per-row tree gutter. Conservative by design — the whole trimmed text
 * must parse as a single JSON object/array, so prose that merely opens with
 * a brace, JSONL streams, and text with a JSON trailer all keep the gutter.
 */
export function isRawStructuredPayload(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}
