// User-facing repo links must point at the PUBLIC repo (cloud-teahouse),
// never the private development repo.

import { describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import { CHANGELOG_URL } from '#/cli/update/prompt';
import {
  CLOUD_CODE_UPDATE_CHANNEL_BASE,
  FEEDBACK_ISSUE_URL,
  KIMI_CODE_OFFICIAL_INSTALL_URL,
} from '#/constant/app';

const PUBLIC_REPO_URL = 'https://github.com/cloud-teahouse/cloud-code';
const PRIVATE_REPO_MARKER = 'yspbwx2010';

describe('public repo links', () => {
  it('feedback issues open on the public repo', () => {
    expect(FEEDBACK_ISSUE_URL).toBe(`${PUBLIC_REPO_URL}/issues`);
  });

  it('the official install URL is the public repo', () => {
    expect(KIMI_CODE_OFFICIAL_INSTALL_URL).toBe(PUBLIC_REPO_URL);
  });

  it('the update channel is served from the public repo dev branch', () => {
    expect(CLOUD_CODE_UPDATE_CHANNEL_BASE).toBe(
      'https://raw.githubusercontent.com/cloud-teahouse/cloud-code/dev/release-channel',
    );
  });

  it('the update prompt changelog link is the public repo', () => {
    expect(CHANGELOG_URL).toBe(`${PUBLIC_REPO_URL}/blob/dev/apps/cloud-code/CHANGELOG.md`);
  });

  it('the --help documentation link is the public repo', () => {
    const program = createProgram('0.0.0-test', () => {});
    let help = '';
    program.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
      writeErr: () => {},
    });
    program.outputHelp();
    expect(help).toContain(PUBLIC_REPO_URL);
    expect(help).not.toContain(PRIVATE_REPO_MARKER);
  });
});
