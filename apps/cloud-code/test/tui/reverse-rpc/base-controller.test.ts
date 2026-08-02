import { describe, expect, it, vi } from 'vitest';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';

class TestController extends ReverseRpcController<string, string> {
  protected createCancelResponse(reason: string): string {
    return `cancel:${reason}`;
  }
}

describe('ReverseRpcController', () => {
  it('shows a payload, resolves the pending promise on respond, and hides the panel', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const pending = controller.show('payload');
    expect(controller.hasPending()).toBe(true);
    expect(showPanel).toHaveBeenCalledWith('payload');

    controller.respond('approved');

    await expect(pending).resolves.toBe('approved');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('queues concurrent show() requests and presents them one at a time', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    // Only the first is presented; the rest stay queued.
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(showPanel).toHaveBeenLastCalledWith('first');
    expect(controller.hasPending()).toBe(true);

    controller.respond('answer-first');
    await expect(first).resolves.toBe('answer-first');
    // Advancing to the next queued request reuses the same panel without
    // hiding it in between.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(2);
    expect(showPanel).toHaveBeenLastCalledWith('second');

    controller.respond('answer-second');
    await expect(second).resolves.toBe('answer-second');
    expect(showPanel).toHaveBeenCalledTimes(3);
    expect(showPanel).toHaveBeenLastCalledWith('third');

    controller.respond('answer-third');
    await expect(third).resolves.toBe('answer-third');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves matching queued requests via the autoResolveFor hook', async () => {
    class AutoController extends ReverseRpcController<
      { action: string; id: string },
      string
    > {
      protected createCancelResponse(reason: string): string {
        return `cancel:${reason}`;
      }
      protected override autoResolveFor(
        resolved: { action: string; id: string },
        response: string,
        queued: { action: string; id: string },
      ): string | undefined {
        if (response === 'approve_all_same' && resolved.action === queued.action) {
          return `auto:${queued.id}`;
        }
        return undefined;
      }
    }
    const controller = new AutoController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show({ action: 'run', id: 'a' });
    const second = controller.show({ action: 'run', id: 'b' });
    const third = controller.show({ action: 'edit', id: 'c' });
    const fourth = controller.show({ action: 'run', id: 'd' });

    controller.respond('approve_all_same');

    await expect(first).resolves.toBe('approve_all_same');
    await expect(second).resolves.toBe('auto:b');
    await expect(fourth).resolves.toBe('auto:d');
    // The non-matching request advances to the panel and stays pending.
    expect(showPanel).toHaveBeenLastCalledWith({ action: 'edit', id: 'c' });
    expect(controller.hasPending()).toBe(true);

    controller.respond('approve_all_same');
    await expect(third).resolves.toBe('approve_all_same');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('cancelAll cancels the current request and every queued request', async () => {
    const controller = new TestController();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    controller.cancelAll('shutdown');

    await expect(first).resolves.toBe('cancel:shutdown');
    await expect(second).resolves.toBe('cancel:shutdown');
    await expect(third).resolves.toBe('cancel:shutdown');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('tryAutoResolveCurrent resolves the visible request when the user is idle', async () => {
    const controller = new TestController();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel: vi.fn() });

    const pending = controller.show('payload');
    expect(controller.tryAutoResolveCurrent('auto')).toBe(true);

    await expect(pending).resolves.toBe('auto');
    expect(controller.hasPending()).toBe(false);
  });

  it('tryAutoResolveCurrent backs off while the user is interacting with the panel', async () => {
    const controller = new TestController();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel: vi.fn() });

    let settled = false;
    const pending = controller.show('payload');
    void pending.then(() => {
      settled = true;
    });

    // Arrow-key navigation / feedback typing on the panel reports here.
    controller.noteUserInteraction();
    expect(controller.hasRecentUserInteraction()).toBe(true);
    expect(controller.tryAutoResolveCurrent('auto')).toBe(false);
    // The dialog stays open and the request stays pending.
    expect(settled).toBe(false);
    expect(controller.hasPending()).toBe(true);

    // Once the guard window lapses, the programmatic resolution goes through.
    expect(controller.tryAutoResolveCurrent('auto', 0)).toBe(true);
    await expect(pending).resolves.toBe('auto');
  });

  it('a freshly shown panel has no interaction history, and respond clears it', async () => {
    const controller = new TestController();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel: vi.fn() });

    const first = controller.show('first');
    controller.noteUserInteraction();
    expect(controller.hasRecentUserInteraction()).toBe(true);

    controller.respond('answer');
    await expect(first).resolves.toBe('answer');
    expect(controller.hasRecentUserInteraction()).toBe(false);

    // Interaction without a visible panel is ignored entirely.
    controller.noteUserInteraction();
    expect(controller.hasRecentUserInteraction()).toBe(false);

    const second = controller.show('second');
    expect(controller.hasRecentUserInteraction()).toBe(false);
    controller.respond('answer-2');
    await expect(second).resolves.toBe('answer-2');
  });
});
