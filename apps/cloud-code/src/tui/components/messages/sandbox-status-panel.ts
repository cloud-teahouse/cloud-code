/**
 * `/sandbox` status report lines — the bordered transcript block showing the
 * OS command sandbox posture: mode, backend probe (with version or failure
 * reason), execution environment, effective policy (writable roots,
 * deny-read masks, guard binds, network), escalation, and config origin.
 *
 * Mirrors `mcp-status-panel.ts`: lines are rebuilt per render (locale and
 * theme switches repaint), each returned string is exactly one boxed row,
 * and diagnostic text (probe / plan reasons) passes through verbatim like
 * MCP server errors — folded onto a single row so the border stays intact.
 */

import type { SandboxStatusData } from '@cloud-code/sdk';
import { visibleWidth } from '@cloud-code/pi-tui';

import { padEndVisible, resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

export interface SandboxStatusReportOptions {
  readonly status: SandboxStatusData;
}

/** Escalation mode → i18n key; resolved at render time so locale switches repaint. */
const ESCALATION_LABEL: Record<SandboxStatusData['escalation'], string> = {
  ask: 'panels.sandbox.escalation.ask',
  never: 'panels.sandbox.escalation.never',
  always: 'panels.sandbox.escalation.always',
};

/** Collapse a (possibly multi-line) diagnostic reason into a single row. */
function foldReason(reason: string): string {
  return reason.trim().replaceAll(/\s+/g, ' ');
}

export function buildSandboxStatusReportLines(options: SandboxStatusReportOptions): string[] {
  const { status } = options;
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const ok = (text: string) => currentTheme.fg('success', text);
  const warn = (text: string) => currentTheme.fg('warning', text);
  const bad = (text: string) => currentTheme.fg('error', text);

  const policyVisible = status.mode !== 'off';
  // Widest label wins so values align; recomputed per render, so a locale
  // switch re-aligns the column.
  const labels = [
    t('panels.sandbox.label.status'),
    t('panels.sandbox.label.backend'),
    t('panels.sandbox.label.environment'),
    ...(policyVisible
      ? [
          t('panels.sandbox.label.writable'),
          t('panels.sandbox.label.denyRead'),
          t('panels.sandbox.label.readOnly'),
          t('panels.sandbox.label.scrub'),
          t('panels.sandbox.label.network'),
        ]
      : []),
    t('panels.sandbox.label.escalation'),
  ];
  const labelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
  const row = (label: string, rendered: string): string =>
    `  ${muted(padEndVisible(label, labelWidth))}  ${rendered}`;
  const continuation = `  ${' '.repeat(labelWidth)}  `;
  const pathRows = (label: string, paths: readonly string[]): string[] => {
    if (paths.length === 0) return [row(label, muted(t('panels.sandbox.none')))];
    return paths.map((path, index) =>
      index === 0 ? row(label, value(path)) : `${continuation}${value(path)}`,
    );
  };

  const lines: string[] = [];

  // ── State ──
  if (status.mode === 'off') {
    lines.push(row(t('panels.sandbox.label.status'), muted(t('panels.sandbox.state.off'))));
  } else if (status.unavailableReason !== undefined) {
    // enforce on a non-local environment: fail-closed, verbatim from the agent.
    lines.push(row(t('panels.sandbox.label.status'), bad(foldReason(status.unavailableReason))));
  } else if (status.plan.kind === 'sandboxed') {
    lines.push(
      row(
        t('panels.sandbox.label.status'),
        ok(t('panels.sandbox.state.sandboxed', { backend: status.plan.backend })),
      ),
    );
  } else {
    const painter = status.mode === 'enforce' ? bad : warn;
    lines.push(
      row(
        t('panels.sandbox.label.status'),
        painter(t('panels.sandbox.state.unsandboxed', { reason: foldReason(status.plan.reason) })),
      ),
    );
  }

  // ── Backend probes ──
  const unavailablePainter = status.mode === 'enforce' ? bad : status.mode === 'auto' ? warn : muted;
  status.backends.forEach((backend, index) => {
    const prefix =
      index === 0
        ? `  ${muted(padEndVisible(t('panels.sandbox.label.backend'), labelWidth))}  `
        : continuation;
    if (backend.available) {
      lines.push(
        `${prefix}${value(backend.name)}  ${ok(t('panels.sandbox.backend.available'))}` +
          (backend.version !== undefined ? ` ${muted(backend.version)}` : ''),
      );
    } else {
      lines.push(
        `${prefix}${value(backend.name)}  ${unavailablePainter(t('panels.sandbox.backend.unavailable'))}`,
      );
      if (backend.reason !== undefined) {
        lines.push(`${continuation}${muted(foldReason(backend.reason))}`);
      }
    }
  });
  if (status.mode !== 'off' && status.backends.some((backend) => !backend.available)) {
    lines.push(`${continuation}${muted(t('panels.sandbox.remediation'))}`);
  }

  // ── Environment ──
  lines.push(
    row(
      t('panels.sandbox.label.environment'),
      value(status.environment) +
        (status.local ? '' : ` ${muted(t('panels.sandbox.environment.nonLocal'))}`),
    ),
  );

  // ── Policy (not applicable while the sandbox is off) ──
  if (policyVisible) {
    lines.push(...pathRows(t('panels.sandbox.label.writable'), status.policy.writableRoots));
    lines.push(...pathRows(t('panels.sandbox.label.denyRead'), status.policy.denyReadPaths ?? []));

    if (status.guard.readOnlySubpaths.length === 0) {
      lines.push(row(t('panels.sandbox.label.readOnly'), muted(t('panels.sandbox.none'))));
    } else {
      lines.push(
        row(
          t('panels.sandbox.label.readOnly'),
          value(
            t('panels.sandbox.readOnly.count', { count: status.guard.readOnlySubpaths.length }),
          ),
        ),
      );
      for (const path of status.guard.readOnlySubpaths) {
        lines.push(`${continuation}${muted(path)}`);
      }
    }

    lines.push(
      row(
        t('panels.sandbox.label.scrub'),
        status.guard.scrubPaths.length === 0
          ? muted(t('panels.sandbox.none'))
          : value(t('panels.sandbox.scrub.count', { count: status.guard.scrubPaths.length })),
      ),
    );

    lines.push(
      row(
        t('panels.sandbox.label.network'),
        value(t(status.network === 'deny' ? 'panels.sandbox.network.deny' : 'panels.sandbox.network.allow')),
      ),
    );
  }

  lines.push(row(t('panels.sandbox.label.escalation'), value(resolveDescription(ESCALATION_LABEL[status.escalation]))));

  // ── Config origin ──
  lines.push('');
  lines.push(
    `  ${muted(t(status.configured ? 'panels.sandbox.config.source' : 'panels.sandbox.config.defaults'))}`,
  );
  // A live session override explains itself: the file-side origin above is a
  // startup snapshot and cannot see the toggle, so the override gets its own
  // line instead of pretending the report is stale.
  if (status.modeOverride !== undefined) {
    lines.push(
      `  ${muted(t('panels.sandbox.config.override', { mode: status.modeOverride }))}`,
    );
  }

  return lines;
}
