import { visibleWidth } from '@cloud-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputResult,
} from '#/tui/components/dialogs/api-key-input-dialog';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function typeText(dialog: ApiKeyInputDialogComponent, text: string): void {
  for (const ch of text) dialog.handleInput(ch);
}

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Cloud Code CLI',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('resolves empty submits when allowEmpty is set', () => {
    const results: ApiKeyInputResult[] = [];
    const dialog = new ApiKeyInputDialogComponent('', ['sub'], (r) => results.push(r), {
      title: 't',
      allowEmpty: true,
    });
    dialog.handleInput('\r');
    expect(results).toEqual([{ kind: 'ok', value: '' }]);
  });

  it('still rejects empty submits by default with the empty hint', () => {
    const results: ApiKeyInputResult[] = [];
    const dialog = new ApiKeyInputDialogComponent('', ['sub'], (r) => results.push(r), {
      title: 't',
      emptyHint: 'Nope, required.',
    });
    dialog.focused = true;
    dialog.handleInput('\r');
    expect(results).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('Nope, required.');
  });

  it('shows the validate message on rejection, then accepts a corrected value', () => {
    const results: ApiKeyInputResult[] = [];
    const dialog = new ApiKeyInputDialogComponent('', ['sub'], (r) => results.push(r), {
      title: 't',
      validate: (v) => (v.startsWith('https://') ? undefined : 'Must start with https://'),
    });
    dialog.focused = true;

    typeText(dialog, 'http://x');
    dialog.handleInput('\r');
    expect(results).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('Must start with https://');

    // The typed value stays editable: fix the scheme in place.
    dialog.handleInput('\x1b[D'); // left ×4 lands before "://x"
    dialog.handleInput('\x1b[D');
    dialog.handleInput('\x1b[D');
    dialog.handleInput('\x1b[D');
    typeText(dialog, 's');
    dialog.handleInput('\r');
    expect(results).toEqual([{ kind: 'ok', value: 'https://x' }]);
  });

  it('prefills initialValue with the cursor at the end so typing appends', () => {
    const results: ApiKeyInputResult[] = [];
    const dialog = new ApiKeyInputDialogComponent('', ['sub'], (r) => results.push(r), {
      title: 't',
      initialValue: 'example',
    });
    typeText(dialog, '-2');
    dialog.handleInput('\r');
    expect(results).toEqual([{ kind: 'ok', value: 'example-2' }]);
  });

  it('esc cancels regardless of validation state', () => {
    const onDone = vi.fn();
    const dialog = new ApiKeyInputDialogComponent('', ['sub'], onDone, {
      title: 't',
      validate: () => 'always invalid',
    });
    typeText(dialog, 'x');
    dialog.handleInput(String.fromCodePoint(27));
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });
});
