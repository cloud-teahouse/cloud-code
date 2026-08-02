import type { Component } from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

/**
 * A collapsed summary of older content within a turn. Accumulates counts of
 * merged steps (thinking blocks and tool calls) and folded assistant messages,
 * rendering them as a single muted line, e.g.
 * `… thinking 5 times, call 50 tools, 12 messages`.
 */
export class StepSummaryComponent implements Component {
  private thinking = 0;
  private tool = 0;
  private message = 0;

  get isEmpty(): boolean {
    return this.thinking === 0 && this.tool === 0 && this.message === 0;
  }

  addCounts(thinking: number, tool: number, message = 0): void {
    this.thinking += thinking;
    this.tool += tool;
    this.message += message;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const parts: string[] = [];
    if (this.thinking > 0) parts.push(t('swarm.stepSummary.thinking', { count: this.thinking }));
    if (this.tool > 0) parts.push(t('swarm.stepSummary.tools', { count: this.tool }));
    if (this.message > 0) parts.push(t('swarm.stepSummary.messages', { count: this.message }));
    if (parts.length === 0) return [];
    return [currentTheme.dim(`\u2026 ${parts.join(', ')}`)];
  }
}
