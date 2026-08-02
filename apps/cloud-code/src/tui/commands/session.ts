import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Session } from '@cloud-code/sdk';

import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import { buildExportMarkdown } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? t('commands.title.current', { title: current })
        : t('commands.title.notSet', { id: host.state.appState.sessionId }),
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession({ id: session.id, title: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.title.failed', { error: msg }));
    return;
  }
  host.showStatus(t('commands.title.set', { title: newTitle }));
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  const sourceTitle = forkSourceTitle(host, session);
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: session.id,
      title: t('commands.fork.titlePrefix', { title: sourceTitle }),
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.fork.failed', { error: msg }));
    return;
  }

  try {
    await host.switchToSession(
      forked,
      t('commands.fork.success', {
        id: forked.id,
        command: `cloudcode -r ${session.id}`,
      }),
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.fork.switchFailed', { error: msg }));
  }
}

function forkSourceTitle(host: SlashCommandHost, session: Session): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

  const summaryTitle =
    typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
  return summaryTitle.length > 0 ? summaryTitle : session.id;
}

export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  host.showStatus(t('commands.exportMd.exporting'));
  try {
    const context = await session.getContext();
    if (context.history.length === 0) {
      host.showError(t('commands.exportMd.empty'));
      return;
    }

    const now = new Date();
    const shortId = session.id.slice(0, 8);
    const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
    const defaultName = `cloud-code-export-${shortId}-${timestamp}.md`;

    const trimmedArgs = args.trim();
    const outputPath = trimmedArgs.length > 0
      ? resolve(trimmedArgs)
      : resolve(host.state.appState.workDir, defaultName);

    const md = buildExportMarkdown({
      sessionId: session.id,
      workDir: host.state.appState.workDir,
      history: context.history,
      tokenCount: context.tokenCount,
      now,
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, md, 'utf-8');

    const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
    // The exported path is an actionable link — keep it in the transcript so a
    // later transient notice can't replace it.
    host.showNotice(t('commands.exportMd.exported', { count: context.history.length }), linked, {
      transcript: true,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.export.failed', { error: msg }));
  }
}

export async function handleExportDebugZipCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }

  host.showStatus(t('commands.exportDebugZip.exporting'));
  try {
    const installSource = await detectInstallSource();
    const shellEnv = detectShellEnvironment();
    const result = await host.harness.exportSession({
      id: session.id,
      version: host.state.appState.version,
      installSource,
      shellEnv,
      includeGlobalLog: true,
    });
    const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
    // Same as the markdown export above: the zip link must survive later notices.
    host.showNotice(t('commands.exportDebugZip.complete'), linked, { transcript: true });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('commands.export.failed', { error: msg }));
  }
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await session.init();
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(t('commands.init.failed', { error: msg }));
  } finally {
    host.deferUserMessages = false;
  }
}
