// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '✨ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';
// Tree gutter on tool-detail body rows: `├─` on middle rows, `└─` on the last
// row of the card's last detail block, with the body text aligned after the
// gutter. The gutter renders in the `textDim` tone. This is the convention
// for dim detail bodies under a tool header — the same shape read-group/
// agent-group rows already used. Two exceptions: command cards use the
// `$`/`⎿` shape below instead of the tree gutter, and raw structured
// payloads use the single-bar gutter further below.
export const DETAIL_TREE_MIDDLE = '  ├─ ';
export const DETAIL_TREE_LAST = '  └─ ';

// Raw structured payload gutter (e.g. an MCP tool result that is one JSON
// document): the tree gutter reads as noise against JSON/code, so those
// bodies get a single dim `│` bar on every row — just enough to keep the
// body grouped under the card header. The bar sits on the same column the
// tree branch would occupy.
export const RAW_PAYLOAD_GUTTER = '  │ ';

// Command-card body shape (Bash/ExecSession tool cards and merged ToolGroup
// command rows): the command is prompted by `$` and its output opens with a
// dim `⎿`, with continuation rows aligned under the text after the marker.
// Rows sit one level under the card header and never carry the tree gutter.
// The `!` shell-run card uses the same `$`/`⎿` markers but renders flush
// left (no COMMAND_BODY_INDENT): its `⎿` sits on the dialog cards' ● bullet
// column, aligned with the `$` echo above it.
export const COMMAND_BODY_INDENT = '   ';
export const COMMAND_PROMPT = '$ ';
export const COMMAND_OUTPUT_MARK = '⎿ ';

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; the current-value marker is
// localized — `t('common.currentMark')` — and appended to the row that is
// the currently-active value. See docs/tui-design.md.
export const SELECT_POINTER = '❯';
