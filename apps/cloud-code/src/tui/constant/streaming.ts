// Extracts useful string fields from partially streamed JSON tool args.
// This is intentionally a preview parser, not a full JSON parser.
export const STREAMING_ARGS_FIELD_RE =
  /"(path|file_path|command|pattern|query|url|description|title|name)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

// Bounds live tool-argument previews; final tool.call payloads remain complete.
export const STREAMING_ARGS_PREVIEW_MAX_CHARS = 64 * 1024;

// Coalesces high-frequency model/tool deltas before rebuilding TUI components.
export const STREAMING_UI_FLUSH_MS = 50;

// Stall detection: with no fresh tokens for this long while the stream is
// expected to be producing (waiting / composing), the activity spinner flips
// to the theme warning color until tokens resume.
export const STREAM_STALL_THRESHOLD_MS = 3_000;
export const STREAM_STALL_CHECK_INTERVAL_MS = 500;
