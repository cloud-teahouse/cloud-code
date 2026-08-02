import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { t, type MessageKey } from '#/tui/i18n';
import type { OutputStyleSummary } from '@cloud-code/sdk';

export interface OutputStyleSelectorOptions {
  /** Styles visible to the session (builtin + user/project/plugin dirs). */
  readonly styles: readonly OutputStyleSummary[];
  /** Currently active style name (`default` when none is selected). */
  readonly currentValue: string;
  readonly onSelect: (name: string) => void;
  readonly onCancel: () => void;
}

export const DEFAULT_OUTPUT_STYLE_VALUE = 'default';

/**
 * Bundled styles ship their descriptions from agent-core markdown (English,
 * no i18n layer there); the picker localizes them by style name. Names stay
 * English everywhere — they are the identifiers used by `/output-style
 * <name>` and the `output_style` config key. Descriptions of user, project,
 * and plugin styles are author-provided data and pass through verbatim.
 */
const BUILTIN_STYLE_DESCRIPTION_KEY: Readonly<Record<string, MessageKey>> = {
  concise: 'dialogs.outputStyle.builtin.conciseDescription',
  explanatory: 'dialogs.outputStyle.builtin.explanatoryDescription',
  reviewer: 'dialogs.outputStyle.builtin.reviewerDescription',
  debugger: 'dialogs.outputStyle.builtin.debuggerDescription',
  teacher: 'dialogs.outputStyle.builtin.teacherDescription',
};

/** Localized description for a bundled style; the raw one otherwise. */
function styleDescription(style: OutputStyleSummary): string | undefined {
  const key = style.source === 'builtin' ? BUILTIN_STYLE_DESCRIPTION_KEY[style.name] : undefined;
  if (key !== undefined) return t(key);
  return style.description.length > 0 ? style.description : undefined;
}

export class OutputStyleSelectorComponent extends ChoicePickerComponent {
  constructor(opts: OutputStyleSelectorOptions) {
    const options: ChoiceOption[] = [
      {
        value: DEFAULT_OUTPUT_STYLE_VALUE,
        label: t('dialogs.outputStyle.default'),
        description: t('dialogs.outputStyle.defaultDescription'),
      },
      ...opts.styles.map((style) => ({
        value: style.name,
        label: style.name,
        description: styleDescription(style),
      })),
    ];
    super({
      title: t('dialogs.outputStyle.title'),
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
