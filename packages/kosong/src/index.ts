// Message types
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './message';
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from './message';

// Provider interfaces
export * from './provider';
export { createProvider, getModelCapability } from './providers';
export type { ProviderConfig, ProviderType } from './providers';
// Kimi provider: exported so callers can narrow a `ChatProvider` to the Kimi
// backend (instanceof) and apply Kimi-specific request params (generation
// kwargs, `thinking.keep` extra body).
export { KimiChatProvider } from './providers/kimi';
export type { ExtraBody, GenerationKwargs, CloudCodeOptions, ThinkingConfig } from './providers/kimi';
export { classifyKimiQuotaError } from './providers/kimi-errors';

// Model capability matrix
export { isUnknownCapability, UNKNOWN_CAPABILITY } from './capability';
export type { ModelCapability } from './capability';

// Model catalog (models.dev-style) metadata
export {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
  resolveCatalogImport,
} from './catalog';
export type {
  Catalog,
  CatalogModel,
  CatalogModelEntry,
  CatalogProviderEntry,
  CatalogImportInvalidReason,
  CatalogImportResolution,
} from './catalog';

// Core functions
export { generate } from './generate';
export type { GenerateCallbacks, GenerateResult } from './generate';

// Rate-limit snapshots (ChatGPT Codex `x-codex-*` response headers)
export {
  exhaustedRateLimitWindow,
  parseCodexRateLimitHeaders,
  parseCodexUsageLimitError,
  parseCodexUsageLimitMessage,
  rateLimitWindowLabel,
} from './rate-limit';
export type {
  CodexUsageLimitError,
  ExhaustedRateLimitWindow,
  HeaderLookup,
  RateLimitCreditsSnapshot,
  RateLimitSnapshot,
  RateLimitWindowSnapshot,
} from './rate-limit';

// Defensive wire layer + byte-stable tool schemas
export {
  closeTruncatedJson,
  normalizeMessagesForWire,
  UNKNOWN_TOOL_NAME,
} from './normalize';
export type { NormalizeOptions, NormalizeRepairKind } from './normalize';
export { canonicalizeToolSchema } from './schema-canonicalize';

// Tool wire schema
export type { Tool } from './tool';

// Token usage
export { addUsage, emptyUsage, grandTotal, inputTotal } from './usage';
export type { TokenUsage } from './usage';

// Errors
export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIQuotaExceededError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  createAbortError,
  isAbortError,
  isContextOverflowStatusError,
  isImageFormatError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRequestTooLargeStatusError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  isVideoFormatError,
  throwIfAbortError,
} from './errors';

/**
 * Concrete provider adapters stay off the root barrel because their SDK type
 * graphs pollute downstream declaration bundles. Import them from subpaths:
 * `@cloud-code/kosong/providers/kimi`,
 * `@cloud-code/kosong/providers/openai-legacy`, etc.
 */
