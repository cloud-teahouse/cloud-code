/**
 * `/sandbox` — the OS command sandbox surface:
 *   bare / `status`  transcript report (mode, backend probe, policy, config
 *                    origin) via the agent-side snapshot — see agent-core
 *                    `buildSandboxStatus`;
 *   `on` / `off`     session-scoped runtime override (applies to the next
 *                    command spawn, no tool rebuild) plus a persisted
 *                    `[sandbox] mode` write so future sessions follow.
 */

import type { SandboxStatusData } from '@cloud-code/sdk';

import { buildSandboxStatusReportLines } from '../components/messages/sandbox-status-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleSandboxCommand(host: SlashCommandHost, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg === '' || arg === 'status') {
    await showSandboxStatus(host);
    return;
  }
  if (arg !== 'on' && arg !== 'off') {
    host.showError(t('commands.sandbox.usage'));
    return;
  }
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const mode = arg === 'on' ? ('auto' as const) : ('off' as const);
  try {
    await session.setSandboxMode(mode);
  } catch (error) {
    host.showError(t('commands.sandbox.toggleFailed', { error: formatErrorMessage(error) }));
    return;
  }
  try {
    await host.harness.setConfig({ sandbox: { mode } });
  } catch (error) {
    host.showError(t('commands.sandbox.persistFailed', { error: formatErrorMessage(error) }));
    return;
  }

  host.showStatus(
    mode === 'off' ? t('commands.sandbox.disabled') : t('commands.sandbox.enabled'),
    mode === 'off' ? 'warning' : 'success',
  );
}

export async function showSandboxStatus(host: SlashCommandHost): Promise<void> {
  let status: SandboxStatusData;
  try {
    status = await host.requireSession().getSandboxStatus();
  } catch (error) {
    host.showError(t('commands.sandbox.loadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const panel = new UsagePanelComponent(
    () => buildSandboxStatusReportLines({ status }),
    'primary',
    ` ${t('panels.sandbox.title')} `,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}
