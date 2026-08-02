/**
 * Keyboard tests for TeamsBrowserApp: Home/End jump the team selection to
 * the first/last row (PgUp/PgDn already page the detail pane).
 */

import type { TeamWire } from '@cloud-code/sdk';
import type { Terminal } from '@cloud-code/pi-tui';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TeamsBrowserApp, type TeamsBrowserProps } from '#/tui/components/dialogs/teams-browser';
import { setLocalePreference } from '#/tui/i18n';

const ESC = String.fromCodePoint(27);
/** Fixed clock so the relative-time cells render deterministically. */
const FIXED_NOW = new Date('2026-06-15T12:00:00Z').getTime();

const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

function team(name: string): TeamWire {
  return {
    name,
    createdBy: 'main',
    members: [
      { name: 'lead', agentId: `${name}-lead` },
      { name: 'worker', agentId: `${name}-worker` },
    ],
    tasks: [{ id: 1, subject: `task of ${name}`, status: 'in_progress', owner: 'lead' }],
  } as unknown as TeamWire;
}

function makeBrowser(over: Partial<TeamsBrowserProps> = {}) {
  const onSelect = vi.fn();
  const browser = new TeamsBrowserApp(
    {
      teams: [team('core'), team('infra'), team('tools')],
      activity: [],
      memberLiveness: new Map(),
      selectedTeamName: 'core',
      onSelect,
      onCancel: vi.fn(),
      ...over,
    },
    stubTerminal(),
  );
  browser.render(80);
  return { browser, onSelect };
}

describe('TeamsBrowserApp keyboard', () => {
  beforeAll(() => {
    setLocalePreference('en');
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    setLocalePreference('auto');
    vi.useRealTimers();
  });

  it('Home/End jump the selection to the first/last team', () => {
    const { browser, onSelect } = makeBrowser();
    onSelect.mockClear();

    browser.handleInput(`${ESC}[F`); // End → last team
    expect(onSelect).toHaveBeenCalledWith('tools');

    browser.handleInput(`${ESC}[H`); // Home → first team
    expect(onSelect).toHaveBeenCalledWith('core');
  });
});
