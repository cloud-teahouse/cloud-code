/**
 * `/sandbox` — transcript status block for the OS command sandbox (mode,
 * backend probe, policy, config origin). The snapshot comes from the agent
 * over RPC so the report reflects the execution environment (and its probe
 * cache), not the TUI host — see agent-core `buildSandboxStatus`.
 */

import type { SandboxStatusData } from '@cloud-code/sdk';

import { buildSandboxStatusReportLines } from '../components/messages/sandbox-status-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

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
