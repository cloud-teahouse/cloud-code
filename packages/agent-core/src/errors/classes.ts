import type { CloudCodeErrorCode } from './codes';

export interface CloudCodeErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Kimi error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `CloudCodeErrorPayload` and must branch on `code` rather than class identity.
 */
export class CloudCodeError extends Error {
  readonly code: CloudCodeErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: CloudCodeErrorCode, message: string, options: CloudCodeErrorOptions = {}) {
    super(message);
    this.name = 'CloudCodeError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}
