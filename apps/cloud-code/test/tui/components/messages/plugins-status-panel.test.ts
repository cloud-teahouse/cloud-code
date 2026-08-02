import { afterEach, describe, expect, it } from 'vitest';

import type { PluginInfo, PluginSummary } from '@cloud-code/sdk';

import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from '#/tui/components/messages/plugins-status-panel';
import { setLocalePreference } from '#/tui/i18n';

afterEach(() => {
  setLocalePreference('en');
});

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function makePlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'demo',
    displayName: 'Demo',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'zip-url',
    originalSource: 'https://plugins.example.com/demo.zip',
    ...overrides,
  };
}

function makeInfo(overrides: Partial<PluginSummary> = {}): PluginInfo {
  return {
    ...makePlugin(overrides),
    root: '/tmp/demo',
    installedAt: '2026-07-01T00:00:00Z',
    mcpServers: [],
    diagnostics: [],
  };
}

const OFFICIAL_SOURCE = 'https://code.kimi.com/kimi-code/plugins/official/demo.zip';
const CURATED_SOURCE = 'https://code.kimi.com/kimi-code/plugins/curated/demo.zip';

describe('buildPluginsListLines trust badges', () => {
  it('renders the badge words in English by default', () => {
    const lines = buildPluginsListLines({
      plugins: [
        makePlugin({ id: 'a', originalSource: OFFICIAL_SOURCE }),
        makePlugin({ id: 'b', originalSource: CURATED_SOURCE }),
        makePlugin({ id: 'c' }),
      ],
    }).map(strip);
    const out = lines.join('\n');
    expect(out).toContain('[official]');
    expect(out).toContain('[curated]');
    expect(out).toContain('[third-party]');
  });

  it('localizes the badge words in zh-CN', () => {
    setLocalePreference('zh-CN');
    const lines = buildPluginsListLines({
      plugins: [
        makePlugin({ id: 'a', originalSource: OFFICIAL_SOURCE }),
        makePlugin({ id: 'b', originalSource: CURATED_SOURCE }),
        makePlugin({ id: 'c' }),
      ],
    }).map(strip);
    const out = lines.join('\n');
    expect(out).toContain('[官方]');
    expect(out).toContain('[精选]');
    expect(out).toContain('[第三方]');
    expect(out).not.toContain('[official]');
  });
});

describe('buildPluginsInfoLines trust line', () => {
  it('localizes the badge word in zh-CN', () => {
    setLocalePreference('zh-CN');
    const lines = buildPluginsInfoLines({
      info: makeInfo({ originalSource: OFFICIAL_SOURCE }),
    }).map(strip);
    const trustLine = lines.find((line) => line.includes('信任：'));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain('官方');
    expect(trustLine).not.toContain('official');
  });
});
