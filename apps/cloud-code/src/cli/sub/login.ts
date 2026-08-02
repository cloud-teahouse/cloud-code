/**
 * `cloud-code login` — drive the OAuth device-code flow non-interactively.
 * The `authMethods.terminal-auth.args=['login']` (legacy `_meta` path)
 * advertised by the ACP server points clients at this entry point. The
 * first-class ACP `args=['--login']` path enters the same flow via
 * `cloud-code acp --login`.
 */

import type { Command } from 'commander';

import { runLoginFlow } from './login-flow';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description('Authenticate with Cloud Code CLI via the device-code flow.')
    .option(
      '--platform <platform>',
      'Platform to authenticate with (e.g. chatgpt-codex for ChatGPT Codex OAuth).',
    )
    .action(async (options: { platform?: string }) => {
      await runLoginFlow({ platform: options.platform });
    });
}
