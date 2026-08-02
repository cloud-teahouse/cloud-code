import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TasksBrowserController,
  type TasksBrowserHost,
} from '#/tui/controllers/tasks-browser';
import { setLocalePreference } from '#/tui/i18n';

afterEach(() => {
  setLocalePreference('en');
});

interface HandleStopController {
  handleStop: (taskId: string) => Promise<void>;
  refresh: () => Promise<void>;
  repaint: () => void;
}

function makeController(stopBackgroundTask: ReturnType<typeof vi.fn>) {
  const browserState = { flashMessage: undefined, flashTimer: undefined };
  const host = {
    state: { tasksBrowser: browserState },
    session: {
      stopBackgroundTask,
      listBackgroundTasks: vi.fn().mockResolvedValue([]),
    },
  } as unknown as TasksBrowserHost;
  const controller = new TasksBrowserController(
    host,
  ) as unknown as HandleStopController;
  // Isolate the stop path from the painting/refresh plumbing.
  controller.refresh = vi.fn().mockResolvedValue(undefined);
  controller.repaint = vi.fn();
  return controller;
}

describe('TasksBrowserController stop reason', () => {
  it('sends the English stop reason by default', async () => {
    const stopBackgroundTask = vi.fn().mockResolvedValue(undefined);
    await makeController(stopBackgroundTask).handleStop('task_1');
    expect(stopBackgroundTask).toHaveBeenCalledWith('task_1', {
      reason: 'User initiated stop',
    });
  });

  it('sends the localized stop reason in zh-CN', async () => {
    setLocalePreference('zh-CN');
    const stopBackgroundTask = vi.fn().mockResolvedValue(undefined);
    await makeController(stopBackgroundTask).handleStop('task_1');
    expect(stopBackgroundTask).toHaveBeenCalledWith('task_1', { reason: '用户手动停止' });
  });
});
