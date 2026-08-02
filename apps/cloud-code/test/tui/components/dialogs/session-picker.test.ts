import { visibleWidth } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderPlain(component: SessionPickerComponent, width = 120): string {
  return stripAnsi(component.render(width).join('\n'));
}

const BACKSPACE = String.fromCodePoint(127);
const ESC = String.fromCodePoint(27);

describe('SessionPickerComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards Ctrl-C and Ctrl-D to optional host shortcuts', () => {
    const onCtrlC = vi.fn();
    const onCtrlD = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onCtrlC,
      onCtrlD,
    });

    component.handleInput('\u0003');
    component.handleInput('\u0004');

    expect(onCtrlC).toHaveBeenCalledOnce();
    expect(onCtrlD).toHaveBeenCalledOnce();
  });

  it('renders millisecond updated_at timestamps as relative times', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_minutes',
          title: 'minutes old',
          work_dir: '/tmp/project',
          updated_at: now - 2 * 60 * 1000,
        },
        {
          id: 'ses_hours',
          title: 'hours old',
          work_dir: '/tmp/project',
          updated_at: now - 3 * 60 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('2m ago');
    expect(output).toContain('3h ago');
    expect(output).not.toContain('just now');
  });

  it('renders title, full session id, work_dir, and last_prompt for each session', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_01HXYABCDEFGHIJK',
          title: 'Refactor sessions list',
          last_prompt: 'please redesign the picker UI',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('Refactor sessions list');
    // Session id is rendered in full, never abbreviated with an ellipsis.
    expect(output).toContain('ses_01HXYABCDEFGHIJK');
    expect(output).not.toMatch(/ses_01\S*…/);
    expect(output).toContain('/tmp/project');
    expect(output).toContain('please redesign the picker UI');
  });

  it('omits the last-prompt row when last_prompt is missing', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_no_prompt',
          title: 'no prompt yet',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).not.toMatch(/^\s*›/m);
  });

  it('truncates overly long last_prompt content', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const longPrompt = 'a'.repeat(500);
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_long',
          title: 'long prompt',
          last_prompt: longPrompt,
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(60).map((line) => stripAnsi(line));
    const promptLine = lines.find((line) => line.trimStart().startsWith('›'));
    expect(promptLine).toBeDefined();
    expect(promptLine!.length).toBeLessThanOrEqual(60);
    expect(promptLine!.endsWith('…')).toBe(true);
    expect(promptLine).not.toContain(longPrompt);
  });

  it('marks the current session with a "← current" badge', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_current',
          title: 'this is current',
          work_dir: '/tmp/project',
          updated_at: now,
        },
        {
          id: 'ses_other',
          title: 'not current',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_current',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const currentLine = lines.find((line) => line.includes('this is current'));
    const otherLine = lines.find((line) => line.includes('not current'));
    expect(currentLine).toContain('← current');
    expect(otherLine).not.toContain('← current');
  });

  it('places the relative time on the same line as the title, not right-aligned', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_inline_time',
          title: 'Short title',
          work_dir: '/tmp/project',
          updated_at: now - 5 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const headerLine = lines.find((line) => line.includes('Short title'));
    expect(headerLine).toBeDefined();
    // Title and time sit side-by-side with only the small inline separator.
    expect(headerLine).toMatch(/Short title\s{1,4}5m ago/);
    // No long run of trailing spaces, i.e. not right-aligned.
    expect(headerLine).not.toMatch(/Short title\s{8,}/);
  });

  it('prepends [imported] badge before the title for sessions migrated from kimi-cli', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_imported',
          title: 'Migrated session',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
          metadata: { imported_from_kimi_cli: true },
        },
        {
          id: 'ses_native',
          title: 'Fresh session',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const importedLine = lines.find((line) => line.includes('Migrated session'));
    const nativeLine = lines.find((line) => line.includes('Fresh session'));
    expect(importedLine).toContain('[imported] Migrated session');
    expect(nativeLine).not.toContain('[imported]');
  });

  it('keeps every rendered line within the terminal width even for CJK content', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_cjk_long_session_id_value',
          title: '现在要重构一下 TUI 的 sessions 列表，要渲染几个字段，让 UI 更好看',
          last_prompt:
            '我们要渲染几个：sessionid title lastPrompt。工作目录，修改时间。需要重新设计下 UI。',
          work_dir: '/Users/someone/Desktop/中文目录/very-long-project-folder-name',
          updated_at: now - 5 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_cjk_long_session_id_value',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [40, 80, 120, 238]) {
      const lines = component.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // Regression for #240: a long session id, the inline time + "(current)"
  // badge, and a long prompt all used to be appended past the terminal edge,
  // which crashed the renderer with "Rendered line exceeds terminal width" on
  // very narrow terminals.
  it('never renders a line wider than the terminal, even on tiny widths (#240)', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const id = 'ses_fbe574f3-572d-487f-9fa0-d09694f599d4';
    const component = new SessionPickerComponent({
      sessions: [
        {
          id,
          title: 'refactor the sessions list so the UI looks much nicer than before',
          last_prompt: 'please redesign the picker UI to be much nicer than before',
          work_dir: '/Users/getlong/Development/cesiumdb',
          updated_at: now - 5 * 60 * 1000,
          metadata: { imported_from_kimi_cli: true },
        },
      ],
      loading: false,
      currentSessionId: id,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (let width = 10; width <= 60; width++) {
      const lines = component.render(width);
      for (const [idx, line] of lines.entries()) {
        expect(visibleWidth(line), `width=${String(width)} line#${String(idx)}`).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it('calls onToggleScope with the selected session id when Ctrl+A is pressed', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_a',
          title: 'Session A',
          work_dir: '/tmp/project-a',
          updated_at: 1,
        },
        {
          id: 'ses_b',
          title: 'Session B',
          work_dir: '/tmp/project-b',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('\u001B[B');
    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_b');
  });

  it('calls onToggleScope with the current session id when Ctrl+A is pressed with no sessions', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: 'ses_current',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_current');
  });

  it('renders the Ctrl+A all-sessions hint when the current cwd has no sessions', () => {
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: 'ses_current',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('No sessions found.');
    expect(output).toContain('Ctrl+A all');
  });

  it('renders all-sessions scope header and Ctrl+A current-cwd hint', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_all',
          title: 'All scope session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'all',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('All sessions');
    expect(output).toContain('↑↓ navigate · Ctrl+A current cwd · Enter select · / ↑ search · Esc cancel');
  });

  it('selects the full session row on Enter', () => {
    const onSelect = vi.fn();
    const session = {
      id: 'ses_row',
      title: 'Row session',
      work_dir: '/tmp/project-row',
      updated_at: 1,
    };
    const component = new SessionPickerComponent({
      sessions: [session],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('\r');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(session);
  });

  it('loads the next 50 sessions after moving past the loaded page', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const component = new SessionPickerComponent({
      sessions: Array.from({ length: 120 }, (_, index) => ({
        id: `ses_${String(index).padStart(4, '0')}`,
        title: `Session ${String(index).padStart(4, '0')}`,
        work_dir: '/tmp/project',
        updated_at: now - index * 1000,
      })),
      loading: false,
      currentSessionId: '',
      scope: 'all',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (let i = 0; i < 50; i++) {
      component.handleInput('\u001B[B');
    }

    const output = renderPlain(component);

    expect(output).toContain('Session 0050');
    expect(output).toContain('Showing 49-52 of 100 loaded / 120 sessions');
  });

  it('keeps initial selected session id and loads enough pages for it', () => {
    const component = new SessionPickerComponent({
      sessions: Array.from({ length: 80 }, (_, index) => ({
        id: `ses_${String(index).padStart(4, '0')}`,
        title: `Session ${String(index).padStart(4, '0')}`,
        work_dir: '/tmp/project',
        updated_at: index,
      })),
      loading: false,
      currentSessionId: '',
      scope: 'all',
      initialSelectedSessionId: 'ses_0070',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('Session 0070');
    expect(output).toContain('Showing 69-72 of 80 sessions');
  });

  it('shows type-to-search copy only when the query is empty', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_search_copy',
          title: 'Search copy session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    // The always-visible search box carries the placeholder while unfocused;
    // the old "(type to search)" title suffix is gone.
    expect(output).toContain('Sessions');
    expect(output).not.toContain('type to search');
    expect(output).toContain('⌕ Search…');
    expect(output).toContain('/ ↑ search');

    // Typing while unfocused is inert — no seeding, no filtering.
    component.handleInput('x');
    const inertOutput = renderPlain(component);
    expect(inertOutput).not.toContain('⌕ x');
    expect(inertOutput).toContain('/ ↑ search');

    // Once focused via `/`, typing filters; the focused hint shows the Esc exit.
    component.handleInput('/');
    component.handleInput('x');
    const searchOutput = renderPlain(component);
    expect(searchOutput).toContain('⌕ x');
    expect(searchOutput).toContain('Esc back to list');
    expect(searchOutput).not.toContain('/ ↑ search');
  });

  it('fuzzy-filters by session name only when typing', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          last_prompt: 'needleprompt do not match',
          work_dir: '/tmp/needleprompt',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          last_prompt: 'other prompt',
          work_dir: '/tmp/other',
          updated_at: 2,
        },
        {
          id: 'ses_fuzzy',
          title: 'N1e2e3d4l5e session',
          last_prompt: 'prompt only',
          work_dir: '/tmp/project',
          updated_at: 3,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('/');
    component.handleInput('n');
    component.handleInput('e');
    component.handleInput('e');
    component.handleInput('d');
    component.handleInput('l');
    component.handleInput('e');

    const output = renderPlain(component);

    expect(output).toContain('⌕ needle');
    expect(output).toContain('N1e2e3d4l5e session');
    expect(output).not.toContain('Alpha session');
    expect(output).not.toContain('Beta session');
  });

  it('clears the query on Backspace and layers Esc clear → unfocus → cancel', () => {
    const onCancel = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel,
    });

    component.handleInput('/');
    component.handleInput('z');
    expect(renderPlain(component)).toContain('⌕ z');

    component.handleInput(BACKSPACE);
    expect(renderPlain(component)).not.toContain('⌕ z');
    expect(onCancel).not.toHaveBeenCalled();

    component.handleInput('z');
    expect(renderPlain(component)).toContain('⌕ z');

    // Esc 1 clears the query (box stays focused), Esc 2 unfocuses back to the
    // list, Esc 3 cancels.
    component.handleInput(ESC);
    expect(renderPlain(component)).not.toContain('⌕ z');
    expect(onCancel).not.toHaveBeenCalled();

    component.handleInput(ESC);
    expect(renderPlain(component)).toContain('/ ↑ search');
    expect(onCancel).not.toHaveBeenCalled();

    component.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('selects the filtered session row on Enter', () => {
    const onSelect = vi.fn();
    const target = {
      id: 'ses_gamma',
      title: 'Gamma session',
      work_dir: '/tmp/project-gamma',
      updated_at: 3,
    };
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project-alpha',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-beta',
          updated_at: 2,
        },
        target,
      ],
      loading: false,
      currentSessionId: '',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('/');
    component.handleInput('g');
    component.handleInput('a');
    component.handleInput('m');
    component.handleInput('\r');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('loads the next 50 matching sessions after moving past the filtered page', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const component = new SessionPickerComponent({
      sessions: [
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `ses_needle_${String(index).padStart(4, '0')}`,
          title: `Needle ${String(index).padStart(4, '0')}`,
          work_dir: '/tmp/project',
          updated_at: now - index * 1000,
        })),
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `ses_other_${String(index).padStart(4, '0')}`,
          title: `Other ${String(index).padStart(4, '0')}`,
          work_dir: '/tmp/project',
          updated_at: now - (80 + index) * 1000,
        })),
      ],
      loading: false,
      currentSessionId: '',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('/');
    component.handleInput('n');
    component.handleInput('e');
    component.handleInput('e');
    component.handleInput('d');
    component.handleInput('l');
    component.handleInput('e');
    // ↓ from the selected search box drops onto the first filtered row…
    component.handleInput('\u001B[B');
    // …then 50 more steps move past the first loaded page.
    for (let i = 0; i < 50; i++) {
      component.handleInput('\u001B[B');
    }

    const output = renderPlain(component);

    expect(output).toContain('Needle 0050');
    expect(output).toContain('Showing 49-52 of 80 loaded / 80 matches');
  });

  it('calls onToggleScope with the selected filtered session id when Ctrl+A is pressed', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project-a',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-b',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('/');
    component.handleInput('b');
    component.handleInput('e');
    component.handleInput('t');
    component.handleInput('a');
    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_beta');
  });

  it('moves the selection with the mouse wheel, clamped at both ends', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project-a',
          updated_at: now - 60 * 1000,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-b',
          updated_at: now - 2 * 60 * 1000,
        },
        {
          id: 'ses_gamma',
          title: 'Gamma session',
          work_dir: '/tmp/project-c',
          updated_at: now - 3 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const wheel = (button: number): void => {
      component.handleMouse({ type: 'wheel', button, col: 1, row: 1, slotRelative: false });
    };

    // Wheel down moves the pointer onto the next session.
    wheel(65);
    expect(renderPlain(component)).toContain('❯ Beta session');

    // The bottom end clamps instead of wrapping back to the top.
    wheel(65);
    wheel(65);
    expect(renderPlain(component)).toContain('❯ Gamma session');

    // The top end clamps too.
    wheel(64);
    wheel(64);
    wheel(64);
    const output = renderPlain(component);
    expect(output).toContain('❯ Alpha session');
    expect(output).not.toContain('❯ Beta session');
  });

  describe('click-to-select (left press)', () => {
    // Row layout at width 120: 0 divider, 1 title, 2 hint, 3 blank, 4-6 search
    // box, then session cards separated by one blank row each. Card heights:
    // title + id/dir (+ prompt when present).
    //   7-9  Alpha (has prompt → 3 rows)   10 blank
    //  11-12 Beta  (2 rows)               13 blank
    //  14-15 Gamma (2 rows)               16 divider
    function makePicker(onSelect = vi.fn()) {
      const component = new SessionPickerComponent({
        sessions: [
          {
            id: 'ses_alpha',
            title: 'Alpha session',
            last_prompt: 'fix the bug',
            work_dir: '/tmp/project-a',
            updated_at: 1,
          },
          {
            id: 'ses_beta',
            title: 'Beta session',
            work_dir: '/tmp/project-b',
            updated_at: 2,
          },
          {
            id: 'ses_gamma',
            title: 'Gamma session',
            work_dir: '/tmp/project-c',
            updated_at: 3,
          },
        ],
        loading: false,
        currentSessionId: '',
        onSelect,
        onCancel: vi.fn(),
      });
      component.render(120); // primes the render width used by the hit test
      const press = (row: number, button = 0): void => {
        component.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
      };
      return { component, onSelect, press };
    }

    it('selects the card whose row is hit, anywhere inside the card', () => {
      const { component, onSelect, press } = makePicker();

      press(11); // Beta title row
      expect(renderPlain(component)).toContain('❯ Beta session');

      press(14); // Gamma title row
      expect(renderPlain(component)).toContain('❯ Gamma session');

      press(8); // Alpha id/dir row — any row inside a card counts
      expect(renderPlain(component)).toContain('❯ Alpha session');

      press(12); // Beta id/dir row
      expect(renderPlain(component)).toContain('❯ Beta session');

      // Click only moves the selection; it never confirms.
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('ignores presses on the header, separators, and below the last card', () => {
      const { component, press } = makePicker();

      press(11); // move to Beta first
      expect(renderPlain(component)).toContain('❯ Beta session');

      // Rows 4-6 are the search box (covered by the focus test below); the
      // rest of the header, separators, and overflow are inert.
      for (const row of [-1, 0, 1, 2, 3, 10, 13, 16, 20]) {
        press(row);
        expect(renderPlain(component), `row ${String(row)}`).toContain('❯ Beta session');
      }

      // The separator must not fall through to the card below it either:
      // with Alpha selected, its trailing separator keeps Alpha selected.
      press(8); // Alpha id/dir row
      expect(renderPlain(component)).toContain('❯ Alpha session');
      press(10); // separator between Alpha and Beta
      expect(renderPlain(component)).toContain('❯ Alpha session');
    });

    it('ignores non-left buttons and non-press event types', () => {
      const { component, press } = makePicker();

      press(11, 2); // right button
      expect(renderPlain(component)).toContain('❯ Alpha session');

      component.handleMouse({ type: 'release', button: 0, col: 1, row: 11, slotRelative: false });
      expect(renderPlain(component)).toContain('❯ Alpha session');
    });

    it('focuses the search box when the box itself is clicked', () => {
      const { component, press } = makePicker();

      // Row 5 is the middle row of the search box (rows 4-6).
      press(5);
      const out = renderPlain(component);
      expect(out).toContain('Esc back to list'); // focused hint
      expect(out).toContain('❯ Alpha session'); // cursor untouched
    });

    it('maps card rows past the search box while a query is active', () => {
      const { component, press } = makePicker();

      // 'se' matches every "* session" title; the box is always rendered, so
      // typing does not shift the cards — what matters is that presses map
      // past the box rows and a press on the box only focuses it.
      component.handleInput('/');
      component.handleInput('s');
      component.handleInput('e');
      const lines = component.render(120).map(stripAnsi);
      const boxRow = lines.findIndex((line) => line.includes('⌕ se'));
      expect(boxRow).toBeGreaterThanOrEqual(0);
      const betaRow = lines.findIndex((line) => line.includes('Beta session'));
      const alphaRow = lines.findIndex((line) => line.includes('Alpha session'));
      expect(betaRow).toBeGreaterThanOrEqual(0);
      expect(alphaRow).toBeGreaterThanOrEqual(0);

      // The cursor starts on the first filtered card; click the other one.
      const targetRow = lines[betaRow]!.includes('❯') ? alphaRow : betaRow;
      const targetTitle = targetRow === betaRow ? 'Beta session' : 'Alpha session';
      press(targetRow);
      expect(renderPlain(component)).toContain(`❯ ${targetTitle}`);

      // A press on the search box focuses it without moving the cursor.
      press(boxRow);
      expect(renderPlain(component)).toContain(`❯ ${targetTitle}`);
    });

    it('uses the same visible-window math as render when the list is windowed', () => {
      const component = new SessionPickerComponent({
        sessions: Array.from({ length: 5 }, (_, index) => ({
          id: `ses_000${String(index)}`,
          title: `Session 000${String(index)}`,
          work_dir: '/tmp/project',
          updated_at: index,
        })),
        loading: false,
        currentSessionId: '',
        initialSelectedSessionId: 'ses_0002',
        maxVisibleSessions: 2,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      component.render(120);
      const press = (row: number): void => {
        component.handleMouse({ type: 'press', button: 0, col: 1, row, slotRelative: false });
      };

      // selectedIndex 2 → visibleStart 1: rows 7-8 card 1, 9 blank, 10-11 card 2.
      expect(renderPlain(component)).toContain('❯ Session 0002');
      press(7);
      expect(renderPlain(component)).toContain('❯ Session 0001');

      // selectedIndex 1 → visibleStart 0: the window scrolled up with it.
      press(7);
      expect(renderPlain(component)).toContain('❯ Session 0000');

      // Rows in the footer area below the window are ignored.
      press(12);
      expect(renderPlain(component)).toContain('❯ Session 0000');
    });
  });
});
