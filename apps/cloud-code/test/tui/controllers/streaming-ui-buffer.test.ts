import { describe, expect, it, vi } from 'vitest';

import { StreamingUIController, type StreamingUIHost } from '#/tui/controllers/streaming-ui';

function makeController(): StreamingUIController {
  return new StreamingUIController({} as StreamingUIHost);
}

describe('StreamingUIController stream buffers', () => {
  it('joins assistant chunks at flush boundaries with cumulative text', () => {
    const controller = makeController();
    vi.spyOn(controller, 'onStreamingTextStart').mockImplementation(() => {});
    const updates = vi
      .spyOn(controller, 'onStreamingTextUpdate')
      .mockImplementation(() => {});

    controller.appendAssistantDelta('first');
    controller.appendAssistantDelta(' ');
    controller.appendAssistantDelta('second');
    controller.flushNow();

    controller.appendAssistantDelta('!');
    controller.flushNow();

    expect(updates.mock.calls.map(([text]) => text)).toEqual(['first second', 'first second!']);
  });

  it('joins thinking chunks without changing the visible flush payload', () => {
    const controller = makeController();
    const updates = vi.spyOn(controller, 'onThinkingUpdate').mockImplementation(() => {});

    controller.appendThinkingDelta('reason');
    controller.appendThinkingDelta('ing');
    controller.flushNow();

    expect(updates).toHaveBeenCalledWith('reasoning');
    expect(controller.hasThinkingDraft()).toBe(true);
  });

  it('only exposes a tool preview after a JSON object prefix arrives', () => {
    const controller = makeController();

    controller.accumulateToolCallDelta('swarm-1', 'AgentSwarm', ' ');
    expect(controller.hasStreamingToolCallPreview('swarm-1')).toBe(false);

    controller.accumulateToolCallDelta('swarm-1', undefined, '{"description":"pending"');
    expect(controller.hasStreamingToolCallPreview('swarm-1')).toBe(true);
  });
});
