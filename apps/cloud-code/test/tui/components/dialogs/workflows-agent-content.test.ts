import { describe, expect, it } from 'vitest';

import { statusColor } from '#/tui/components/dialogs/workflows-agent-content';

describe('workflow agent statusColor', () => {
  it('paints completion marks in success green', () => {
    expect(statusColor('done')).toBe('success');
    expect(statusColor('running')).toBe('success');
  });

  it('keeps non-terminal idle states muted and failures loud', () => {
    expect(statusColor('idle')).toBe('textMuted');
    expect(statusColor('waiting')).toBe('textMuted');
    expect(statusColor('suspended')).toBe('warning');
    expect(statusColor('failed')).toBe('error');
    expect(statusColor('killed')).toBe('error');
  });
});
