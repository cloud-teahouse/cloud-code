import { describe, expect, it, vi } from 'vitest';

import { handleCoordinatorCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface TestComponent {
  render(width: number): string[];
}

function makeHost(
  overrides: {
    hasSession?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
    coordinatorMode?: boolean;
  } = {},
) {
  const session = {
    setPermission: vi.fn(async () => {}),
    setCoordinatorMode: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: 'cloud-model',
        permissionMode: overrides.permissionMode ?? 'auto',
        coordinatorMode: overrides.coordinatorMode ?? false,
      },
      theme: currentTheme,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function markerAddChild(host: SlashCommandHost): ReturnType<typeof vi.fn> {
  return host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
}

function expectCoordinatorMarker(host: SlashCommandHost, text: string): void {
  const components = markerAddChild(host).mock.calls.map(([component]) => component as TestComponent);
  const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(rendered).toContain(text);
}

describe('handleCoordinatorCommand', () => {
  it('turns Coordinator Mode on without a permission prompt in auto mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleCoordinatorCommand(host, 'on');

    expect(session.setCoordinatorMode).toHaveBeenCalledWith(true);
    expect(host.setAppState).toHaveBeenCalledWith({ coordinatorMode: true });
    expectCoordinatorMarker(host, 'Coordinator Mode activated');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('toggles Coordinator Mode on when called without args while off', async () => {
    const { host, session } = makeHost({ coordinatorMode: false });

    await handleCoordinatorCommand(host, '');

    expect(session.setCoordinatorMode).toHaveBeenCalledWith(true);
    expectCoordinatorMarker(host, 'Coordinator Mode activated');
  });

  it('turns Coordinator Mode off and renders the deactivated marker', async () => {
    const { host, session } = makeHost({ coordinatorMode: true });

    await handleCoordinatorCommand(host, 'off');

    expect(session.setCoordinatorMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ coordinatorMode: false });
    expectCoordinatorMarker(host, 'Coordinator Mode deactivated');
  });

  it('reports already-on / already-off without calling the session', async () => {
    const on = makeHost({ coordinatorMode: true });
    await handleCoordinatorCommand(on.host, 'on');
    expect(on.session.setCoordinatorMode).not.toHaveBeenCalled();
    expect(on.host.showStatus).toHaveBeenCalledWith('Coordinator Mode is already on.');

    const off = makeHost({ coordinatorMode: false });
    await handleCoordinatorCommand(off.host, 'off');
    expect(off.session.setCoordinatorMode).not.toHaveBeenCalled();
    expect(off.host.showStatus).toHaveBeenCalledWith('Coordinator Mode is already off.');
  });

  it('shows usage for an unknown subcommand', async () => {
    const { host, session } = makeHost();

    await handleCoordinatorCommand(host, 'later');

    expect(session.setCoordinatorMode).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Usage: /coordinator [on|off]');
  });

  it('asks before entering Coordinator Mode in Manual mode; selecting auto proceeds', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleCoordinatorCommand(host, 'on');

    expect(session.setCoordinatorMode).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block worker progress');

    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.setCoordinatorMode).toHaveBeenCalledWith(true);
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ coordinatorMode: true });
    expectCoordinatorMarker(host, 'Coordinator Mode activated');
  });

  it('cancelling the Manual-mode prompt leaves Coordinator Mode off', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleCoordinatorCommand(host, 'on');
    mountedPicker(host).handleInput(ESCAPE);

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Coordinator Mode not enabled.');
    });
    expect(session.setCoordinatorMode).not.toHaveBeenCalled();
    expect(session.setPermission).not.toHaveBeenCalled();
  });

  it('errors without an active session', async () => {
    const { host } = makeHost({ hasSession: false });

    await handleCoordinatorCommand(host, 'on');

    expect(host.showError).toHaveBeenCalled();
  });
});
