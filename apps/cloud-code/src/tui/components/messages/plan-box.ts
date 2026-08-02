/**
 * PlanBoxComponent — renders an ExitPlanMode plan inside a full-width
 * rounded box (the sanctioned `renderBox` chrome — transcript-inline, not a
 * takeover pane), width-aware. The plan text is parsed as Markdown so
 * headings, lists, bold, inline code etc. render the same way assistant
 * messages do.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Markdown, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import { renderBox } from '#/tui/components/primitives';
import { resolveDescription, t } from '#/tui/i18n';
import type { ColorToken } from '#/tui/theme';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2; // two-space indent matching other tool call children
const SIDE_PADDING = 1; // space between the │ and the content on each side
// i18n key, resolved at render time via resolveDescription().
const TITLE_PREFIX = 'notices.plan.titlePrefix';
const TITLE_SUFFIX = ' ';

export interface PlanBoxOptions {
  status?: {
    readonly label: string;
    readonly colorHex: string;
  };
}

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private readonly status: PlanBoxOptions['status'];
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderToken: ColorToken,
    private readonly planPath?: string,
    opts?: PlanBoxOptions,
  ) {
    // Build the Markdown instance once — pi-tui's Markdown caches its own
    // parse + wrap output keyed on (text, width), so reusing the same
    // instance means repeated render() calls from the parent Container
    // hit the cache instead of re-parsing on every frame.
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    if (safeWidth < LEFT_MARGIN + 4) {
      return this.markdown.render(Math.max(1, safeWidth)).map((line) => truncateToWidth(line, safeWidth, '…'));
    }

    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // Content columns inside margin + borders + padding — the same interior
    // width renderBox derives below.
    const contentWidth = Math.max(1, safeWidth - LEFT_MARGIN - 2 - 2 * SIDE_PADDING);
    const title = this.buildTitle(contentWidth + 2 * SIDE_PADDING);
    const rawLines = this.markdown.render(contentWidth);

    const fitted = renderBox(rawLines, {
      width: safeWidth,
      margin: LEFT_MARGIN,
      padding: SIDE_PADDING,
      fill: true,
      title,
      token: this.borderToken,
    });
    this.cachedWidth = width;
    this.cachedLines = fitted;
    return fitted;
  }

  private buildTitle(horzLen: number): string {
    const statusSuffix = this.buildStatusSuffix();
    const fallback = t('notices.plan.title');
    const fallbackWithStatus = t('notices.plan.titleWithStatus', { suffix: statusSuffix });
    const budget = Math.max(0, horzLen - 1);
    const fallbackTitle = truncateToWidth(
      visibleWidth(fallbackWithStatus) <= budget ? fallbackWithStatus : fallback,
      budget,
      '…',
    );
    const planPath = this.planPath;
    if (planPath === undefined || planPath.length === 0) return fallbackTitle;
    const basename = path.basename(planPath);
    if (basename.length === 0) return fallbackTitle;
    const linked = path.isAbsolute(planPath)
      ? toTerminalHyperlink(basename, pathToFileURL(planPath).href)
      : basename;
    const title = resolveDescription(TITLE_PREFIX) + linked + statusSuffix + TITLE_SUFFIX;
    if (visibleWidth(title) > budget) return fallbackTitle;
    return title;
  }

  private buildStatusSuffix(): string {
    const status = this.status;
    if (status === undefined || status.label.length === 0) return '';
    return ` · ${chalk.hex(status.colorHex)(status.label)}`;
  }
}
