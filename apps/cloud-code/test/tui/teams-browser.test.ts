import type { Terminal } from '@cloud-code/pi-tui';
import type { Event, MailboxActivityMessage, TeamWire } from '@cloud-code/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '@/tui/commands/dispatch';
import { findBuiltInSlashCommand } from '@/tui/commands/registry';
import { resolveSlashCommandInput } from '@/tui/commands/resolve';
import {
  TeamsBrowserApp,
  type TeamsBrowserProps,
} from '@/tui/components/dialogs/teams-browser';
import {
  MAX_TEAM_ACTIVITY_ENTRIES,
  TeamTracker,
} from '@/tui/controllers/teams-tracker';
import { setLocalePreference, t } from '#/tui/i18n';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

afterEach(() => {
  setLocalePreference('en');
});

/** Minimal Terminal stub — only `rows` is read by the component. */
function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    enterAltScreen: () => {},
    exitAltScreen: () => {},
    setMouseReporting: () => {},
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses-1';

function ev(partial: Record<string, unknown> & { type: string }): Event {
  return { sessionId: SESSION_ID, agentId: 'main', ...partial } as unknown as Event;
}

function team(partial: Partial<TeamWire> = {}): TeamWire {
  return {
    name: 'core',
    createdBy: 'main',
    members: [
      { name: 'researcher', agentId: 'agent-1' },
      { name: 'writer', agentId: 'agent-2' },
    ],
    tasks: [
      { id: 1, subject: 'Map the ingestion surface', status: 'in_progress', owner: 'researcher', createdBy: 'leader', createdAt: 1 },
      { id: 2, subject: 'Profile the hot path', status: 'pending', createdBy: 'leader', createdAt: 2 },
      { id: 3, subject: 'Write the report', status: 'completed', owner: 'writer', createdBy: 'researcher', createdAt: 3 },
    ],
    ...partial,
  };
}

function activity(partial: Partial<MailboxActivityMessage> = {}): MailboxActivityMessage {
  return {
    id: 'msg_00000001',
    teamName: 'core',
    from: 'researcher',
    to: 'leader',
    kind: 'message',
    preview: 'ingestion map is done',
    createdAt: '2026-07-28T10:15:00.000Z',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// TeamTracker
// ---------------------------------------------------------------------------

describe('TeamTracker', () => {
  it('keeps the latest snapshot per team and notifies subscribers', () => {
    const tracker = new TeamTracker();
    const seen: string[] = [];
    tracker.subscribe(() => {
      seen.push('ping');
    });

    tracker.handleEvent(ev({ type: 'team.updated', team: team() }));
    tracker.handleEvent(
      ev({
        type: 'team.updated',
        team: team({ tasks: team().tasks.slice(0, 1) }),
      }),
    );
    tracker.handleEvent(ev({ type: 'team.updated', team: team({ name: 'infra', members: [], tasks: [] }) }));

    const teams = tracker.getTeams();
    expect(teams.map((entry) => entry.name)).toEqual(['core', 'infra']);
    // The latest core snapshot won outright (no merging).
    expect(tracker.getTeam('core')?.tasks).toHaveLength(1);
    expect(seen.length).toBe(3);

    // Unrelated events are ignored.
    tracker.handleEvent(ev({ type: 'turn.started', turnId: 1 }));
    expect(seen.length).toBe(3);
  });

  it('records mailbox activity, deduplicates by id, and filters per team', () => {
    const tracker = new TeamTracker();
    tracker.handleEvent(ev({ type: 'mailbox.activity', message: activity() }));
    // Replay after a reconnect delivers the same id again — kept once.
    tracker.handleEvent(ev({ type: 'mailbox.activity', message: activity() }));
    tracker.handleEvent(
      ev({ type: 'mailbox.activity', message: activity({ id: 'msg_00000002', teamName: 'infra' }) }),
    );

    expect(tracker.getActivity()).toHaveLength(2);
    expect(tracker.getActivity('core')).toHaveLength(1);
    expect(tracker.getActivity('core')[0]).toMatchObject({ from: 'researcher', to: 'leader' });
    expect(tracker.getActivity('infra')).toHaveLength(1);
  });

  it('caps the activity ring and forgets dropped ids', () => {
    const tracker = new TeamTracker();
    for (let i = 0; i < MAX_TEAM_ACTIVITY_ENTRIES + 5; i += 1) {
      tracker.handleEvent(
        ev({
          type: 'mailbox.activity',
          message: activity({ id: `msg_${String(i).padStart(8, '0')}` }),
        }),
      );
    }
    const entries = tracker.getActivity();
    expect(entries).toHaveLength(MAX_TEAM_ACTIVITY_ENTRIES);
    expect(entries[0]!.id).toBe(`msg_${String(5).padStart(8, '0')}`);
    // A dropped id may be recorded again (it is no longer deduped).
    tracker.handleEvent(
      ev({ type: 'mailbox.activity', message: activity({ id: `msg_${String(0).padStart(8, '0')}` }) }),
    );
    expect(tracker.getActivity()).toHaveLength(MAX_TEAM_ACTIVITY_ENTRIES);
  });

  it('reset clears teams and activity', () => {
    const tracker = new TeamTracker();
    tracker.handleEvent(ev({ type: 'team.updated', team: team() }));
    tracker.handleEvent(ev({ type: 'mailbox.activity', message: activity() }));
    tracker.reset();
    expect(tracker.getTeams()).toEqual([]);
    expect(tracker.getActivity()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TeamsBrowserApp
// ---------------------------------------------------------------------------

function makeProps(partial: Partial<TeamsBrowserProps> = {}): TeamsBrowserProps {
  return {
    teams: [],
    activity: [],
    memberLiveness: new Map(),
    selectedTeamName: undefined,
    onSelect: () => {},
    onCancel: () => {},
    ...partial,
  };
}

function makeApp(
  partial: Partial<TeamsBrowserProps> = {},
  rows = 30,
  columns = 120,
): TeamsBrowserApp {
  return new TeamsBrowserApp(makeProps(partial), fakeTerminal(rows, columns));
}

describe('TeamsBrowserApp', () => {
  it('renders the empty state when no teams exist', () => {
    const app = makeApp();
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain(t('teams.title'));
    // The list frame truncates to its column width; the head survives.
    expect(out).toContain('No teams yet');
    expect(out).toContain(t('teams.detail.empty'));
  });

  it('renders members with liveness, tasks with status/owner, and mailbox activity', () => {
    const app = makeApp({
      teams: [team()],
      activity: [activity()],
      memberLiveness: new Map([
        ['agent-1', 'running'],
        ['agent-2', 'completed'],
      ]),
      selectedTeamName: 'core',
    });
    const out = strip(app.render(120).join('\n'));

    // Header counts.
    expect(out).toContain(t('teams.count.teams', { count: 1 }).trim());
    expect(out).toContain(t('teams.count.activeTasks', { count: 1 }).trim());
    // Team list row.
    expect(out).toContain('core');
    // Members with joined liveness.
    expect(out).toContain('researcher');
    expect(out).toContain(t('teams.member.status.running'));
    expect(out).toContain('writer');
    expect(out).toContain(t('teams.member.status.completed'));
    // Shared tasks render as the sanctioned table: column headers over a rule,
    // then the rows with status and owner in their own columns.
    expect(out).toContain(t('teams.task.column.subject'));
    expect(out).toContain(t('teams.task.column.owner'));
    expect(out).toContain('#1');
    expect(out).toContain('Map the ingestion surface');
    expect(out).toContain(t('teams.task.status.in_progress'));
    expect(out).toContain(t('teams.task.unclaimed'));
    // Mailbox activity line.
    expect(out).toContain('researcher → leader');
    expect(out).toContain('ingestion map is done');
  });

  it('moves the selection with j/k and arrow keys, emitting onSelect', () => {
    const onSelect = vi.fn();
    const app = makeApp({
      teams: [team(), team({ name: 'infra', members: [], tasks: [] })],
      selectedTeamName: 'core',
      onSelect,
    });
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('infra');
    app.handleInput('k');
    expect(onSelect).toHaveBeenLastCalledWith('core');
    app.handleInput('[B');
    expect(onSelect).toHaveBeenLastCalledWith('infra');
    app.handleInput('[A');
    expect(onSelect).toHaveBeenLastCalledWith('core');
    // Selection stays within bounds.
    app.handleInput('k');
    expect(onSelect).toHaveBeenCalledTimes(4);
  });

  it('selecting another team swaps the detail pane', () => {
    const app = makeApp({
      teams: [
        team(),
        team({ name: 'infra', members: [{ name: 'ops', agentId: 'agent-9' }], tasks: [] }),
      ],
      selectedTeamName: 'infra',
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('ops');
    expect(out).toContain(t('teams.detail.noTasks'));
  });

  it('q and Escape invoke onCancel', () => {
    const onCancel = vi.fn();
    const app = makeApp({ teams: [team()], selectedTeamName: 'core', onCancel });
    app.handleInput('q');
    app.handleInput('');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('renders the too-small fallback below the minimum size', () => {
    const app = makeApp({ teams: [team()] }, 6, 40);
    const out = strip(app.render(40).join('\n'));
    // The message itself is truncated to the tiny width; the head survives.
    expect(out).toContain('Terminal too small');
    expect(out).not.toContain(t('teams.list.title'));
  });

  it('renders zh-CN strings when the locale is zh-CN', () => {
    setLocalePreference('zh-CN');
    const app = makeApp({
      teams: [team()],
      activity: [activity()],
      memberLiveness: new Map([['agent-1', 'running']]),
      selectedTeamName: 'core',
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('运行中');
    expect(out).toContain('进行中');
    expect(out).toContain('最近邮箱动态');
  });
});

// ---------------------------------------------------------------------------
// Command registration & dispatch
// ---------------------------------------------------------------------------

describe('/teams command', () => {
  it('is registered with the /team alias', () => {
    const command = findBuiltInSlashCommand('teams');
    expect(command?.name).toBe('teams');
    expect(command?.aliases).toContain('team');
    expect(findBuiltInSlashCommand('team')?.name).toBe('teams');
    expect(command?.description).toBe('teams.command.description');
    expect(t('teams.command.description')).toContain('teams');
  });

  it('resolves /team to the builtin teams intent', () => {
    const intent = resolveSlashCommandInput({
      input: '/team',
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
      isStreaming: false,
      isCompacting: false,
    });
    expect(intent).toMatchObject({ kind: 'builtin', name: 'teams' });
  });

  it('dispatch opens the teams browser', async () => {
    const show = vi.fn();
    const host = {
      state: { appState: { streamingPhase: 'idle', isCompacting: false } },
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
      teamsBrowserController: { show },
    } as unknown as SlashCommandHost;
    dispatchInput(host, '/teams');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).toHaveBeenCalledTimes(1);

    dispatchInput(host, '/team');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// TeamsBrowserApp — detail scrollbar (hover-revealed, right border)
// ---------------------------------------------------------------------------

describe('TeamsBrowserApp — detail scrollbar', () => {
  // rows 30 → pane inner rows 26; the track is component rows 2..27 on the
  // screen's last column (120).
  function bigTeam(): TeamWire {
    return team({
      members: Array.from({ length: 40 }, (_, i) => ({
        name: `member-${String(i).padStart(2, '0')}`,
        agentId: `agent-${i}`,
      })),
    });
  }
  function makeScrollableApp() {
    const app = makeApp({ teams: [bigTeam()], selectedTeamName: 'core' }, 30, 120);
    app.render(120);
    return app;
  }
  const press = (col: number, row: number) =>
    ({ type: 'press' as const, button: 0, col, row, slotRelative: false });
  const release = (col: number, row: number) =>
    ({ type: 'release' as const, button: 0, col, row, slotRelative: false });

  it('declares the scrollbar zone only while the detail pane scrolls', () => {
    const app = makeScrollableApp();
    const zones = [...app.hitZones()];
    expect(zones.find((z) => z.id === 'scrollbar:detail')).toMatchObject({
      row: 2,
      col: 120,
      width: 1,
      height: 26,
    });

    const fitted = makeApp({ teams: [team()], selectedTeamName: 'core' }, 30, 120);
    fitted.render(120);
    expect([...fitted.hitZones()].some((z) => z.id === 'scrollbar:detail')).toBe(false);
  });

  it('reveals while its zone is hovered and hides on leave', () => {
    const app = makeScrollableApp();
    expect(strip(app.render(120).join('\n'))).not.toContain('░');

    app.setHoveredZone('scrollbar:detail');
    const shown = app.render(120).map(strip);
    expect(shown[27]!.endsWith('█')).toBe(true); // tail-pinned: thumb at the bottom
    expect(shown[2]!.endsWith('░')).toBe(true);
    expect(shown[1]!.includes('░')).toBe(false); // frame top border is not the track

    app.setHoveredZone(null);
    expect(strip(app.render(120).join('\n'))).not.toContain('░');
  });

  it('track press jumps the pane to the pointed fraction', () => {
    const app = makeScrollableApp();
    // Tail-pinned by default: the last member is visible, the first is not.
    let out = strip(app.render(120).join('\n'));
    expect(out).toContain('member-39');
    expect(out).not.toContain('member-00');

    app.handleMouse(press(120, 2)); // track top → window top
    out = strip(app.render(120).join('\n'));
    expect(out).toContain('member-00');
    expect(out).not.toContain('member-39');
    app.handleMouse(release(120, 2));
  });

  it('drag maps continuously until the release', () => {
    const app = makeScrollableApp();
    app.handleMouse(press(120, 27)); // bottom (stays at the tail)
    app.handleMouse({ type: 'motion', button: 0, col: 120, row: 2, slotRelative: false });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('member-00');
    app.handleMouse(release(120, 2));
    // Plain motion afterwards does not scroll.
    app.handleMouse({ type: 'motion', button: 3, col: 120, row: 27, slotRelative: false });
    expect(strip(app.render(120).join('\n'))).toContain('member-00');
  });

  it('stays revealed while the drag runs off the bar column', () => {
    const app = makeScrollableApp();
    app.handleMouse(press(120, 27)); // grabs the thumb at the tail
    app.handleMouse({ type: 'motion', button: 0, col: 60, row: 27, slotRelative: false });
    const shown = app.render(120).map(strip);
    expect(shown[27]!.endsWith('█')).toBe(true); // drag capture keeps the bar drawn
    expect(shown[2]!.endsWith('░')).toBe(true);
    app.handleMouse(release(60, 27));
    // Never hovered: once the drag ends, the bar hides again.
    expect(strip(app.render(120).join('\n'))).not.toContain('░');
  });

  it('maps the drag against the press-time geometry when content changes mid-drag', () => {
    const app = makeScrollableApp(); // 40 members → content 51, maxScroll 25
    app.handleMouse(press(120, 27)); // grabs the thumb (rows 13..25), 12 from its top
    app.handleMouse({ type: 'motion', button: 0, col: 120, row: 8, slotRelative: false });
    expect(strip(app.render(120).join('\n'))).toContain('member-00');

    // The content doubles mid-drag; the session keeps the old geometry.
    app.setProps(
      makeProps({
        teams: [
          team({
            members: Array.from({ length: 80 }, (_, i) => ({
              name: `member-${String(i).padStart(2, '0')}`,
              agentId: `agent-${i}`,
            })),
          }),
        ],
        selectedTeamName: 'core',
      }),
    );
    // Track row 18 − grab 12 → thumb top 6 of 13 → scrollTop round(6/13·25) = 12
    // (a live re-derivation would land on 21, hiding member-11).
    app.handleMouse({ type: 'motion', button: 0, col: 120, row: 20, slotRelative: false });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('member-11');
    expect(out).not.toContain('member-00');
    app.handleMouse(release(120, 20));
    // The release re-settles against the live content — position holds here.
    expect(strip(app.render(120).join('\n'))).toContain('member-11');
  });
});
