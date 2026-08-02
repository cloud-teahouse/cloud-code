/**
 * Shared device-code login flow used by both `cloud-code login` (top-level
 * subcommand) and `cloud-code acp --login` (the first-class ACP terminal-auth
 * entry point). Exiting the process is part of the contract — callers
 * MUST treat the returned promise as `Promise<never>`.
 *
 * `--platform chatgpt-codex` selects the ChatGPT Codex (OAuth) variant:
 * authorization-code + PKCE with a localhost callback server, plus a
 * paste-the-callback-URL fallback for headless / remote environments where
 * the browser cannot reach this machine's localhost.
 */

import { createInterface } from 'node:readline/promises';

import { CHATGPT_CODEX_PROVIDER_NAME } from '@cloud-code/oauth';
import { createCloudCodeHarness } from '@cloud-code/sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { openUrl } from '#/utils/open-url';

export interface LoginFlowOptions {
  /** Platform id from `cloud-code login --platform <id>`; defaults to Kimi. */
  readonly platform?: string | undefined;
}

export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<never> {
  if (options.platform === 'chatgpt-codex') {
    return runChatGptCodexLoginFlow();
  }
  return runCloudCodeLoginFlow();
}

async function runCloudCodeLoginFlow(): Promise<never> {
  const identity = createKimiCodeHostIdentity();
  const harness = createCloudCodeHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            `Opening browser for Kimi device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
            data.expiresIn !== null && data.expiresIn !== undefined
              ? `Code expires in ${data.expiresIn}s.`
              : undefined,
            'Waiting for authorization to complete...',
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}

/**
 * ChatGPT Codex headless login. The localhost callback server still runs
 * (same-machine browsers reach it directly); on remote/headless setups the
 * user opens the printed URL elsewhere and pastes either the full callback
 * URL (which fails to load remotely) or the bare authorization code.
 */
async function runChatGptCodexLoginFlow(): Promise<never> {
  const identity = createKimiCodeHostIdentity();
  const harness = createCloudCodeHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });

  let rl: ReturnType<typeof createInterface> | undefined;
  const waitForManualCode = (): Promise<string | undefined> => {
    rl = createInterface({ input: process.stdin, output: process.stderr });
    const onAbort = (): void => {
      rl?.close();
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    return rl
      .question('Paste the callback URL or authorization code here: ')
      .then((answer) => (answer.trim().length > 0 ? answer : undefined))
      .catch(() => undefined)
      .finally(() => {
        controller.signal.removeEventListener('abort', onAbort);
        rl?.close();
        rl = undefined;
      });
  };

  try {
    const result = await harness.auth.login(CHATGPT_CODEX_PROVIDER_NAME, {
      signal: controller.signal,
      waitForManualCode,
      onAuthorizeUrl: (url) => {
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL.
        process.stderr.write(
          [
            '',
            `Opening browser for ChatGPT login: ${url}`,
            'If the browser did not open, paste the URL above into a browser on any machine.',
            'On a remote/headless host the callback page will fail to load — copy its full URL',
            '(http://localhost:1455/auth/callback?code=...) and paste it below instead.',
            '',
          ].join('\n'),
        );
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(`\nLogged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}
