import type { HookResultEvent } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';

export function formatHookResultMarkdown(event: HookResultEvent): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return event.blocked === true
    ? t('utils.hookResult.titleBlocked', { event: event.hookEvent })
    : t('utils.hookResult.title', { event: event.hookEvent });
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? t('utils.hookResult.empty') : content;
}
