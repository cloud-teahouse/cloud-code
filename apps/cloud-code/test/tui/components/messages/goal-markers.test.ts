import { visibleWidth } from '@cloud-code/pi-tui';
import type { MouseEvent } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { SwarmModeMarkerComponent } from '#/tui/components/messages/swarm-markers';
import { buildGoalMarker, GoalMarkerComponent } from '#/tui/components/messages/goal-markers';
import { setLocalePreference } from '#/tui/i18n';
import type { GoalChange } from '@cloud-code/sdk';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
}

describe('buildGoalMarker', () => {
  it('builds lifecycle markers for paused / resumed / blocked', () => {
    const paused = buildGoalMarker({ kind: 'lifecycle', status: 'paused' } as GoalChange, false);
    const resumed = buildGoalMarker({ kind: 'lifecycle', status: 'active' } as GoalChange, false);
    const blocked = buildGoalMarker({ kind: 'lifecycle', status: 'blocked' } as GoalChange, false);
    expect(strip(paused!.render(80))).toContain('Goal paused');
    expect(strip(resumed!.render(80))).toContain('Goal resumed');
    expect(strip(blocked!.render(80))).toContain('Goal blocked');
  });

  it('renders user interruption pause and user resume as prominent markers', () => {
    const paused = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason: 'Paused after interruption' } as GoalChange,
      false,
      'runtime',
    );
    const resumed = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } as GoalChange,
      false,
      'user',
    );

    expect(strip(paused!.render(80))).toBe("\n● Goal paused due to user's interruption");
    expect(strip(resumed!.render(80))).toBe('\n● Goal resumed by the user.');
    expect(strip([...paused!.render(80), ...resumed!.render(80)])).toBe(
      "\n● Goal paused due to user's interruption\n\n● Goal resumed by the user.",
    );
  });

  it('does not repeat paused for runtime pause reasons', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason: 'Paused after runtime error: socket hang up' } as GoalChange,
      false,
      'runtime',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused after runtime error: socket hang up');
  });

  it('renders coded pause reasons with the detail appended', () => {
    const marker = buildGoalMarker(
      {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after provider API error: 400 bad request',
        reasonCode: 'provider_api',
        reasonDetail: '400 bad request',
      } as GoalChange,
      false,
      'runtime',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused after provider API error: 400 bad request');
  });

  it('renders coded pause reasons localized in zh-CN', () => {
    setLocalePreference('zh-CN');
    try {
      const interrupted = buildGoalMarker(
        {
          kind: 'lifecycle',
          status: 'paused',
          reason: 'Paused after interruption',
          reasonCode: 'interruption',
        } as GoalChange,
        false,
        'runtime',
      );
      const rateLimited = buildGoalMarker(
        {
          kind: 'lifecycle',
          status: 'paused',
          reason: 'Paused after provider rate limit',
          reasonCode: 'rate_limit',
        } as GoalChange,
        false,
        'runtime',
      );

      expect(strip(interrupted!.render(80))).toBe('\n● 目标因用户中断而暂停');
      expect(strip(rateLimited!.render(80))).toBe('\n● 目标因提供商速率限制而暂停');
    } finally {
      setLocalePreference('en');
    }
  });

  it('keeps long provider pause markers within the terminal width', () => {
    const reason =
      'Paused after provider API error: 400 {"error":{"message":"request id: 456043b9-6491-11f1-9425-2221bb1af97c, \\"thinking.enabled\\" is not supported for this model. Use \\"thinking.adaptive\\" and \\"output_config.effort\\" to control thinking behavior.","type":"invalid_request_error"}}';
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason } as GoalChange,
      false,
      'runtime',
    );

    const width = 80;
    expect(strip(marker!.render(width))).toContain('Goal paused after provider API error');
    for (const line of marker!.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('attributes model pause and resume markers to the agent', () => {
    const paused = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused' } as GoalChange,
      false,
      'model',
    );
    const resumed = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } as GoalChange,
      false,
      'model',
    );

    expect(strip(paused!.render(80))).toBe('\n● Goal paused by the agent.');
    expect(strip(resumed!.render(80))).toBe('\n● Goal resumed by the agent.');
  });

  it('returns null for a completion change (it posts its own message)', () => {
    expect(
      buildGoalMarker({ kind: 'completion', status: 'complete' } as GoalChange, false),
    ).toBeNull();
  });
});

describe('GoalMarkerComponent', () => {
  it('hides the reason until expanded, with a ctrl+o hint', () => {
    const marker = new GoalMarkerComponent('Goal: no progress', 'still spinning', 'warning');
    const collapsed = strip(marker.render(80));
    expect(collapsed).toContain('Goal: no progress');
    expect(collapsed).toContain('(ctrl+o)');
    expect(collapsed).not.toContain('still spinning');

    marker.setExpanded(true);
    const expanded = strip(marker.render(80));
    expect(expanded).toContain('still spinning');
    expect(expanded).not.toContain('(ctrl+o)');
  });

  it('renders a single line when there is no reason', () => {
    const marker = new GoalMarkerComponent('Goal paused', undefined, 'textDim');
    expect(marker.render(80)).toHaveLength(1);
    expect(strip(marker.render(80))).not.toContain('(ctrl+o)');
  });
});

describe('GoalMarkerComponent — click/hover affordance', () => {
  const mouse = undefined as unknown as MouseEvent;

  const expandable = (): GoalMarkerComponent =>
    new GoalMarkerComponent('Goal: no progress', 'still spinning', 'warning');

  it('declares a hit zone only while a detail exists to reveal', () => {
    const marker = expandable();
    marker.render(80);
    expect([...marker.hitZones()]).toHaveLength(1);

    // No detail: nothing to reveal — no zone.
    const plain = new GoalMarkerComponent('Goal paused', undefined, 'textDim');
    plain.render(80);
    expect([...plain.hitZones()]).toEqual([]);

    // Detail present but expansion disabled (prominent markers): no zone.
    const nonExpandable = new GoalMarkerComponent('Goal paused', 'still spinning', 'warning', {
      expandable: false,
    });
    nonExpandable.render(80);
    expect([...nonExpandable.hitZones()]).toEqual([]);
  });

  it('toggles the detail via clicks on the zone', () => {
    const marker = expandable();
    marker.render(80);
    const zone = [...marker.hitZones()][0]!;
    expect(strip(marker.render(80))).toContain('(ctrl+o)');

    marker.onHitZone(zone.id, mouse);
    expect(strip(marker.render(80))).toContain('still spinning');

    // The zone stays while expanded so a click can fold the detail back.
    expect([...marker.hitZones()]).toHaveLength(1);
    marker.onHitZone(zone.id, mouse);
    const collapsed = strip(marker.render(80));
    expect(collapsed).not.toContain('still spinning');
    expect(collapsed).toContain('(ctrl+o)');
  });

  it('whitens the marker on hover and restores on leave', () => {
    // Force truecolor so the hover whiten shows up as changed ANSI codes.
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const marker = expandable();
      const normal = marker.render(80);
      const zone = [...marker.hitZones()][0]!;
      expect(marker.setHoveredZone(zone.id)).not.toBe(false);
      expect(marker.render(80)[0]).not.toBe(normal[0]);
      expect(marker.setHoveredZone(null)).not.toBe(false);
      expect(marker.render(80)[0]).toBe(normal[0]);
    } finally {
      chalk.level = previousLevel;
    }
  });
});

describe('SwarmModeMarkerComponent', () => {
  it('keeps marker lines within very narrow widths', () => {
    const marker = new SwarmModeMarkerComponent('active');

    for (const width of [1, 2, 10, 39]) {
      for (const line of marker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
