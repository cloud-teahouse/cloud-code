/**
 * Cloud Code JSON-RPC 2.0 protocol schemas (Phase 4 v1).
 *
 * The method surface is a 1:1 mechanical mapping of the in-memory RPC seam:
 *  - forward: `CoreAPI` method names with their payload as `params`
 *    (`sessionId` / `agentId` scoping ids are already part of each payload);
 *  - reverse (`SDKAPI`): `requestApproval` / `requestQuestion` / `toolCall`
 *    become server→client requests, `emitEvent` becomes the `event`
 *    notification.
 *
 * Method `params`/`result` payloads are typed by the CoreAPI/SDKAPI interfaces
 * in `@cloud-code/agent-core`; they are intentionally NOT re-described as zod
 * schemas here (the in-memory transport already JSON-round-trips them, so they
 * are JSON-safe by construction). This file schemas the envelope, the
 * handshake, the error mapping, and the `interaction/resolved` notification.
 */
import { z } from 'zod';

import { eventSchema } from './events';
import { cursorsBySessionSchema, sessionCursorSchema } from './ws-control';

export const JSON_RPC_VERSION = '2.0' as const;

/**
 * Bump on breaking wire changes. The server rejects `initialize` handshakes
 * whose `protocolVersion` is not exactly equal to this value — there is no
 * minor-version compatibility window (the bridge compares with `!==`), so a
 * client and server must speak the same version.
 */
export const CLOUD_CODE_PROTOCOL_VERSION = 1 as const;

/** Numeric JSON-RPC error code segments used by the Cloud Code server. */
export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Server-side failures (business code travels in `error.data.code`). */
  SERVER_ERROR: -32000,
  /** Any request other than `initialize` arriving before the handshake. */
  NOT_INITIALIZED: -32002,
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR)[keyof typeof JSON_RPC_ERROR];

// ---------------------------------------------------------------------------
// Method names (forward method names are the CoreAPI method names themselves)
// ---------------------------------------------------------------------------

export const INITIALIZE_METHOD = 'initialize';
export const INITIALIZED_NOTIFICATION = 'initialized';
export const EVENT_NOTIFICATION = 'event';
export const INTERACTION_RESOLVED_NOTIFICATION = 'interaction/resolved';
/**
 * Sent when a subscriber's resume cursor cannot be honored by the event
 * journal (epoch mismatch or buffer overflow); the client must rebuild
 * session state from a `resumeSession` snapshot (ws-control heritage, v2).
 */
export const RESYNC_REQUIRED_NOTIFICATION = 'resync_required';

/** SDKAPI reverse request methods (server→client). */
export const REVERSE_REQUEST_METHODS = ['requestApproval', 'requestQuestion', 'toolCall'] as const;
export type ReverseRequestMethod = (typeof REVERSE_REQUEST_METHODS)[number];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const jsonRpcIdSchema = z.union([z.string(), z.number().int(), z.null()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

/**
 * Wire error payload carried in `error.data`: the `CloudCodeErrorPayload` shape
 * (`code` string + `retryable`), schematized as `kimiErrorPayloadSchema` in
 * `./events` (reused, not redefined, to keep a single source of truth).
 */
export const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof jsonRpcErrorObjectSchema>;

export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: jsonRpcErrorObjectSchema.optional(),
});
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

/** Any well-formed message on the wire. */
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcResponseSchema,
]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export const initializeParamsSchema = z.object({
  clientInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  capabilities: z
    .object({
      /**
       * Optional session-id whitelist: the connection immediately subscribes
       * to these sessions' events (attach use-case). Sessions created /
       * resumed / forked through this connection are subscribed implicitly.
       */
      sessionIds: z.array(z.string().min(1)).optional(),
      /**
       * Optional per-session resume cursors ({seq, epoch}, ws-control
       * heritage): after subscribing, the server replays journaled durable
       * events newer than the cursor, or answers with `resync_required`
       * when the cursor is stale (v2 reconnect path).
       */
      cursors: cursorsBySessionSchema.optional(),
    })
    .optional(),
  protocolVersion: z.number().int().optional(),
});
export type InitializeParams = z.infer<typeof initializeParamsSchema>;

export const initializeResultSchema = z.object({
  serverInfo: z.object({
    name: z.string(),
    version: z.string(),
  }),
  protocolVersion: z.number().int(),
  homeDir: z.string(),
});
export type InitializeResult = z.infer<typeof initializeResultSchema>;

// ---------------------------------------------------------------------------
// Server→client notifications
// ---------------------------------------------------------------------------

/** `event` notification: full-fidelity forward of an agent event. */
export const eventNotificationSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.literal(EVENT_NOTIFICATION),
  params: eventSchema,
  /**
   * Journal cursor of this event ({seq, epoch}, ws-control heritage).
   * Present on durable events when the server keeps an event journal;
   * volatile events never carry one (they do not advance `seq`).
   */
  cursor: sessionCursorSchema.optional(),
});

/**
 * `resync_required{sessionId, reason, currentSeq, epoch}` — tells a
 * subscriber that its resume cursor cannot be honored (the journal's epoch
 * changed, or the requested seq fell out of the bounded ring buffer), so it
 * must rebuild session state from a `resumeSession` snapshot. camelCase
 * counterpart of the ws-control `resync_required` payload (v2 minimal slice).
 */
export const resyncRequiredParamsSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(['buffer_overflow', 'session_recreated', 'epoch_changed']),
  currentSeq: z.number().int().nonnegative(),
  epoch: z.string().min(1).optional(),
});
export type ResyncRequiredParams = z.infer<typeof resyncRequiredParamsSchema>;

/**
 * `interaction/resolved{sessionId, toolCallId}` — tells the client to take
 * down a pending approval/question UI because the core cleaned it up (turn
 * ended / cancelled). v1: schema-only; the TUI already derives this from
 * `turn.ended`, so the server does not emit it yet.
 */
export const interactionResolvedParamsSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
});
export type InteractionResolvedParams = z.infer<typeof interactionResolvedParamsSchema>;
