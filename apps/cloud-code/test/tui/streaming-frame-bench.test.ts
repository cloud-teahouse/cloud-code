/**
 * Wall-clock probe from the streaming-jank investigation (2026-08-04): measures
 * the per-frame transcript revalidation cost (TranscriptRowIndex.syncFull) with
 * REAL app components at realistic scale, steady state and while streaming the
 * tail. The assertions are sanity checks (geometry exact, cache referential
 * stability) — perf assertions would flake; read the printed ms/op numbers.
 *
 * Baselines after the identity-cache fix (ToolCallComponent 41µs → 1µs cached):
 *   syncFull steady:   200 → 0.10ms,  1000 → 0.39ms,  3000 → 1.12ms
 *   syncFull stream:   200 → 0.54ms,  1000 → 0.73ms,  3000 → 1.50ms
 * (pre-fix: 3000-child steady frames cost 23.5ms — the visible streaming jank)
 *
 *   vitest run test/tui/streaming-frame-bench.test.ts
 */

import { Container } from '@cloud-code/pi-tui';
import { TranscriptRowIndex } from '../../../../packages/pi-tui/src/transcript-index';
import { describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';

const WIDTH = 100;

const ASSISTANT_TEXT = [
  '这是一个 Electron/Chromium 打包的应用（Kiro 编辑器）：',
  '',
  '- 主程序：kiro（约 190 MB）',
  '- 目录：bin/、locales/、resources/',
  '- Chromium 运行时：chrome-sandbox、libEGL.so、libGLESv2.so',
  '',
  '资源文件包括 `*.pak`、`icudtl.dat`、`snapshot_blob.bin`。',
  '',
  '```bash',
  'ls -la /opt/kiro',
  '```',
].join('\n');

function makeChildren(count: number): { container: Container; last: AssistantMessageComponent } {
  const container = new Container();
  let last = new AssistantMessageComponent();
  for (let i = 0; i < count; i++) {
    const kind = i % 10;
    if (kind < 4) {
      const c = new AssistantMessageComponent();
      c.updateContent(ASSISTANT_TEXT, { transient: false });
      container.addChild(c);
      last = c;
    } else if (kind < 6) {
      container.addChild(
        new ThinkingComponent('先看一下目录结构。\n然后读 package.json 确认脚本。'.repeat(3), true),
      );
    } else if (kind < 8) {
      const tc = new ToolCallComponent(
        { id: `call_${i}`, name: 'Bash', args: { command: 'ls -la' } },
        undefined,
        undefined,
      );
      tc.setResult({ content: 'total 48\ndrwxr-xr-x 12 user user 4096 Jan 1 00:00 .', isError: false } as never);
      container.addChild(tc);
    } else {
      container.addChild(new UserMessageComponent('帮我看一下这个目录是干什么的'));
    }
  }
  return { container, last };
}

function time(label: string, fn: () => void, ops: number): number {
  for (let i = 0; i < 50; i++) fn();
  const start = performance.now();
  for (let i = 0; i < ops; i++) fn();
  const ms = (performance.now() - start) / ops;
  console.log(`${label.padEnd(58)} ${ms.toFixed(3).padStart(9)} ms/op`);
  return ms;
}

describe('streaming frame cost (real components)', () => {
  it('measures syncFull steady + streaming-tail costs at scale', { timeout: 120_000 }, () => {
    for (const n of [200, 1000, 3000]) {
      const { container, last } = makeChildren(n);
      const index = new TranscriptRowIndex();
      index.syncFull(container, WIDTH);

      const steady = time(`syncFull steady (${n} children)`, () => {
        index.syncFull(container, WIDTH);
      }, 200);

      let frame = 0;
      const streaming = time(`syncFull streaming tail (${n} children)`, () => {
        frame++;
        last.updateContent(ASSISTANT_TEXT + `\n\n追加一句流式输出 ${frame}`, { transient: true });
        index.syncFull(container, WIDTH);
      }, 200);
      console.log(`  → streaming/steady = ${(streaming / steady).toFixed(1)}×\n`);

      // Sanity, not a perf assertion (those flake): the index stays exact and
      // cached components keep referential stability through the walk.
      expect(index.totalLines).toBeGreaterThan(0);
      expect(last.render(WIDTH)).toBe(last.render(WIDTH));
    }
  });

  it('breaks down per-component render costs (cache-hit path)', { timeout: 120_000 }, () => {
    const assistant = new AssistantMessageComponent();
    assistant.updateContent(ASSISTANT_TEXT, { transient: false });
    const thinking = new ThinkingComponent('先看一下目录结构。\n然后读 package.json 确认脚本。'.repeat(3), true);
    const tool = new ToolCallComponent(
      { id: 'call_x', name: 'Bash', args: { command: 'ls -la' } },
      undefined,
      undefined,
    );
    tool.setResult({ content: 'total 48\ndrwxr-xr-x 12 user user 4096 Jan 1 00:00 .', isError: false } as never);
    const user = new UserMessageComponent('帮我看一下这个目录是干什么的');

    // Warm each cache, then measure the steady-state render call.
    for (const c of [assistant, thinking, tool, user]) c.render(WIDTH);
    time('AssistantMessageComponent.render (cached)', () => assistant.render(WIDTH), 5000);
    time('ThinkingComponent.render (cached)', () => thinking.render(WIDTH), 5000);
    time('ToolCallComponent.render (cached)', () => tool.render(WIDTH), 5000);
    time('UserMessageComponent.render (cached)', () => user.render(WIDTH), 5000);

    // Bisect the ToolCallComponent render: children walk vs. the rest.
    const probe = tool as unknown as {
      children: { render: (w: number) => string[] }[];
      flushDirty: () => void;
    };
    console.log(`  tool-call children: ${probe.children.length}`);
    time('  flushDirty only (clean)', () => {
      probe.flushDirty();
    }, 5000);
    time('  children walk only', () => {
      for (const c of probe.children) c.render(WIDTH);
    }, 5000);
    time('  full render again', () => tool.render(WIDTH), 5000);
    probe.children.forEach((c, i) => {
      const name = c.constructor.name;
      time(`    child[${i}] ${name}`, () => c.render(WIDTH), 5000);
    });
    expect(tool.render(WIDTH).length).toBeGreaterThan(0);
  });
});
