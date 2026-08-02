import type { Component } from '@cloud-code/pi-tui';
import { Spacer, Text, visibleWidth } from '@cloud-code/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';

export class CronMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly data: CronTranscriptData;
  private readonly promptText: Text;
  private readonly prompt: string;

  constructor(
    prompt: string,
    data: CronTranscriptData,
  ) {
    this.data = data;
    this.prompt = prompt;
    this.promptText = new Text(currentTheme.fg('text', prompt), 0, 0);
  }

  invalidate(): void {
    this.promptText.setText(currentTheme.fg('text', this.prompt));
    this.promptText.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const missed = this.data.missedCount !== undefined;
    const title = missed ? t('notices.cron.title.missed') : t('notices.cron.title.fired');
    const detail = cronDetail(this.data);
    const titleToken: keyof ColorPalette = this.data.stale === true || missed ? 'warning' : 'accent';
    const bullet = currentTheme.boldFg(titleToken, STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const continuationIndent = ' '.repeat(bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(safeWidth)) {
      lines.push(line);
    }

    const titleLines = new Text(currentTheme.boldFg(titleToken, title), 0, 0).render(contentWidth);
    for (let i = 0; i < titleLines.length; i += 1) {
      lines.push(`${i === 0 ? bullet : continuationIndent}${titleLines[i]}`);
    }

    if (detail !== undefined) {
      const detailLines = new Text(currentTheme.fg('textDim', detail), 0, 0).render(contentWidth);
      for (const line of detailLines) {
        lines.push(`${continuationIndent}${line}`);
      }
    }

    const promptLines = this.promptText.render(contentWidth);
    for (const line of promptLines) {
      lines.push(`${continuationIndent}${line}`);
    }

    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) {
    parts.push(t('notices.cron.job', { id: data.jobId }));
  }
  if (data.recurring === false) parts.push(t('notices.cron.oneShot'));
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(t('notices.cron.coalesced', { count: data.coalescedCount }));
  }
  if (data.missedCount !== undefined) {
    parts.push(t('notices.cron.missed', { count: data.missedCount }));
  }
  if (data.stale === true) parts.push(t('notices.cron.finalDelivery'));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
