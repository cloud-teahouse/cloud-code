/**
 * Constants for the /feedback command — endpoints and the status messages
 * shown around the feedback submission flow.
 *
 * Dialog-internal copy (the box title, subtitle, footer) lives next to
 * the dialog component itself, since it is part of that component's
 * visual contract.
 */

import { FEEDBACK_VERSION_PREFIX } from '#/constant/app';
import { t } from '#/tui/i18n';

export { FEEDBACK_ISSUE_URL, FEEDBACK_VERSION_PREFIX } from '#/constant/app';

// Status messages shown around the feedback submission flow. These store
// i18n KEYS (status.feedback.*); consumers resolve them with
// `resolveDescription()` at display time.
export const FEEDBACK_STATUS_SUBMITTING = 'status.feedback.submitting';
export const FEEDBACK_STATUS_UPLOADING = 'status.feedback.uploading';
export const FEEDBACK_STATUS_SUCCESS = 'status.feedback.success';
export const FEEDBACK_STATUS_CANCELLED = 'status.feedback.cancelled';
export const FEEDBACK_STATUS_NETWORK_ERROR = 'status.feedback.networkError';
export const FEEDBACK_STATUS_FALLBACK = 'status.feedback.fallback';
export const FEEDBACK_STATUS_NOT_SIGNED_IN = 'status.feedback.notSignedIn';
export const FEEDBACK_STATUS_UPLOAD_FAILED = 'status.feedback.uploadFailed';

export function feedbackHttpErrorMessage(status: number): string {
  return t('status.feedback.httpError', { status });
}

export function feedbackSessionLine(sessionId: string): string {
  return t('status.feedback.sessionLine', { sessionId });
}

export function feedbackIdLine(feedbackId: number): string {
  return t('status.feedback.idLine', { feedbackId });
}

// Hint shown beneath session-level error messages in the TUI to point users
// at the `/export-debug-zip` workflow so they can share diagnostics with us.
export function errorReportHintLine(): string {
  return t('status.feedback.errorReportHint');
}

export function withFeedbackVersionPrefix(version: string): string {
  return `${FEEDBACK_VERSION_PREFIX}${version}`;
}
