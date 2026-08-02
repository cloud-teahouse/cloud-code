/** See common.ts for contribution rules. */

export const coordinator = {
  // ── coordinator mode markers ──
  'coordinator.marker.activated': 'Coordinator Mode activated',
  'coordinator.marker.deactivated': 'Coordinator Mode deactivated',

  // ── /coordinator command ──
  'coordinator.command.usage': 'Usage: /coordinator [on|off]',
  'coordinator.command.alreadyOn': 'Coordinator Mode is already on.',
  'coordinator.command.alreadyOff': 'Coordinator Mode is already off.',
  'coordinator.command.notEnabled': 'Coordinator Mode not enabled.',
  'coordinator.command.enableFailed': 'Failed to enable Coordinator Mode: {error}',
  'coordinator.command.disableFailed': 'Failed to disable Coordinator Mode: {error}',
} as const;
