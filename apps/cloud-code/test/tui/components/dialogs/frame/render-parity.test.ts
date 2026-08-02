/**
 * Render-parity baseline for the search-dialog family (model selector,
 * tabbed model selector, choice picker, session picker), the approval/question
 * dialogs, and the plugins family (experiments selector, plugins panel,
 * plugin MCP selector, provider manager, custom registry import), and the
 * takeover browsers, goal queue manager, status dialog, help panel,
 * effort/rewind-mode/undo selectors: full-ANSI snapshots of each
 * dialog's rendered lines across representative states, at widths
 * 24/40/80/120 (48/80/120 for the takeover browsers, which show a too-small
 * notice below 48 columns) under the en and zh-CN locales. Migrating these
 * dialogs onto the shared dialog frame / declarative hit zones must not
 * change a single rendered byte, so the snapshots were recorded against the
 * pre-migration implementations.
 */

import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ExperimentalFeatureState,
  ModelAlias,
  ProviderConfig,
  TeamWire,
} from '@cloud-code/sdk';
import type { Terminal } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { CustomRegistryImportDialogComponent } from '#/tui/components/dialogs/custom-registry-import';
import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { ExperimentsSelectorComponent } from '#/tui/components/dialogs/experiments-selector';
import { GoalQueueManagerComponent } from '#/tui/components/dialogs/goal-queue-manager';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { RewindModeSelectorComponent } from '#/tui/components/dialogs/rewind-mode-selector';
import { StatusDialogComponent } from '#/tui/components/dialogs/status-dialog';
import { TasksBrowserApp } from '#/tui/components/dialogs/tasks-browser';
import { TeamsBrowserApp } from '#/tui/components/dialogs/teams-browser';
import { UndoSelectorComponent, type UndoChoice } from '#/tui/components/dialogs/undo-selector';
import { WorkflowsBrowserApp } from '#/tui/components/dialogs/workflows-browser';
import {
  PluginMcpSelectorComponent,
  PluginsPanelComponent,
} from '#/tui/components/dialogs/plugins-selector';
import { ProviderManagerComponent } from '#/tui/components/dialogs/provider-manager';
import { SessionPickerComponent, type SessionRow } from '#/tui/components/dialogs/session-picker';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { CoordinatorStartPermissionPromptComponent } from '#/tui/components/dialogs/coordinator-start-permission-prompt';
import { GoalStartPermissionPromptComponent } from '#/tui/components/dialogs/goal-start-permission-prompt';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { SwarmStartPermissionPromptComponent } from '#/tui/components/dialogs/swarm-start-permission-prompt';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';
import type { UpcomingGoal } from '#/tui/goal-queue-store';
import { setLocalePreference, type Locale } from '#/tui/i18n';
import type { PendingApproval, PendingQuestion } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const WIDTHS = [24, 40, 80, 120] as const;
/** Takeover browsers render their too-small notice below 48 columns (by design). */
const TAKEOVER_WIDTHS = [48, 80, 120] as const;
const LOCALES: Locale[] = ['en', 'zh-CN'];
const ESC = String.fromCodePoint(27);
/** Fixed clock for states that render relative times or durations. */
const FIXED_NOW = new Date('2026-06-15T12:00:00Z').getTime();

interface Renderable {
  render(width: number): string[];
}

/** One snapshot per state × locale: a freshly built dialog at every width. */
function expectParity(
  name: string,
  make: () => Renderable,
  widths: readonly number[] = WIDTHS,
): void {
  for (const locale of LOCALES) {
    it(`${name} (${locale})`, () => {
      setLocalePreference(locale);
      const component = make();
      const lines = widths.map(
        (width) => `=== width ${String(width)} ===\n${component.render(width).join('\n')}`,
      );
      expect(lines.join('\n')).toMatchSnapshot();
    });
  }
}

function model(displayName: string, provider = 'managed:kimi-code', capabilities = ['thinking']): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
  } as unknown as ModelAlias;
}

function effortModel(displayName: string): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  } as unknown as ModelAlias;
}

const noop = (): void => {};

describe('search-dialog render parity', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  describe('ModelSelectorComponent', () => {
    expectParity(
      'basic list',
      () =>
        new ModelSelectorComponent({
          models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
          currentValue: 'a',
          currentThinkingEffort: 'on',
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity('searchable with warning, query typed', () => {
      const picker = new ModelSelectorComponent({
        models: { kimi: model('Kimi K2'), pro: model('Kimi K2 Pro'), gpt: model('GPT-5', 'openai') },
        currentValue: 'kimi',
        currentThinkingEffort: 'on',
        searchable: true,
        warning: 'Switching models mid-conversation re-reads the context.',
        onSelect: noop,
        onSessionOnlySelect: noop,
        onAddCustom: noop,
        manage: { isCustom: (alias) => alias === 'pro', onEdit: noop, onDelete: noop, onGuard: noop },
        onCancel: noop,
      });
      picker.handleInput('/');
      picker.handleInput('K');
      return picker;
    });

    expectParity(
      'effort segments',
      () =>
        new ModelSelectorComponent({
          models: { k2: effortModel('Kimi K2'), gpt: model('GPT-5', 'openai', []) },
          currentValue: 'k2',
          currentThinkingEffort: 'medium',
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity('delete confirmation armed', () => {
      const picker = new ModelSelectorComponent({
        models: { kimi: model('Kimi K2'), pro: model('Kimi K2 Pro') },
        currentValue: 'kimi',
        currentThinkingEffort: 'on',
        manage: {
          isCustom: () => true,
          onEdit: noop,
          onDelete: noop,
          onGuard: noop,
          deleteImpact: (alias) => [`removes ${alias} from the config`],
        },
        onSelect: noop,
        onCancel: noop,
      });
      picker.handleInput(`${ESC}[B`); // cursor onto the second (custom) row
      picker.handleInput(`${ESC}d`); // Alt+D arms the inline delete confirm
      return picker;
    });
  });

  describe('TabbedModelSelectorComponent', () => {
    const tabbedOpts = () => ({
      models: { k2: model('Kimi K2'), gpt: model('GPT-5', 'openai') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      onSelect: noop,
      onCancel: noop,
    });

    expectParity('all tab', () => new TabbedModelSelectorComponent(tabbedOpts()));

    expectParity('provider tab active', () => {
      const picker = new TabbedModelSelectorComponent(tabbedOpts());
      picker.handleInput('\t');
      return picker;
    });

    expectParity('warning with query typed', () => {
      const picker = new TabbedModelSelectorComponent({
        ...tabbedOpts(),
        warning: 'Switching may increase token usage.',
      });
      picker.handleInput('/');
      picker.handleInput('G');
      return picker;
    });

    expectParity(
      'single tab',
      () =>
        new TabbedModelSelectorComponent({
          models: {},
          currentValue: 'k2',
          currentThinkingEffort: 'off',
          onSelect: noop,
          onCancel: noop,
        }),
    );
  });

  describe('ChoicePickerComponent', () => {
    expectParity(
      'basic list',
      () =>
        new ChoicePickerComponent({
          title: 'Select editor',
          options: [
            { value: 'vim', label: 'Vim' },
            { value: 'emacs', label: 'Emacs' },
            { value: 'code', label: 'VS Code' },
          ],
          currentValue: 'vim',
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'searchable with notice, descriptions, pagination',
      () =>
        new ChoicePickerComponent({
          title: 'Select permission mode',
          notice: 'Applies to this session only.',
          noticeTone: 'warning',
          options: [
            { value: 'manual', label: 'Manual', description: 'Ask before commands, edits, and other risky actions.' },
            { value: 'auto', label: 'Auto', description: 'Automatically approve tool actions and plan transitions.' },
            { value: 'plan', label: 'Plan', description: 'Read-only planning before execution.' },
          ],
          currentValue: 'manual',
          searchable: true,
          pageSize: 2,
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'custom hint lines with formatter',
      () =>
        new ChoicePickerComponent({
          title: 'Custom hint',
          hint: 'First hint line\nSecond hint line with a fair amount of text to wrap',
          formatHint: (text) => `<${text}>`,
          options: [{ value: 'a', label: 'Alpha' }],
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity('no matches', () => {
      const picker = new ChoicePickerComponent({
        title: 'Add provider',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
        searchable: true,
        onSelect: noop,
        onCancel: noop,
      });
      picker.handleInput('/');
      picker.handleInput('z');
      picker.handleInput('z');
      return picker;
    });
  });

  describe('SessionPickerComponent', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const sessions = (): SessionRow[] => {
      const now = Date.now();
      return [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          last_prompt: 'fix the bug in the parser',
          work_dir: '/tmp/project-a',
          updated_at: now - DAY,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-b',
          updated_at: now - 3 * DAY,
        },
        {
          id: 'ses_gamma',
          title: 'Gamma session',
          work_dir: '/tmp/project-c',
          updated_at: now - 9 * DAY,
        },
      ];
    };

    expectParity(
      'cards with current mark and scope toggle',
      () =>
        new SessionPickerComponent({
          sessions: sessions(),
          loading: false,
          currentSessionId: 'ses_beta',
          onToggleScope: noop,
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'loading',
      () =>
        new SessionPickerComponent({
          sessions: [],
          loading: true,
          currentSessionId: '',
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'empty',
      () =>
        new SessionPickerComponent({
          sessions: [],
          loading: false,
          currentSessionId: '',
          onToggleScope: noop,
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity('all-scope with query typed', () => {
      const picker = new SessionPickerComponent({
        sessions: sessions(),
        loading: false,
        currentSessionId: '',
        scope: 'all',
        onToggleScope: noop,
        onSelect: noop,
        onCancel: noop,
      });
      picker.handleInput('/');
      picker.handleInput('s');
      picker.handleInput('e');
      return picker;
    });
  });
});

/** Motion at the row of the rendered line containing `marker` (hover state). */
function hoverMarker(component: Renderable, marker: string): void {
  const lines = component
    .render(80)
    .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''));
  const row = lines.findIndex((line) => line.includes(marker));
  if (row < 0) throw new Error(`marker not rendered: ${marker}`);
  (component as unknown as { handleMouse(event: unknown): void }).handleMouse({
    type: 'motion',
    button: 3,
    col: 5,
    row,
    slotRelative: false,
  });
}

function pendingApproval(overrides: Partial<PendingApproval['data']> = {}): PendingApproval {
  return {
    data: {
      id: 'approval_parity',
      tool_call_id: 'tool_parity',
      tool_name: 'Write',
      action: 'write a file',
      description: 'Update README.md with the new usage section.',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
      ...overrides,
    },
  };
}

function pendingQuestion(questions: PendingQuestion['data']['questions']): PendingQuestion {
  return { data: { id: 'question_parity', tool_call_id: 'tool_parity', questions } };
}

describe('approval/question dialog render parity', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  describe('ApprovalPanelComponent', () => {
    expectParity(
      'choices with descriptions',
      () =>
        new ApprovalPanelComponent(
          pendingApproval({
            tool_name: 'CreateGoal',
            action: 'Creating a goal',
            description: '',
            choices: [
              {
                label: 'Switch to Auto and start',
                response: 'approved',
                description: 'Tools are approved automatically, and questions are skipped.',
              },
              { label: 'Do not start', response: 'cancelled' },
            ],
          }),
          noop,
        ),
    );

    expectParity(
      'shell block with danger and requester badge',
      () =>
        new ApprovalPanelComponent(
          pendingApproval({
            tool_name: 'Bash',
            display: [
              {
                type: 'shell',
                language: 'bash',
                command: 'rm -rf build && pnpm build',
                cwd: '/tmp/project',
                danger: 'recursive delete',
                description: 'potentially destructive cleanup',
              },
            ],
            requester: { name: 'researcher', teamName: 'core' },
          }),
          noop,
        ),
    );

    expectParity(
      'diff block with preview hint',
      () =>
        new ApprovalPanelComponent(
          pendingApproval({
            tool_name: 'Edit',
            display: [
              {
                type: 'diff',
                path: 'src/index.ts',
                old_text: 'const a = 1;\nconst b = 2;\nconst c = 3;',
                new_text: 'const a = 1;\nconst b = 20;\nconst c = 3;',
              },
            ],
          }),
          noop,
        ),
    );

    expectParity('feedback mode armed', () => {
      const dialog = new ApprovalPanelComponent(pendingApproval(), noop);
      dialog.handleInput(`${ESC}[B`); // down
      dialog.handleInput(`${ESC}[B`);
      dialog.handleInput(`${ESC}[B`);
      dialog.handleInput('\r'); // arms the inline feedback input
      dialog.handleInput('n');
      dialog.handleInput('o');
      return dialog;
    });

    expectParity('hovered choice underlined', () => {
      const dialog = new ApprovalPanelComponent(pendingApproval(), noop);
      hoverMarker(dialog, '2. Approve for this session');
      return dialog;
    });
  });

  describe('QuestionDialogComponent', () => {
    expectParity(
      'question tab with descriptions',
      () =>
        new QuestionDialogComponent(
          pendingQuestion([
            {
              question: 'Which approach do you prefer?',
              header: 'Approach',
              multi_select: false,
              options: [
                { label: 'Refactor the module', description: 'Keeps the public API stable.' },
                { label: 'Rewrite from scratch', description: 'Drops every legacy caller.' },
              ],
            },
            {
              question: 'Ship behind a flag?',
              header: 'Flag',
              multi_select: false,
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ]),
          noop,
        ),
    );

    expectParity('multi-select toggled', () => {
      const dialog = new QuestionDialogComponent(
        pendingQuestion([
          {
            question: 'Which files should be included?',
            multi_select: true,
            options: [
              { label: 'src/index.ts' },
              { label: 'src/app.ts', description: 'The application entry point.' },
              { label: 'README.md' },
            ],
          },
        ]),
        noop,
      );
      dialog.handleInput(' '); // toggle the first option
      return dialog;
    });

    expectParity('other input armed', () => {
      const dialog = new QuestionDialogComponent(
        pendingQuestion([
          {
            question: 'Which region?',
            multi_select: false,
            options: [{ label: 'us-east' }, { label: 'eu-west' }],
          },
        ]),
        noop,
      );
      dialog.handleInput(`${ESC}[B`); // cursor onto Other
      dialog.handleInput(`${ESC}[B`);
      dialog.handleInput('\r'); // arms the inline Other input
      dialog.handleInput('a');
      dialog.handleInput('p');
      return dialog;
    });

    expectParity('submit tab with an unanswered question', () => {
      const dialog = new QuestionDialogComponent(
        pendingQuestion([
          {
            question: 'Pick a color',
            multi_select: false,
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
          {
            question: 'Pick a size',
            multi_select: false,
            options: [{ label: 'Small' }, { label: 'Large' }],
          },
        ]),
        noop,
      );
      dialog.handleInput('1'); // answer Q1, advance to Q2
      dialog.handleInput('\t'); // jump to the submit tab, Q2 unanswered
      return dialog;
    });

    expectParity('body lines and windowed options', () => {
      const dialog = new QuestionDialogComponent(
        pendingQuestion([
          {
            question: 'Pick one of many',
            body: Array.from({ length: 15 }, (_, i) => `Context line ${String(i + 1)}.`).join('\n'),
            multi_select: false,
            options: Array.from({ length: 9 }, (_, i) => ({ label: `Option ${String(i + 1)}` })),
          },
        ]),
        noop,
      );
      dialog.handleInput(`${ESC}[B`); // scroll the option window
      dialog.handleInput(`${ESC}[B`);
      dialog.handleInput(`${ESC}[B`);
      return dialog;
    });

    expectParity('hovered option underlined', () => {
      const dialog = new QuestionDialogComponent(
        pendingQuestion([
          {
            question: 'Pick a color',
            multi_select: false,
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
        ]),
        noop,
      );
      hoverMarker(dialog, '[2] Blue');
      return dialog;
    });
  });

  describe('StartPermissionPromptComponent family', () => {
    expectParity(
      'goal manual',
      () =>
        new GoalStartPermissionPromptComponent({ mode: 'manual', onSelect: noop, onCancel: noop }),
    );

    expectParity(
      'goal yolo',
      () =>
        new GoalStartPermissionPromptComponent({ mode: 'yolo', onSelect: noop, onCancel: noop }),
    );

    expectParity(
      'coordinator',
      () => new CoordinatorStartPermissionPromptComponent({ onSelect: noop, onCancel: noop }),
    );

    expectParity('swarm hovered option', () => {
      const dialog = new SwarmStartPermissionPromptComponent({ onSelect: noop, onCancel: noop });
      hoverMarker(dialog, 'YOLO'); // locale-stable substring of the YOLO label
      return dialog;
    });
  });
});

describe('plugins-family dialog render parity', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  const feature = (
    overrides: Partial<ExperimentalFeatureState> = {},
  ): ExperimentalFeatureState => ({
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'CLOUD_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  });

  describe('ExperimentsSelectorComponent', () => {
    expectParity(
      'feature list',
      () =>
        new ExperimentsSelectorComponent({
          features: [
            feature(),
            feature({
              id: 'second_feature',
              title: 'Second feature',
              description: 'Second detail.',
              enabled: false,
            }),
            feature({
              id: 'locked_feature',
              title: 'Locked feature',
              description: 'Locked detail.',
              source: 'env',
            }),
          ],
          onApply: noop,
          onCancel: noop,
        }),
    );

    expectParity('query typed with a draft change', () => {
      const selector = new ExperimentsSelectorComponent({
        features: [
          feature(),
          feature({
            id: 'other_feature',
            title: 'Other feature',
            description: 'Other detail.',
            enabled: false,
          }),
        ],
        onApply: noop,
        onCancel: noop,
      });
      selector.handleInput(' '); // draft a toggle on the first feature
      selector.handleInput('/');
      selector.handleInput('m');
      return selector;
    });

    expectParity('hovered feature underlined', () => {
      const selector = new ExperimentsSelectorComponent({
        features: [
          feature(),
          feature({
            id: 'second_feature',
            title: 'Second feature',
            description: 'Second detail.',
            enabled: false,
          }),
        ],
        onApply: noop,
        onCancel: noop,
      });
      hoverMarker(selector, 'Second feature');
      return selector;
    });
  });

  const superpowersPlugin = {
    id: 'superpowers',
    displayName: 'Superpowers',
    version: '5.1.0',
    enabled: true,
    state: 'ok' as const,
    skillCount: 14,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path' as const,
  };
  const officialEntries = [
    {
      id: 'kimi-datasource',
      tier: 'official' as const,
      displayName: 'Kimi Datasource',
      version: '3.1.1',
      source: 'https://x/d.zip',
    },
  ];
  const thirdPartyEntries = [
    {
      id: 'superpowers',
      tier: 'curated' as const,
      displayName: 'Superpowers',
      source: 'https://x/s.zip',
    },
  ];
  const marketplaceEntries = [...officialEntries, ...thirdPartyEntries];

  describe('PluginsPanelComponent', () => {
    expectParity('installed tab with update badge', () => {
      const panel = new PluginsPanelComponent({
        installed: [{ ...superpowersPlugin, version: '4.0.0' }],
        installedIds: new Set(['superpowers']),
        onSelect: noop,
        onCancel: noop,
      });
      panel.setMarketplace(
        [
          {
            id: 'superpowers',
            tier: 'curated' as const,
            displayName: 'Superpowers',
            version: '5.0.0',
            source: 'https://x/s.zip',
          },
        ],
        '/tmp/marketplace.json',
      );
      return panel;
    });

    expectParity('official tab with catalog', () => {
      const panel = new PluginsPanelComponent({
        installed: [],
        installedIds: new Set(),
        initialTab: 'official',
        onSelect: noop,
        onCancel: noop,
      });
      panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
      return panel;
    });

    expectParity('custom tab', () => {
      const panel = new PluginsPanelComponent({
        installed: [],
        installedIds: new Set(),
        initialTab: 'custom',
        onSelect: noop,
        onCancel: noop,
      });
      panel.focused = true;
      return panel;
    });

    expectParity('installing', () => {
      const panel = new PluginsPanelComponent({
        installed: [superpowersPlugin],
        installedIds: new Set(['superpowers']),
        onSelect: noop,
        onCancel: noop,
      });
      panel.setInstalling('Superpowers');
      return panel;
    });

    expectParity('hovered row underlined', () => {
      const panel = new PluginsPanelComponent({
        installed: [superpowersPlugin],
        installedIds: new Set(['superpowers']),
        onSelect: noop,
        onCancel: noop,
      });
      hoverMarker(panel, 'Superpowers');
      return panel;
    });

    // The search box is the deliberate visual change of the search migration:
    // it renders on the three list tabs (Installed/Official/Third-party).
    expectParity('installed tab with query typed', () => {
      const panel = new PluginsPanelComponent({
        installed: [
          superpowersPlugin,
          { ...superpowersPlugin, id: 'kimi-datasource', displayName: 'Kimi Datasource', skillCount: 1 },
        ],
        installedIds: new Set(['superpowers', 'kimi-datasource']),
        onSelect: noop,
        onCancel: noop,
      });
      panel.handleInput('/');
      panel.handleInput('d');
      panel.handleInput('a');
      return panel;
    });

    expectParity('official tab with query typed', () => {
      const panel = new PluginsPanelComponent({
        installed: [],
        installedIds: new Set(),
        initialTab: 'official',
        onSelect: noop,
        onCancel: noop,
      });
      panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
      panel.handleInput('/');
      panel.handleInput('d');
      panel.handleInput('a');
      return panel;
    });

    expectParity('marketplace tab with no matches', () => {
      const panel = new PluginsPanelComponent({
        installed: [],
        installedIds: new Set(),
        initialTab: 'third-party',
        onSelect: noop,
        onCancel: noop,
      });
      panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
      panel.handleInput('/');
      panel.handleInput('z');
      panel.handleInput('z');
      return panel;
    });
  });

  describe('PluginMcpSelectorComponent', () => {
    const mcpInfo = {
      id: 'kimi-datasource',
      displayName: 'Kimi Datasource',
      version: '1.0.0',
      enabled: true,
      state: 'ok' as const,
      skillCount: 1,
      mcpServerCount: 2,
      enabledMcpServerCount: 1,
      hookCount: 0,
      commandCount: 0,
      hasErrors: false,
      source: 'local-path' as const,
      installedAt: '2026-05-29T00:00:00.000Z',
      root: '/plugins/kimi-datasource',
      manifest: undefined,
      mcpServers: [
        {
          name: 'data',
          runtimeName: 'plugin-kimi-datasource-data',
          enabled: true,
          transport: 'stdio' as const,
          command: 'node',
          args: ['./bin/kimi-datasource.mjs'],
          cwd: '/plugins/kimi-datasource',
        },
        {
          name: 'search',
          runtimeName: 'plugin-kimi-datasource-search',
          enabled: false,
          transport: 'http' as const,
          url: 'https://mcp.example.com/sse',
        },
      ],
      diagnostics: [],
    };

    expectParity(
      'server list',
      () => new PluginMcpSelectorComponent({ info: mcpInfo, onSelect: noop, onCancel: noop }),
    );

    expectParity(
      'server hint',
      () =>
        new PluginMcpSelectorComponent({
          info: mcpInfo,
          serverHint: { server: 'data', text: 'pending /new' },
          onSelect: noop,
          onCancel: noop,
        }),
    );
  });

  describe('ProviderManagerComponent', () => {
    expectParity(
      'provider list',
      () =>
        new ProviderManagerComponent({
          providers: {
            acme: { baseUrl: 'https://acme.test' },
            registry: {
              baseUrl: 'https://reg.test/v1',
              source: { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' },
            },
          } as unknown as Record<string, ProviderConfig>,
          activeProviderId: 'acme',
          onAdd: noop,
          onDeleteSource: noop,
          onClose: noop,
        }),
    );

    expectParity('delete confirmation armed', () => {
      const manager = new ProviderManagerComponent({
        providers: {
          acme: { baseUrl: 'https://acme.test' },
        } as unknown as Record<string, ProviderConfig>,
        models: {
          'acme/m1': { provider: 'acme', model: 'm1', maxContextSize: 1024 },
          'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 1024 },
        } as unknown as Record<string, ModelAlias>,
        onAdd: noop,
        onDeleteSource: noop,
        onClose: noop,
      });
      manager.handleInput('D');
      return manager;
    });

    expectParity(
      'paged list',
      () =>
        new ProviderManagerComponent({
          providers: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`p${String(i)}`, { baseUrl: undefined }]),
          ) as unknown as Record<string, ProviderConfig>,
          onAdd: noop,
          onDeleteSource: noop,
          onClose: noop,
        }),
    );
  });

  describe('CustomRegistryImportDialogComponent', () => {
    expectParity('url field focused', () => {
      const dialog = new CustomRegistryImportDialogComponent(noop, 'https://example.com/api.json');
      dialog.focused = true;
      return dialog;
    });

    expectParity('token field with masked input', () => {
      const dialog = new CustomRegistryImportDialogComponent(noop, 'https://example.com/api.json');
      dialog.focused = true;
      dialog.handleInput('\r'); // advance to the token field
      for (const ch of 'sk-tok') dialog.handleInput(ch);
      return dialog;
    });
  });
});

describe('wave-2c dialog render parity', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
    vi.useRealTimers();
  });

  const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

  function processTask(taskId: string, status: BackgroundTaskStatus): BackgroundTaskInfo {
    return {
      taskId,
      kind: 'process',
      description: `index the ${taskId} workspace`,
      command: `indexer --root ${taskId}`,
      status,
      detached: true,
      startedAt: FIXED_NOW - 3_600_000,
      endedAt: status === 'running' ? null : FIXED_NOW - 60_000,
      pid: 4242,
      exitCode: status === 'completed' ? 0 : null,
    } as unknown as BackgroundTaskInfo;
  }

  describe('TasksBrowserApp', () => {
    const tasksProps = () => ({
      tasks: [processTask('tsk_alpha', 'running'), processTask('tsk_beta', 'completed')],
      filter: 'all' as const,
      selectedTaskId: 'tsk_alpha',
      tailOutput: 'first line\nsecond line\nthird line',
      tailLoading: false,
      flashMessage: undefined,
      onSelect: noop,
      onToggleFilter: noop,
      onRefresh: noop,
      onCancel: noop,
      onStopConfirmed: noop,
      onOpenOutput: noop,
    });

    expectParity(
      'list + detail + preview',
      () => new TasksBrowserApp(tasksProps(), stubTerminal()),
      TAKEOVER_WIDTHS,
    );

    expectParity(
      'empty list',
      () => new TasksBrowserApp({ ...tasksProps(), tasks: [], selectedTaskId: undefined }, stubTerminal()),
      TAKEOVER_WIDTHS,
    );

    expectParity('stop confirmation armed', () => {
      const browser = new TasksBrowserApp(tasksProps(), stubTerminal());
      browser.handleInput('s');
      return browser;
    }, TAKEOVER_WIDTHS);
  });

  describe('TeamsBrowserApp', () => {
    const team = (name: string): TeamWire =>
      ({
        name,
        createdBy: 'main',
        members: [
          { name: 'lead', agentId: `${name}-lead` },
          { name: 'worker', agentId: `${name}-worker` },
        ],
        tasks: [
          { id: 1, subject: 'draft the RFC', status: 'completed', owner: 'lead' },
          { id: 2, subject: 'implement the parser', status: 'in_progress', owner: 'worker' },
        ],
      }) as unknown as TeamWire;

    expectParity(
      'team list + detail',
      () =>
        new TeamsBrowserApp(
          {
            teams: [team('core'), team('infra')],
            activity: [],
            memberLiveness: new Map([['core-worker', 'running']]),
            selectedTeamName: 'core',
            onSelect: noop,
            onCancel: noop,
          },
          stubTerminal(),
        ),
      TAKEOVER_WIDTHS,
    );

    expectParity(
      'empty roster',
      () =>
        new TeamsBrowserApp(
          {
            teams: [],
            activity: [],
            memberLiveness: new Map(),
            selectedTeamName: undefined,
            onSelect: noop,
            onCancel: noop,
          },
          stubTerminal(),
        ),
      TAKEOVER_WIDTHS,
    );
  });

  describe('WorkflowsBrowserApp', () => {
    function workflowNode(
      agentId: string,
      overrides: Partial<WorkflowAgentNode> = {},
    ): WorkflowAgentNode {
      return {
        agentId,
        name: agentId,
        parentAgentId: undefined,
        parentToolCallId: undefined,
        swarmIndex: undefined,
        runInBackground: false,
        description: undefined,
        status: 'done',
        statusDetail: undefined,
        model: 'kimi-k2',
        step: 3,
        startedAt: FIXED_NOW - 120_000,
        endedAt: FIXED_NOW - 60_000,
        usage: undefined,
        contextTokens: undefined,
        thinkingText: '',
        thinkingTruncated: false,
        tools: [],
        toolCallCount: 0,
        activity: [{ kind: 'thinking', text: 'weighing the options' }],
        activityTruncated: false,
        resultSummary: undefined,
        revision: 1,
        ...overrides,
      };
    }

    const workflowProps = () => ({
      agents: [
        workflowNode('main', { status: 'running', endedAt: undefined }),
        workflowNode('agent-worker', { parentAgentId: 'main' }),
      ],
      selectedAgentId: 'main',
      onSelect: noop,
      onCancel: noop,
    });

    expectParity(
      'tree with subagent',
      () => new WorkflowsBrowserApp(workflowProps(), stubTerminal()),
      TAKEOVER_WIDTHS,
    );

    expectParity('full-width detail mode', () => {
      const browser = new WorkflowsBrowserApp(workflowProps(), stubTerminal());
      browser.handleInput(`${ESC}[C`); // → drills into the detail view
      return browser;
    }, TAKEOVER_WIDTHS);
  });

  describe('GoalQueueManagerComponent', () => {
    const goal = (id: string): UpcomingGoal => ({
      id,
      objective: `objective ${id}: keep the build green`,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    });

    expectParity(
      'goal list',
      () =>
        new GoalQueueManagerComponent({
          goals: [goal('g1'), goal('g2'), goal('g3')],
          onAction: noop,
          onCancel: noop,
        }),
    );

    expectParity('reorder armed', () => {
      const manager = new GoalQueueManagerComponent({
        goals: [goal('g1'), goal('g2')],
        onAction: noop,
        onCancel: noop,
      });
      manager.handleInput(' ');
      return manager;
    });

    expectParity(
      'empty queue',
      () => new GoalQueueManagerComponent({ goals: [], onAction: noop, onCancel: noop }),
    );
  });

  describe('StatusDialogComponent', () => {
    const statusOpts = () => ({
      status: {
        version: '1.2.3',
        model: 'k2',
        workDir: '/tmp/project',
        sessionId: 'ses-1',
        sessionTitle: 'My session',
        availableModels: {},
        permissionMode: 'manual' as const,
        contextUsage: 0.25,
        contextTokens: 2500,
        maxContextTokens: 10000,
        mcpServers: [],
      },
      kimi: { account: { state: 'not-logged-in' as const }, availableModels: {}, sessionUsage: { byModel: {} } },
      chatgpt: {
        account: { state: 'not-logged-in' as const },
        model: 'k2',
        availableModels: {},
        sessionUsage: { byModel: {} },
        rateLimit: null,
      },
      stats: {
        buckets: [
          { date: '2026-06-14', tokens: 2000 },
          { date: '2026-06-15', tokens: 3000 },
        ],
        stats: {
          totalTokens: 5000,
          activeDays: 2,
          mostActiveDay: { date: '2026-06-14', tokens: 2000 },
          favoriteModel: { model: 'kimi-k2', tokens: 4000 },
          sessionCount: 3,
          longestSessionMs: 3_660_000,
        },
      },
      onCancel: noop,
    });

    expectParity('status tab', () => new StatusDialogComponent(statusOpts()));

    expectParity(
      'stats tab with range selector',
      () => new StatusDialogComponent({ ...statusOpts(), initialTab: 'stats' }),
    );

    // Full-ANSI coverage for the two account tabs (the label/value and
    // progress-bar rows migrated onto Row/columnWidth).
    const accountModels = {
      k2: {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 10000,
        displayName: 'Kimi K2',
      },
      'gpt-5-codex': {
        provider: 'managed:chatgpt-codex',
        model: 'gpt-5-codex',
        maxContextSize: 272000,
        displayName: 'GPT-5 Codex',
      },
    } as unknown as Record<string, ModelAlias>;

    expectParity(
      'kimi tab, logged in with managed usage',
      () =>
        new StatusDialogComponent({
          ...statusOpts(),
          initialTab: 'kimi',
          kimi: {
            account: { state: 'logged-in' },
            availableModels: accountModels,
            managedUsage: {
              summary: { name: 'This week', used: 42, limit: 100 },
              limits: [
                {
                  window: { duration: 5, unit: 'hour' },
                  used: 12,
                  limit: 50,
                  resetAt: new Date(Date.now() + 3600_000).toISOString(),
                },
              ],
            },
            sessionUsage: {
              byModel: {
                k2: { inputOther: 1200, inputCacheRead: 300, inputCacheCreation: 0, output: 240 },
              },
            },
          },
        }),
    );

    expectParity(
      'chatgpt tab, logged in with session usage',
      () =>
        new StatusDialogComponent({
          ...statusOpts(),
          initialTab: 'chatgpt',
          chatgpt: {
            account: { state: 'logged-in', email: 'user@example.com', planType: 'plus' },
            availableModels: accountModels,
            sessionUsage: {
              byModel: {
                'gpt-5-codex': {
                  inputOther: 1000,
                  inputCacheRead: 0,
                  inputCacheCreation: 0,
                  output: 100,
                },
              },
            },
            rateLimit: null,
          },
        }),
    );
  });

  describe('HelpPanelComponent', () => {
    const helpOpts = () => ({
      commands: [
        { name: 'model', aliases: ['m'], description: 'Pick a model' },
        { name: 'help', aliases: [], description: 'Show this panel' },
      ],
      maxVisible: 8,
      onClose: noop,
    });

    expectParity('windowed list', () => new HelpPanelComponent(helpOpts()));

    expectParity('scrolled', () => {
      const panel = new HelpPanelComponent(helpOpts());
      panel.handleInput(`${ESC}[B`);
      panel.handleInput(`${ESC}[B`);
      return panel;
    });
  });

  describe('EffortSelectorComponent', () => {
    expectParity(
      'segments',
      () =>
        new EffortSelectorComponent({
          efforts: ['off', 'low', 'medium', 'high'],
          currentValue: 'medium',
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'with warning',
      () =>
        new EffortSelectorComponent({
          efforts: ['off', 'low', 'high'],
          currentValue: 'low',
          warning: 'Switching effort mid-conversation re-reads the context.',
          onSelect: noop,
          onSessionOnlySelect: noop,
          onCancel: noop,
        }),
    );
  });

  describe('RewindModeSelectorComponent', () => {
    expectParity(
      'mode list',
      () => new RewindModeSelectorComponent({ onSelect: noop, onCancel: noop }),
    );
  });

  describe('UndoSelectorComponent', () => {
    const undoChoice = (id: string): UndoChoice => ({
      id,
      count: 1,
      input: `prompt ${id}`,
      label: `undo ${id}: refactor the thing`,
    });

    expectParity(
      'windowed list',
      () =>
        new UndoSelectorComponent({
          choices: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'].map(undoChoice),
          onSelect: noop,
          onCancel: noop,
        }),
    );

    expectParity(
      'few choices',
      () =>
        new UndoSelectorComponent({
          choices: ['u1', 'u2'].map(undoChoice),
          onSelect: noop,
          onCancel: noop,
        }),
    );
  });
});
