import { CLOUD_CODE_ERROR_INFO, isCloudCodeError } from '@cloud-code/sdk';
import { chalkStderr } from 'chalk';

import { STARTUP_ERROR_COLOR } from '#/constant/startup-error';
import { t } from '#/tui/i18n';

export interface StartupErrorFormatOptions {
  readonly errorStyle?: (text: string) => string;
  readonly operation?: string;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatStartupError(
  error: unknown,
  options: StartupErrorFormatOptions = {},
): string {
  const errorStyle = options.errorStyle ?? chalkStderr.hex(STARTUP_ERROR_COLOR);

  if (!isCloudCodeError(error)) {
    const operation = options.operation ?? t('status.startupError.operationDefault');
    return `${errorStyle(t('status.startupError.failed', { operation, message: formatUnknownErrorMessage(error) }))}\n`;
  }

  const info = CLOUD_CODE_ERROR_INFO[error.code];
  const lines = [
    errorStyle(`error: ${info.title}`),
    '',
    errorStyle(t('status.startupError.messageLabel')),
    errorStyle(error.message),
  ];

  return `${lines.join('\n')}\n`;
}
