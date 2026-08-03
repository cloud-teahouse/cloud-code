import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellRunComponent hardening', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    // Always clear the 1s timer so it can't keep the test process alive or
    // fire requestRender after the test ends.
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it('caps the running buffer and never throws on huge streaming output', () => {
    const c = create();
    const chunk = 'x'.repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });

  it('finish switches to the final view and ignores later appends', () => {
    const c = create();
    c.finish('final output', '', false);
    c.append('should be ignored');
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('final output');
    expect(rendered).not.toContain('should be ignored');
  });

  it('finishBackgrounded renders the background hint', () => {
    const c = create();
    c.finishBackgrounded();
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('Moved to background.');
  });

  it('renders body rows in the command-output shape', () => {
    const c = create();
    c.append('out1\nout2\n');
    const rendered = c.render(100).map(stripTheme);
    const out1 = rendered.find((l) => l.includes('out1'));
    const out2 = rendered.find((l) => l.includes('out2'));
    // First output row opens with `⎿` flush left (the dialog cards' ● bullet
    // column, aligned with the `$` echo above); later rows align under the
    // text on the dialog text column.
    expect(out1).toMatch(/^⎿ /u);
    expect(out2).toMatch(/^ {2}/u);
    expect(stripTheme(out2 ?? '').trim()).toBe('out2');
    // Command cards never carry the tree gutter.
    expect(rendered.every((l) => !l.includes('├─') && !l.includes('└─'))).toBe(true);
  });

  it('opens the final view with the output mark after finish', () => {
    const c = create();
    c.finish('final output', '', false);
    const rendered = c.render(100).map(stripTheme);
    const row = rendered.find((l) => l.includes('final output'));
    expect(row).toMatch(/^⎿ /u);
  });

  it('shows the dim no-output note when the command produced no output', () => {
    const c = create();
    c.finish('', '', false);
    const rendered = c.render(100).map(stripTheme);
    const row = rendered.find((l) => l.includes('(no output)'));
    expect(row).toMatch(/^⎿ /u);
  });

  it('folds long finished output to the preview cap with the expand hint', () => {
    const c = create();
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('line1');
    expect(rendered).toContain('line3');
    expect(rendered).not.toContain('line4');
    expect(rendered).toContain('... (7 more lines, ctrl+o to expand)');
  });

  it('expands and collapses the folded view via the keyboard (ctrl+o) path', () => {
    const c = create();
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);

    c.setExpanded(true);
    let rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('line10');
    expect(rendered).not.toContain('ctrl+o to expand');

    c.setExpanded(false);
    rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).not.toContain('line4');
    expect(rendered).toContain('ctrl+o to expand');
  });

  it('toggles expansion via a click on the card hit zone', () => {
    const c = create();
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);
    // A render must run before the hit-zone geometry exists.
    c.render(100);
    const zones = [...c.hitZones()];
    expect(zones).toHaveLength(1);

    c.onHitZone(zones[0]!.id, {} as never);
    let rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('line10');

    // A second click collapses the card again.
    c.onHitZone(zones[0]!.id, {} as never);
    rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).not.toContain('line4');
  });

  it('clears an individual click expansion via setClickExpanded(false), like the collapse-all pass', () => {
    const c = create();
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);
    c.render(100);
    const zone = [...c.hitZones()][0]!;
    c.onHitZone(zone.id, {} as never);
    expect(stripTheme(c.render(100).join('\n'))).toContain('line10');

    c.setClickExpanded(false);
    expect(stripTheme(c.render(100).join('\n'))).not.toContain('line4');
  });

  it('tracks hover state through setHoveredZone', () => {
    const c = create();
    // A capped finished view so the card has folded rows to expand into —
    // short outputs declare no zone at all.
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);
    c.render(100);
    const zone = [...c.hitZones()][0]!;
    expect(c.setHoveredZone(zone.id)).not.toBe(false);
    expect(c.setHoveredZone(zone.id)).toBe(false);
    expect(c.setHoveredZone(null)).not.toBe(false);
    expect(c.setHoveredZone(null)).toBe(false);
  });

  it('declares no hit zone while running or when the finished output fits', () => {
    const c = create();
    c.append('out1\nout2\n');
    c.render(100);
    expect([...c.hitZones()]).toEqual([]);
    c.finish('done', '', false);
    c.render(100);
    expect([...c.hitZones()]).toEqual([]);
  });

  it('keeps a keyboard expansion requested while running for the finished view', () => {
    const c = create();
    c.setExpanded(true);
    const stdout = Array.from({ length: 10 }, (_, i) => `line${String(i + 1)}`).join('\n');
    c.finish(stdout, '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('line10');
    expect(rendered).not.toContain('ctrl+o to expand');
  });

  it('does not fold the running tail (the tail window is the running fold)', () => {
    const c = create();
    c.append(Array.from({ length: 10 }, (_, i) => `row${String(i + 1)}\n`).join(''));
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('row10');
    expect(rendered).toContain('+5 lines');
    expect(rendered).not.toContain('ctrl+o to expand');
  });

  it('append / finish are no-ops after dispose', () => {
    const c = create();
    c.dispose();
    expect(() => {
      c.append('late');
      c.finish('late', '', false);
      c.finishBackgrounded();
      c.render(100);
    }).not.toThrow();
  });

  it('does not throw when the render callback throws', () => {
    const c = new ShellRunComponent(() => {
      throw new Error('render failed');
    });
    component = c;
    expect(() => {
      c.append('output');
      c.render(100);
    }).not.toThrow();
  });
});
