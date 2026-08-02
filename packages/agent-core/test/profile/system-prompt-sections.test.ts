import { describe, expect, it } from 'vitest';

import {
  assembleSystemPrompt,
  changedSectionIds,
  DANGEROUS_uncachedSystemSection,
  DEFAULT_AGENT_PROFILES,
  segmentProfileSystemPrompt,
  systemSection,
  type SystemPromptContext,
} from '../../src/profile';

const OS_ENV = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

/** Minimal render context: every conditional template section stays omitted. */
const MINIMAL_CONTEXT: SystemPromptContext = {
  osEnv: OS_ENV,
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
};

/** Full render context: every conditional template section renders. */
const FULL_CONTEXT: SystemPromptContext = {
  osEnv: OS_ENV,
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  memory: '## Project memory — `/workspace/.cloud-code/memory/MEMORY.md`\n\n- [proj](proj.md)',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
  gitStatus: 'Current branch: feature-x',
  additionalDirsInfo: '### /extra\nEXTRA_LISTING',
  mcpInstructions: '## github\nUse the GitHub tools for PRs.',
  userLanguage: '简体中文',
};

const FULL_CONTEXT_IDS = [
  'identity',
  'language',
  'prompt-and-tool-use',
  'delegating-to-subagents',
  'communicating-with-user',
  'guidelines-coding',
  'delivering-work',
  'guidelines-research',
  'context-management',
  'working-environment',
  'env-os',
  'env-now',
  'env-cwd',
  'env-git-status',
  'env-additional-dirs',
  'project-information',
  'memory',
  'skills',
  'mcp-instructions',
  'ultimate-reminders',
];

describe('segmentProfileSystemPrompt', () => {
  it('splits the fully-rendered default template at every registered heading', () => {
    const rendered = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(FULL_CONTEXT);
    const sections = segmentProfileSystemPrompt(rendered);
    // Pinned sequence: a template edit that adds/renames a heading fails here
    // until the registry in system-prompt-sections.ts is updated to match.
    expect(sections.map((section) => section.id)).toEqual(FULL_CONTEXT_IDS);
  });

  it('omits conditionally-rendered sections from the sequence', () => {
    const rendered = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(MINIMAL_CONTEXT);
    const sections = segmentProfileSystemPrompt(rendered);
    expect(sections.map((section) => section.id)).toEqual(
      FULL_CONTEXT_IDS.filter(
        (id) =>
          !['env-git-status', 'env-additional-dirs', 'memory', 'skills', 'mcp-instructions'].includes(id),
      ),
    );
  });

  it('classifies template-fixed text static and render-context text dynamic', () => {
    const rendered = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(FULL_CONTEXT);
    const byId = new Map(
      segmentProfileSystemPrompt(rendered).map((section) => [section.id, section]),
    );
    expect(byId.get('identity')!.cache).toBe('static');
    expect(byId.get('prompt-and-tool-use')!.cache).toBe('static');
    expect(byId.get('ultimate-reminders')!.cache).toBe('static');
    expect(byId.get('language')!.cache).toBe('dynamic');
    expect(byId.get('env-now')!.cache).toBe('dynamic');
    expect(byId.get('project-information')!.cache).toBe('dynamic');
    expect(byId.get('memory')!.cache).toBe('dynamic');
    expect(byId.get('memory')!.origin).toBe('context');
    expect(byId.get('mcp-instructions')!.cache).toBe('dynamic');
  });

  it('segments every bundled profile losslessly', () => {
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      for (const context of [MINIMAL_CONTEXT, FULL_CONTEXT]) {
        const rendered = DEFAULT_AGENT_PROFILES[name]!.systemPrompt(context);
        const sections = segmentProfileSystemPrompt(rendered);
        expect(sections.map((section) => section.content).join('')).toBe(rendered);
      }
    }
  });

  it('ignores an injected already-consumed heading inside dynamic content', () => {
    const clean = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(FULL_CONTEXT);
    const injected = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt({
      ...FULL_CONTEXT,
      agentsMd: 'first line\n# Language\ninjected heading body',
    });
    const cleanIds = segmentProfileSystemPrompt(clean).map((section) => section.id);
    const injectedSections = segmentProfileSystemPrompt(injected);
    // `# Language` was already consumed by the real section; the injected copy
    // folds into `project-information` instead of splitting or duplicating ids.
    expect(injectedSections.map((section) => section.id)).toEqual(cleanIds);
    expect(injectedSections.map((section) => section.content).join('')).toBe(injected);
    expect(
      injectedSections.find((section) => section.id === 'project-information')!.content,
    ).toContain('# Language\ninjected heading body');
  });

  it('degrades a heading-less custom template to one dynamic identity section', () => {
    expect(segmentProfileSystemPrompt('completely custom prompt')).toEqual([
      { id: 'identity', content: 'completely custom prompt', cache: 'dynamic', origin: 'profile' },
    ]);
    expect(segmentProfileSystemPrompt('')).toEqual([]);
  });
});

describe('assembleSystemPrompt', () => {
  it('reproduces the rendered prompt byte-for-byte when no append section exists', () => {
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const rendered = DEFAULT_AGENT_PROFILES[name]!.systemPrompt(FULL_CONTEXT);
      const assembled = assembleSystemPrompt(segmentProfileSystemPrompt(rendered));
      expect(assembled.prompt).toBe(rendered);
    }
  });

  it('marks the dynamic boundary at the first non-static section', () => {
    const rendered = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(FULL_CONTEXT);
    const assembled = assembleSystemPrompt(segmentProfileSystemPrompt(rendered));
    expect(assembled.sections[assembled.dynamicBoundaryIndex]!.id).toBe('language');
    expect(assembled.dynamicBoundaryIndex).toBe(1);
    expect(assembled.staticPrefixTokens).toBe(assembled.sections[0]!.tokens);
  });

  it('resolves a sha256 and a token estimate per section', () => {
    const rendered = DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(FULL_CONTEXT);
    const assembled = assembleSystemPrompt(segmentProfileSystemPrompt(rendered));
    for (const section of assembled.sections) {
      expect(section.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(section.tokens).toBeGreaterThan(0);
    }
    // Dynamic-section edits must not move static-section hashes.
    const other = assembleSystemPrompt(
      segmentProfileSystemPrompt(
        DEFAULT_AGENT_PROFILES['agent']!.systemPrompt({ ...FULL_CONTEXT, agentsMd: 'OTHER' }),
      ),
    );
    for (const section of assembled.sections.filter((section) => section.cache === 'static')) {
      const counterpart = other.sections.find((candidate) => candidate.id === section.id)!;
      expect(counterpart.hash).toBe(section.hash);
    }
  });

  it('hangs append-bus sections at the tail with a normalized blank-line separator', () => {
    const sections = [
      systemSection({ id: 'a', content: 'AAA\n\n', cache: 'static', origin: 'default' }),
      systemSection({ id: 'b', content: 'BBB\n\n\n', cache: 'dynamic', origin: 'context' }),
      systemSection({ id: 'append:one', content: 'ONE\n', cache: 'dynamic', origin: 'append' }),
      systemSection({ id: 'append:two', content: 'TWO', cache: 'dynamic', origin: 'append' }),
    ];
    expect(assembleSystemPrompt(sections).prompt).toBe('AAA\n\nBBB\n\nONE\n\nTWO');
  });

  it('renders an append-only prompt without a leading separator', () => {
    const assembled = assembleSystemPrompt([
      systemSection({ id: 'append:one', content: 'ONE', cache: 'dynamic', origin: 'append' }),
    ]);
    expect(assembled.prompt).toBe('ONE');
    expect(assembled.dynamicBoundaryIndex).toBe(0);
  });

  it('rejects duplicate section ids', () => {
    expect(() =>
      assembleSystemPrompt([
        systemSection({ id: 'dup', content: 'A', cache: 'static', origin: 'default' }),
        systemSection({ id: 'dup', content: 'B', cache: 'static', origin: 'default' }),
      ]),
    ).toThrow(/Duplicate system prompt section id: "dup"/);
  });
});

describe('DANGEROUS_uncachedSystemSection', () => {
  it('requires a non-empty reason', () => {
    expect(() => DANGEROUS_uncachedSystemSection('x', 'body', 'context', '  ')).toThrow(
      /requires a reason/,
    );
  });

  it('marks the section uncached and keeps the reason', () => {
    const section = DANGEROUS_uncachedSystemSection('live', 'body', 'context', 'changes per turn');
    expect(section.cache).toBe('uncached');
    expect(section.uncachedReason).toBe('changes per turn');
  });

  it('rejects a cacheable section after an uncached one', () => {
    expect(() =>
      assembleSystemPrompt([
        DANGEROUS_uncachedSystemSection('live', 'A', 'context', 'per-turn value'),
        systemSection({ id: 'b', content: 'B', cache: 'dynamic', origin: 'context' }),
      ]),
    ).toThrow(/never be prompt-cached in that position/);
    expect(() =>
      assembleSystemPrompt([
        DANGEROUS_uncachedSystemSection('live', 'A', 'context', 'per-turn value'),
        systemSection({ id: 'b', content: 'B', cache: 'static', origin: 'default' }),
      ]),
    ).toThrow(/never be prompt-cached in that position/);
  });

  it('rejects a hand-written uncached literal without a reason', () => {
    // The reason is an assembler-level invariant, not just a factory
    // convention: a literal `{ cache: 'uncached' }` must not bypass it.
    expect(() =>
      assembleSystemPrompt([
        { id: 'sneaky', content: 'S', cache: 'uncached', origin: 'context' },
      ]),
    ).toThrow(/uncached but gives no reason/);
    expect(() =>
      assembleSystemPrompt([
        { id: 'sneaky', content: 'S', cache: 'uncached', origin: 'context', uncachedReason: '  ' },
      ]),
    ).toThrow(/uncached but gives no reason/);
  });

  it('allows the uncached tail and the append bus after an uncached section', () => {
    const assembled = assembleSystemPrompt([
      systemSection({ id: 'a', content: 'A', cache: 'static', origin: 'default' }),
      DANGEROUS_uncachedSystemSection('live', 'L', 'context', 'per-turn value'),
      DANGEROUS_uncachedSystemSection('live2', 'L2', 'context', 'also per-turn'),
      systemSection({ id: 'append:note', content: 'N', cache: 'dynamic', origin: 'append' }),
    ]);
    // No blank lines are inserted between non-append sections; the append bus
    // normalizes the preceding tail to exactly one blank line.
    expect(assembled.prompt).toBe('ALL2\n\nN');
  });
});

describe('changedSectionIds', () => {
  function assemblePair(): { previous: ReturnType<typeof assembleSystemPrompt>; next: ReturnType<typeof assembleSystemPrompt> } {
    const previous = assembleSystemPrompt([
      systemSection({ id: 'keep', content: 'same', cache: 'static', origin: 'default' }),
      systemSection({ id: 'move', content: 'before', cache: 'dynamic', origin: 'context' }),
      systemSection({ id: 'drop', content: 'gone', cache: 'dynamic', origin: 'context' }),
    ]);
    const next = assembleSystemPrompt([
      systemSection({ id: 'keep', content: 'same', cache: 'static', origin: 'default' }),
      systemSection({ id: 'move', content: 'after', cache: 'dynamic', origin: 'context' }),
      systemSection({ id: 'add', content: 'new', cache: 'dynamic', origin: 'context' }),
    ]);
    return { previous, next };
  }

  it('names hash-moved, added, and removed sections', () => {
    const { previous, next } = assemblePair();
    expect(changedSectionIds(previous, next)).toEqual(['move', 'add', 'drop']);
  });

  it('returns empty for section-identical assemblies', () => {
    const { previous } = assemblePair();
    expect(changedSectionIds(previous, previous)).toEqual([]);
  });

  it('attributes a memory-only change to the memory section and nothing else', () => {
    const render = (memory: string) =>
      assembleSystemPrompt(
        segmentProfileSystemPrompt(
          DEFAULT_AGENT_PROFILES['agent']!.systemPrompt({ ...FULL_CONTEXT, memory }),
        ),
      );
    // Unchanged memory must not churn: a re-render reproduces the prompt
    // byte-for-byte and no section hash moves.
    const first = render('MEM_BODY_A');
    const refresh = render('MEM_BODY_A');
    expect(refresh.prompt).toBe(first.prompt);
    expect(changedSectionIds(first, refresh)).toEqual([]);

    const moved = render('MEM_BODY_B');
    expect(changedSectionIds(first, moved)).toEqual(['memory']);
  });
});
