/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 */

import type { Component } from '@cloud-code/pi-tui';
import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import { effectiveModelAlias } from '@cloud-code/sdk';

import { getChannel, type CloudCodeChannel } from '#/cli/build-info';
import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import { padEndVisible, t } from '#/tui/i18n';
import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';

/** Info-label column width (en labels padded to 11 columns historically). */
const INFO_LABEL_WIDTH = 11;

export class WelcomeComponent implements Component {
  private state: AppState;
  private readonly channel: CloudCodeChannel;

  constructor(state: AppState, channel: CloudCodeChannel = getChannel()) {
    this.state = state;
    this.channel = channel;
  }

  invalidate(): void {}

  /** Dim instability note shown under the box on dev/beta builds. */
  private channelNote(): string | null {
    if (this.channel === 'dev') return t('welcome.channelNote.dev');
    if (this.channel === 'beta') return t('welcome.channelNote.beta');
    return null;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    // Box chrome follows the two-level system (border token); the logo and
    // title inside stay brand-primary.
    const border = (s: string): string => chalk.hex(currentTheme.palette.border)(s);
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];
    const effectiveActiveModel = activeModel === undefined ? undefined : effectiveModelAlias(activeModel);

    if (safeWidth < 24) {
      const title = chalk.bold.hex(currentTheme.palette.primary)(t('welcome.title'));
      const prompt = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)(t('welcome.getStarted.login'))
        : chalk.hex(currentTheme.palette.textDim)(t('welcome.getStarted.help'));
      const model = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)(t('welcome.modelNotSet'))
        : (effectiveActiveModel?.displayName ?? effectiveActiveModel?.model ?? this.state.model);
      const lines = ['', title, prompt, `${t('welcome.label.model')} ${model}`];
      const note = this.channelNote();
      if (note !== null) lines.push(chalk.hex(currentTheme.palette.textDim)(note));
      return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
    }

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    // Logo + side-by-side text. The crab mascot (shape borrowed from Claude
    // Code's Clawd) is rendered in the primary theme color.
    const logo = [' ▐█▛█▛█▌', ' ▐█████▌'] as const;
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(currentTheme.palette.primary)(t('welcome.title')),
      textWidth,
      '…',
    );
    const dim = chalk.hex(currentTheme.palette.textDim);
    const labelStyle = chalk.bold.hex(currentTheme.palette.textDim);
    const rightRow1 = truncateToWidth(
      dim(isLoggedOut ? t('welcome.getStarted.login') : t('welcome.getStarted.help')),
      textWidth,
      '…',
    );

    let renderedHeaderLines = [
      primary(logo[0].padEnd(logoWidth)) + gap + rightRow0,
      primary(logo[1].padEnd(logoWidth)) + gap + rightRow1,
      primary(logo[2].padEnd(logoWidth)),
    ];
    if (isRainbowDancing()) {
      renderedHeaderLines = renderDanceWelcomeHeader(logo, textWidth, rightRow1);
    }

    const modelValue = isLoggedOut
      ? chalk.hex(currentTheme.palette.warning)(t('welcome.modelNotSet'))
      : (effectiveActiveModel?.displayName ?? effectiveActiveModel?.model ?? this.state.model);

    // Labels pad by *display* width so CJK translations keep the value column
    // aligned (see i18n padEndVisible).
    const infoLines = [
      labelStyle(padEndVisible(t('welcome.label.directory'), INFO_LABEL_WIDTH)) + this.state.workDir,
      labelStyle(padEndVisible(t('welcome.label.session'), INFO_LABEL_WIDTH)) + this.state.sessionId,
      labelStyle(padEndVisible(t('welcome.label.model'), INFO_LABEL_WIDTH)) + modelValue,
      labelStyle(padEndVisible(t('welcome.label.version'), INFO_LABEL_WIDTH)) + this.state.version,
    ];

    if (this.state.mcpServersSummary) {
      infoLines.push(
        labelStyle(padEndVisible(t('welcome.label.mcp'), INFO_LABEL_WIDTH)) +
          this.state.mcpServersSummary,
      );
    }

    const contentLines: string[] = [...renderedHeaderLines, '', ...infoLines];

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + truncated + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    const note = this.channelNote();
    if (note !== null) {
      lines.push(chalk.hex(currentTheme.palette.textDim)(`  ${note}`));
    }
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
