import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type { PendingApproval } from '#/tui/reverse-rpc/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePending(): PendingApproval {
  return {
    data: {
      id: 'approval_1',
      tool_call_id: 'tool_1',
      tool_name: 'WriteFile',
      action: 'write a file',
      description: 'Update README.md',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
    },
  };
}

function makeDialog(): {
  dialog: ApprovalPanelComponent;
  responses: Array<{ response: string; feedback?: string | undefined }>;
} {
  const responses: Array<{ response: string; feedback?: string | undefined }> = [];
  const dialog = new ApprovalPanelComponent(makePending(), (response) => responses.push(response));
  return { dialog, responses };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(dialog: ApprovalPanelComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(dialog.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return dialog.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(dialog: ApprovalPanelComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(dialog.hitZones(), row, col, 'hover');
  return dialog.setHoveredZone(zone?.id ?? null);
}

describe('ApprovalPanelComponent hit zones', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  it('declares one full-width zone per choice, aligned with the rendered rows', () => {
    const { dialog } = makeDialog();
    const lines = dialog.render(80).map(strip);
    const zones = [...dialog.hitZones()];
    expect(zones).toHaveLength(4);
    for (const [idx, zone] of zones.entries()) {
      expect(zone.id).toBe(idx);
      expect(zone.col).toBe(1);
      expect(zone.width).toBe(80);
      // The zone covers the choice's label line (plus any helper lines).
      expect(strip(lines[zone.row] ?? '')).toContain(`${idx + 1}.`);
      expect(zone.height).toBeGreaterThanOrEqual(1);
    }
    // No overlap: zones partition the choice area in order.
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i]!.row).toBeGreaterThanOrEqual(zones[i - 1]!.row + zones[i - 1]!.height);
    }
  });

  it('grows the zone with the choice description lines', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_desc',
        tool_call_id: 'tool_desc',
        tool_name: 'CreateGoal',
        action: 'Creating a goal',
        description: '',
        display: [],
        choices: [
          {
            label: 'Switch to Auto and start',
            response: 'approved',
            description: 'Tools are approved automatically, and questions are skipped.',
          },
          { label: 'Do not start', response: 'cancelled' },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {});
    const lines = dialog.render(80).map(strip);
    const [withDesc, withoutDesc] = [...dialog.hitZones()];
    expect(withDesc!.height).toBe(1 + 1); // label + one description line
    expect(withoutDesc!.height).toBe(1);
    // A press on the description line hits the same choice as the label line.
    expect(hitZoneAt([withDesc!], withDesc!.row + 1, 1, 'action')?.id).toBe(0);
    expect(lines[withDesc!.row + 1]).toContain('Tools are approved automatically');
  });

  it('dispatches a zone press to the choice: highlight, then re-click submits', () => {
    const { dialog, responses } = makeDialog();
    dialog.render(80);
    const zones = [...dialog.hitZones()];

    expect(dispatchPress(dialog, zones[1]!.row)).not.toBe(false);
    expect(responses).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 2. Approve for this session');

    dispatchPress(dialog, zones[1]!.row); // re-click submits, like Enter
    expect(responses).toEqual([{ response: 'approved_for_session' }]);
  });

  it('misses zones for presses outside them', () => {
    const { dialog, responses } = makeDialog();
    dialog.render(80);
    expect(dispatchPress(dialog, 0)).toBe(false); // top border
    expect(dispatchPress(dialog, 1)).toBe(false); // title
    expect(responses).toEqual([]);
  });

  it('underlines the hovered zone and clears on leave', () => {
    const { dialog } = makeDialog();
    dialog.render(80);
    const zones = [...dialog.hitZones()];
    const baseline = dialog.render(80).join('\n');

    expect(dispatchHover(dialog, zones[2]!.row)).not.toBe(false);
    const hovered = dialog.render(80).join('\n');
    expect(hovered).toContain('[4m');
    expect(hovered).not.toBe(baseline);

    expect(dispatchHover(dialog, zones[2]!.row)).toBe(false); // unchanged → frame skipped

    dispatchHover(dialog, -1); // pointer left the component
    expect(dialog.render(80).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { dialog } = makeDialog();
    dialog.render(80);
    dialog.handleMouse({ type: 'wheel', button: 65, col: 1, row: 2, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 2. Approve for this session');
    dialog.handleMouse({ type: 'wheel', button: 64, col: 1, row: 2, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 1. Approve once');
  });

  it('declares no zone for the armed feedback row; the other rows keep theirs', () => {
    const { dialog, responses } = makeDialog();
    dialog.render(80);
    const feedbackRow = [...dialog.hitZones()].find((zone) => zone.id === 3)!;
    // Highlight + re-click the requires-feedback choice to arm the input.
    dispatchPress(dialog, feedbackRow.row);
    dispatchPress(dialog, feedbackRow.row);
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 4. Reject with feedback');

    const zones = [...dialog.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 2]); // armed row suppressed
    // A press where the input row renders falls through to the input.
    expect(dispatchPress(dialog, feedbackRow.row)).toBe(false);
    // A press on another choice still leaves feedback mode and highlights it.
    dispatchPress(dialog, zones[0]!.row);
    expect(strip(dialog.render(80).join('\n'))).toContain('▶ 1. Approve once');
    expect(responses).toEqual([]);
  });
});
