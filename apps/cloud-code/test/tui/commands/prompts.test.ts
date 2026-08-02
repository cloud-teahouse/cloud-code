import { afterEach, describe, expect, it, vi } from 'vitest';

import { promptBaseUrl } from '#/tui/commands/prompts';
import type { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';
import { setLocalePreference } from '#/tui/i18n';

afterEach(() => {
  setLocalePreference('en');
});

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function makeHost() {
  const mounted: unknown[] = [];
  const host = {
    mountEditorReplacement: vi.fn((component: unknown) => {
      mounted.push(component);
      return {};
    }),
    restoreEditor: vi.fn(),
  };
  return { host, mounted };
}

describe('promptBaseUrl', () => {
  it('asks with the localized title, subtitle and empty hint in zh-CN', async () => {
    setLocalePreference('zh-CN');
    const { host, mounted } = makeHost();
    const promise = promptBaseUrl(host as never, 'Acme');

    const dialog = mounted[0] as ApiKeyInputDialogComponent;
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('输入 Acme 的 base URL');
    expect(out).toContain('目录未声明该 provider 的端点');

    // Empty submit surfaces the localized inline hint.
    dialog.handleInput('\r');
    const withHint = strip(dialog.render(80).join('\n'));
    expect(withHint).toContain('base URL 不能为空。');

    // Esc cancels the prompt.
    dialog.handleInput(String.fromCodePoint(27));
    await expect(promise).resolves.toBeUndefined();
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  it('asks with the English strings by default', async () => {
    const { host, mounted } = makeHost();
    const promise = promptBaseUrl(host as never, 'Acme');

    const dialog = mounted[0] as ApiKeyInputDialogComponent;
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Enter base URL for Acme');
    expect(out).toContain('The catalog declares no endpoint for this provider');

    dialog.handleInput(String.fromCodePoint(27));
    await expect(promise).resolves.toBeUndefined();
  });
});
