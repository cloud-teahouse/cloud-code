/** See common.ts for contribution rules. */

export const notices = {
  // ── read group header & body ──
  'notices.readGroup.reading': 'Reading {count} files…',
  'notices.readGroup.read': 'Read {count} files',
  'notices.readGroup.lines.one': ' · {count} line',
  'notices.readGroup.lines.other': ' · {count} lines',
  'notices.readGroup.failedSuffix': ' · failed',
  'notices.readGroup.failedCount': ' · {count} failed',
  'notices.readGroup.readingTail': ' · reading…',

  // ── same-tool group header & body ──
  'notices.toolGroup.title': '{tool} ×{count}',
  'notices.toolGroup.runningSuffix': ' · {count} running…',
  'notices.toolGroup.failedSuffix': ' · failed',
  'notices.toolGroup.failedCount': ' · {count} failed',
  'notices.toolGroup.runningTail': ' · running…',

  // ── `!` shell run card ──
  'notices.shellRun.running': 'Running…',
  'notices.shellRun.overflow': '+{count} lines ',
  'notices.shellRun.backgroundHint': '(ctrl+b to run in background)',
  'notices.shellRun.outputUnavailable': '(output unavailable)',

  // ── cron reminder card ──
  'notices.cron.title.missed': 'Missed scheduled reminders',
  'notices.cron.title.fired': 'Scheduled reminder fired',
  'notices.cron.job': 'job {id}',
  'notices.cron.oneShot': 'one-shot',
  'notices.cron.coalesced': '{count} fires coalesced',
  'notices.cron.missed': '{count} missed',
  'notices.cron.finalDelivery': 'final delivery',

  // ── plan box title ──
  'notices.plan.titlePrefix': ' plan: ',
  'notices.plan.title': ' plan ',
  'notices.plan.titleWithStatus': ' plan{suffix} ',

  // ── thinking ──
  'notices.thinking.live': 'thinking...',
  'notices.thinking.moreLines': '... ({count} more lines, ctrl+o to expand)',

  // ── skill / plugin command cards ──
  'notices.skill.activated': '▶ Activated skill: ',
  'notices.plugin.invoked': '▶ Invoked command: ',
} as const;
