export interface ToolbarTip {
  /**
   * i18n key of the tip text (module-level constants predate the runtime
   * locale). Consumers resolve it with `resolveDescription()` at render/pick
   * time. Keeping the field name `text` preserves the public shape.
   */
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: 'tips.ctrlS', priority: 2, solo: true },
  { text: 'tips.tasks', priority: 2 },
  { text: 'tips.init', priority: 2 },
  { text: 'tips.dance' },
  { text: 'tips.pluginsSuperpowers', solo: true, priority: 3 },
  { text: 'tips.pluginsDatasource', solo: true, priority: 3 },
  { text: 'tips.schedule', solo: true, priority: 3 },
  { text: 'tips.sessions', solo: true },
  { text: 'tips.goal', priority: 2, solo: true  },
  { text: 'tips.goalNext', solo: true },
  { text: 'tips.web', solo: true },
  { text: 'tips.mention', priority: 2 },
  { text: 'tips.shell', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'tips.fast', priority: 2 },
  { text: 'tips.shiftEnter' },
  { text: 'tips.ctrlC' },
  { text: 'tips.theme' },
  { text: 'tips.auto' },
  { text: 'tips.yolo' },
  { text: 'tips.help' },
  { text: 'tips.compact', priority: 2 },
  { text: 'tips.ctrlO', priority: 2 },
  { text: 'tips.shiftTab', priority: 2 },
  { text: 'tips.model', priority: 2 },
];
