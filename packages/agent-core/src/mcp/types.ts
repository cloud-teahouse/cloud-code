/**
 * MCP protocol types and the minimal client contract `ToolManager` consumes.
 *
 * Lives in its own file (rather than `toolset.ts`) because the agent-side
 * tool-runtime layer is `ExecutableTool`, not the legacy `Toolset` interface.
 * What remains here is the wire-level surface: tool definitions returned by
 * `tools/list`, the `tools/call` result shape, and the small interface that
 * lets tests inject a fake transport without pulling in the MCP SDK type graph.
 */

/**
 * Inline resource contents nested under an EmbeddedResource block.
 * Exactly one of `text` or `blob` is populated, per the MCP schema's
 * `TextResourceContents | BlobResourceContents` union.
 */
export interface MCPEmbeddedResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

/**
 * A content block as returned by an MCP tool call (`tools/call`).
 *
 * This is a structural subset of the MCP protocol `ContentBlock` union,
 * covering the shapes that {@link convertMCPContentBlock} knows how to convert
 * into kosong `ContentPart`s. Additional fields are ignored.
 */
export interface MCPContentBlock {
  // Known values: 'text' | 'image' | 'audio' | 'resource' | 'resource_link'.
  // Declared as `string` to also accept future MCP content types without a
  // type assertion.
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  // EmbeddedResource carries its payload nested under `resource`, per the
  // MCP spec — never as top-level `data`/`mimeType`.
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

/**
 * Result of a single MCP tool invocation.
 *
 * Matches the shape returned by the MCP protocol's `tools/call` method.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

/**
 * An MCP tool definition as returned by an MCP server's `tools/list` method.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  /**
   * Server-declared metadata, passed through verbatim from `tools/list`.
   * Currently the only consumed key is `anthropic/alwaysLoad` (see
   * {@link isAlwaysLoadMcpTool}).
   */
  readonly _meta?: Record<string, unknown>;
}

/**
 * `_meta` key an MCP tool uses to opt out of progressive disclosure: the tool
 * ships in the initial top-level `tools[]` with its full schema instead of
 * waiting in the deferred pool for a select_tools round-trip (Claude Code
 * uses the same key for the same purpose). Reserved for high-frequency tools
 * where the disclosure tax exceeds the schema's token cost.
 */
export const MCP_ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad';

/** True when the tool's `_meta` declares `anthropic/alwaysLoad: true`. */
export function isAlwaysLoadMcpTool(tool: MCPToolDefinition): boolean {
  return tool._meta?.[MCP_ALWAYS_LOAD_META_KEY] === true;
}

/**
 * Cap on MCP tool descriptions and server instructions sent to the model
 * (ported from Claude Code's `client.ts`). OpenAPI-generated MCP servers
 * have been observed dumping 15-60KB of endpoint docs into
 * `tool.description`; this caps the p95 tail without losing the intent.
 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048;

/**
 * Hard-truncate an over-long description / instructions block to the cap.
 * The cap is in UTF-16 code units (upstream parity), but the cut never
 * splits a surrogate pair: a trailing high surrogate would emit half an
 * astral character into the model context, so it is dropped with it.
 */
export function truncateMcpDescription(description: string): string {
  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) return description;
  let end = MAX_MCP_DESCRIPTION_LENGTH;
  // A UTF-16 code unit is required here: codePointAt would merge the very
  // surrogate pair this check avoids splitting.
  // oxlint-disable-next-line unicorn/prefer-code-point
  const last = description.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return description.slice(0, end);
}

/**
 * Detects an MCP "Session not found" error (HTTP 404 + JSON-RPC code
 * -32001). Per the MCP spec, servers return 404 when a session ID is no
 * longer valid; both signals are checked to avoid false positives from
 * generic 404s (wrong URL, server gone, etc.). Ported verbatim from Claude
 * Code's `client.ts` — the SDK embeds the response body text in the error
 * message, and MCP servers return
 * `{"error":{"code":-32001,"message":"Session not found"},...}`.
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus = 'code' in error ? (error as Error & { code?: number }).code : undefined;
  if (httpStatus !== 404) {
    return false;
  }
  return error.message.includes('"code":-32001') || error.message.includes('"code": -32001');
}

/**
 * Minimal MCP client interface consumed by {@link McpConnectionManager} and
 * {@link ToolManager}.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * `@modelcontextprotocol/sdk`, a bespoke stdio client, an HTTP SSE client,
 * or a mock for testing. Keeping the surface small lets tests inject fakes
 * without pulling in the full SDK type graph.
 */
export interface MCPClient {
  /** List the tools advertised by the MCP server. */
  listTools(): Promise<MCPToolDefinition[]>;
  /**
   * Server-provided instructions from the `initialize` response, when the
   * server advertised any. Immutable for the life of the connection.
   * Optional so test fakes stay minimal; the runtime clients implement it
   * once `connect()` has resolved.
   */
  getInstructions?(): string | undefined;
  /**
   * Invoke a tool by name with the given JSON arguments.
   *
   * `signal`, when provided, is forwarded to the underlying transport so an
   * abort from the loop (e.g. user cancellation) propagates all the way to
   * the server instead of leaving the request running in the background.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

/**
 * Validate the `inputSchema` field of an MCP tool definition. MCP advertises
 * input schemas as JSON Schema objects; reject anything that is not a plain
 * object so the validator compiler downstream never sees `null` or a
 * primitive.
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}
