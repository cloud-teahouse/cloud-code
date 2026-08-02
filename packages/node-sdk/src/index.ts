export { CloudCodeHarness } from '#/cloud-code-harness';
export type { CloudCodeHarnessRuntimeOptions } from '#/cloud-code-harness';
export { Session } from '#/session';
export { CloudCodeAuthFacade } from '#/auth';
export { createCloudCodeHarness, SDKRpcClient, type SDKRpcClientOptions } from '#/sdk-rpc-client';
export { RemoteRpcClient, type RemoteRpcClientOptions } from '#/remote-rpc-client';
export {
  createCloudCodeConfigRpc,
  CloudCodeConfigRpcClient,
  type CloudCodeConfigRpc,
  type CloudCodeConfigValidationIssue,
  type CloudCodeConfigValidationPathSegment,
  type ResolveCloudCodeConfigPathInput,
  type ValidateCloudCodeConfigTomlInput,
} from '#/config-rpc';
export { SDKRpcClientBase } from '#/rpc';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { CloudCodeForCodingProviderOptions } from '#/kimi-code-model-provider';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  resolveCatalogImport,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogImportInvalidReason,
  CatalogImportResolution,
  CatalogModel,
  CatalogProviderEntry,
  FetchCatalogOptions,
} from '#/catalog';

export {
  ErrorCodes,
  CloudCodeError,
  type CloudCodeErrorCode,
  type CloudCodeErrorInfo,
  type CloudCodeErrorOptions,
  type CloudCodeErrorPayload,
  CLOUD_CODE_ERROR_INFO,
  fromCloudCodeErrorPayload,
  isCloudCodeError,
  toCloudCodeErrorPayload,
} from '@cloud-code/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core.
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  redact,
  resolveGlobalLogPath,
  resolveCloudCodeHome,
} from '@cloud-code/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@cloud-code/agent-core';

// Host-side config helpers — safe config reader + config path resolution, used
// by hosts (e.g. the CLI's server bootstrap) that need to inspect
// config without spinning up a full CloudCodeCore.
export { effectiveModelAlias, loadRuntimeConfigSafe, resolveConfigPath } from '@cloud-code/agent-core';
export { limitAgentReplayByTurns } from '@cloud-code/agent-core';
// Model-level fast-tier gate shared by the TUI `/fast` command and the footer
// marker (the request-side guard lives in agent-core's applyServiceTier).
export { isFastTierSupported } from '@cloud-code/agent-core';
export type { FastTierModelShape, FastTierProviderShape } from '@cloud-code/agent-core';
export { parseAgentFileText, resolveAgentPath } from '@cloud-code/agent-core';
// The synthesized `[models]` alias a `[secondary_model]` recipe with patch
// fields materializes at runtime — hosts filter it out of model pickers.
export { SECONDARY_DERIVED_MODEL_ALIAS } from '@cloud-code/agent-core';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@cloud-code/agent-core';

// User UI-language preference bridge — the interactive host (TUI) writes it
// at startup and on every `/language` switch; agents read it when rendering
// the system prompt's `# Language` section. In-process hosts only.
export { getUserLanguage, onUserLanguageChange, setUserLanguage } from '@cloud-code/agent-core';

// Image compression — ingestion sites (e.g. the CLI's clipboard paste, the ACP
// adapter) shrink oversized images while constructing the content part, before
// it enters a prompt. Best effort: returns the original on any failure.
// Compression is never silent: buildImageCompressionCaption renders the note
// placed next to a compressed image, and persistOriginalImage keeps the
// pre-compression bytes readable (ReadMediaFile + region) for detail.
export {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressImageForModel,
  compressBase64ForModel,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  persistOriginalImage,
  sessionMediaOriginalsDir,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '@cloud-code/agent-core';
export { ImageLimits } from '@cloud-code/agent-core';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
} from '@cloud-code/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `CloudCodeHarness.getExperimentalFeatures()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@cloud-code/agent-core';

export type {
  CloudCodeAuthCompleteFeedbackUploadInput,
  CloudCodeAuthCompleteFeedbackUploadPart,
  CloudCodeAuthCreateFeedbackUploadUrlInput,
  CloudCodeAuthCreateFeedbackUploadUrlOk,
  CloudCodeAuthCreateFeedbackUploadUrlResult,
  CloudCodeAuthFeedbackUploadPart,
  CloudCodeAuthLoginResult,
  CloudCodeAuthLogoutResult,
  CloudCodeAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
