import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';
import {
  ADDITIONAL_DIRS_SECTION_PROSE,
  SKILLS_SECTION_PROSE,
  WINDOWS_NOTES,
} from '../../src/profile/prompt-sections';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('You are Cloud Code CLI');
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('/workspace');
  });

  it('keeps static instructions before dynamic prompt context', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt.indexOf('Use this as your basic understanding of the project structure.')).toBeLessThan(
      prompt.indexOf('LISTING_SNAPSHOT'),
    );
    expect(prompt.indexOf('User instructions given directly in the conversation')).toBeLessThan(
      prompt.indexOf('AGENTS_MD_BODY'),
    );
    expect(prompt.indexOf('Only read skill details when needed')).toBeLessThan(
      prompt.indexOf('- test-skill: does things'),
    );
  });

  it('renders the environment prose sections from the shared prompt-sections source', () => {
    // system.md must render the shared constants (never re-inlined copies), so
    // the builtin default prompt and the agent-file renderer cannot drift.
    const prompt =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({
        ...promptContext,
        osEnv: { ...promptContext.osEnv, osKind: 'Windows' },
        additionalDirsInfo: 'EXTRA_DIR_1',
      }) ?? '';
    expect(prompt).toContain(WINDOWS_NOTES);
    expect(prompt).toContain(ADDITIONAL_DIRS_SECTION_PROSE);
    expect(prompt).toContain(SKILLS_SECTION_PROSE);
  });

  it('lists the goal tools on the agent profile but not on subagent profiles', () => {
    const agentTools = DEFAULT_AGENT_PROFILES['agent']?.tools ?? [];
    expect(agentTools).toEqual(
      expect.arrayContaining(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']),
    );
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
      expect(tools).not.toContain('SetGoalBudget');
      expect(tools).not.toContain('UpdateGoal');
    }
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('renders the Memory section only for profiles with the SaveMemory tool', () => {
    const memory = '## Project memory — `/workspace/.cloud-code/memory/MEMORY.md`\n\n- [proj](proj.md)';
    // The root agent and coder can save memories, so the section and the
    // injected index render in their prompts.
    for (const name of ['agent', 'coder']) {
      expect(DEFAULT_AGENT_PROFILES[name]?.tools).toContain('SaveMemory');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt({ ...promptContext, memory }) ?? '';
      expect(prompt).toContain('# Memory');
      expect(prompt).toContain('- [proj](proj.md)');
    }

    // explore/plan lack the SaveMemory tool, so neither the section heading
    // nor the memory index should appear in their prompts.
    for (const name of ['explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('SaveMemory');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt({ ...promptContext, memory }) ?? '';
      expect(prompt).not.toContain('# Memory');
      expect(prompt).not.toContain('- [proj](proj.md)');
    }
  });

  it('elides the Memory section entirely when no memory exists', () => {
    // promptContext carries no memory — the template gate must produce zero
    // prompt delta for agents without memory dirs.
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).not.toContain('# Memory');
  });

  it('omits the Skills section only for profiles that lack the Skill tool', () => {
    // The root agent and coder have the Skill tool, so the Skills section and
    // listing render in their prompts.
    for (const name of ['agent', 'coder']) {
      expect(DEFAULT_AGENT_PROFILES[name]?.tools).toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('# Skills');
      expect(prompt).toContain('- test-skill: does things');
    }

    // explore/plan lack the Skill tool, so neither the section heading nor the
    // skill listing should appear in their prompts.
    for (const name of ['explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('renders the Plugin Instructions section only when plugin sections exist', () => {
    const pluginSections = '<!-- From: plugin demo -->\nAlways cite sources.';
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt =
        DEFAULT_AGENT_PROFILES[name]?.systemPrompt({ ...promptContext, pluginSections }) ?? '';
      expect(prompt).toContain('# Plugin Instructions');
      expect(prompt).toContain('<!-- From: plugin demo -->');
      expect(prompt).toContain('Always cite sources.');
    }

    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).not.toContain('# Plugin Instructions');
  });

  it('keeps optional-tool guidance out of the shared system prompt entirely', () => {
    // Tool-coupled guidance now lives in each tool's own description, which the schema
    // layer ships ONLY when the tool is registered — that is the availability gate, for
    // free. So the shared system.md must not name optional tools at all (no per-tool
    // {% if %} reconstruction of availability). This holds for the root `agent` too, not
    // just subagents. The cross-tool secret-file guard — built on the always-present
    // Read/Grep/Glob — stays shared.
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Launch multiple explore agents concurrently'); // Agent → agent.md + explore whenToUse
      expect(prompt).not.toContain('long-running shell commands as background tasks'); // background → bash.md
      expect(prompt).not.toContain('maintain a `TodoList`'); // TodoList → todo-list.md
      expect(prompt).not.toContain('prefer entering plan mode first'); // EnterPlanMode → enter-plan-mode.md
      expect(prompt).not.toContain('call `TaskList` to re-enumerate'); // compaction recovery → task-list.md
      // The dedicated-tool routing must name only universally-present tools (Read/Glob/Grep).
      // Write/Edit/Bash are absent from read-only profiles (plan has no Bash/Write/Edit;
      // explore no Write/Edit), so naming them in the shared routing sentence would dangle —
      // that routing lives in bash.md (echo>file→Write, sed→Edit, etc.), which ships with Bash.
      expect(prompt).not.toContain('`Write` / `Edit` to change files');
      expect(prompt).not.toContain('Keep `Bash` for genuine shell work');
      expect(prompt).toContain('`Glob` to find files by name'); // universal routing stays
      expect(prompt).toContain('refuse a fixed set of well-known secret files'); // shared guard stays
    }
  });

  it('renders blast-radius and concrete-example guidance for root and subagents alike', () => {
    // These additions live in shared, ungated sections, so the root agent AND every
    // subagent that renders the coding guidelines must carry them verbatim.
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      // Reversibility / blast-radius principle generalized beyond the git rule.
      expect(prompt).toContain('reversibility and blast radius');
      expect(prompt).toContain('A one-time approval covers that one action');
      // The "do local work freely" clause is role-scoped: read-only subagents (explore/plan)
      // render this same paragraph, so it must not tell them editing files is free.
      expect(prompt).toContain('Local, reversible work your role permits');
      // Concrete one-line examples anchoring high-frequency abstract rules.
      expect(prompt).toContain('locate the method in the code'); // ambiguous instruction -> edit code, not echo text
      expect(prompt).toContain('update the related tests'); // preamble phrasing example
      expect(prompt).toContain('premature abstraction'); // MINIMAL-changes counterexample
    }
  });

  it('renders the subagent delegation discipline for root and subagents alike', () => {
    // Shared static section (delegation-restraint + writing-subagent-prompts port):
    // spawn-restraint tests first, then briefing discipline. Phrased tool-agnostic —
    // "subagents", never the Agent/AgentSwarm tool names — so it can render on
    // profiles that have no subagent tools without dangling a tool reference.
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('# Delegating to subagents');
      // Restraint: small bounded work stays inline; delegated work is not redone.
      expect(prompt).toContain('in a handful of tool calls');
      expect(prompt).toContain('do not redo the subagent');
      expect(prompt).toContain('Verification that fits in your own loop');
      // Briefing: the colleague metaphor and the no-delegated-understanding bar.
      expect(prompt).toContain('smart colleague who just walked into the room');
      expect(prompt).toContain('Never delegate understanding');
      expect(prompt).toContain('file paths, line numbers, and what specifically to change');
      // The old one-liner moved into this section — it must not also linger in
      // the Prompt and Tool Use section above it.
      expect(prompt.indexOf('For simple, directed codebase searches')).toBeGreaterThan(
        prompt.indexOf('# Delegating to subagents'),
      );
    }
  });

  it('stays brand-neutral across every bundled profile prompt', () => {
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Kimi Code');
    }
  });

  it('renders the Git Status section only when a snapshot is provided', () => {
    const gitStatus = [
      'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
      'Current branch: feature-x',
      'Main branch (you will usually use this for PRs): main',
      'Status:\n(clean)',
    ].join('\n\n');

    const withGit =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, gitStatus }) ?? '';
    expect(withGit).toContain('## Git Status');
    expect(withGit).toContain('Current branch: feature-x');
    expect(withGit).toContain('will not update during the conversation');
    // The section sits with the working-environment context, before Project Information.
    expect(withGit.indexOf('## Git Status')).toBeLessThan(withGit.indexOf('# Project Information'));

    const withoutGit = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(withoutGit).not.toContain('## Git Status');
  });

  it('renders the MCP Server Instructions section only when instructions are provided', () => {
    const mcpInstructions = '## github\nUse the GitHub tools for PRs.';

    const withMcp =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, mcpInstructions }) ?? '';
    expect(withMcp).toContain('# MCP Server Instructions');
    expect(withMcp).toContain(
      'The following MCP servers have provided instructions for how to use their tools and resources:',
    );
    expect(withMcp).toContain(mcpInstructions);

    const withoutMcp = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(withoutMcp).not.toContain('# MCP Server Instructions');
  });

  it('tells coder and explore subagents that Bash cwd resets and to cite absolute paths', () => {
    for (const name of ['coder', 'explore']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('working directory resets between Bash calls');
      expect(prompt).toContain('absolute paths');
    }
  });

  it('omits the injected AGENTS.md block for explore/plan but keeps it for agent/coder', () => {
    // omitAgentsMd drops the merged AGENTS.md content (the parent agent holds
    // the full context), but the generic "consult subdirectory AGENTS.md"
    // guidance and the section heading stay.
    for (const name of ['explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('AGENTS_MD_BODY');
      expect(prompt).not.toContain('The applicable `AGENTS.md` instructions are:');
      expect(prompt).not.toContain('not a privileged instruction channel');
      expect(prompt).toContain('# Project Information');
      expect(prompt).toContain('check whether those directories contain their own `AGENTS.md`');
    }
    for (const name of ['agent', 'coder']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('AGENTS_MD_BODY');
      expect(prompt).toContain('The applicable `AGENTS.md` instructions are:');
    }
  });

  it('arms explore with an explicit read-only prohibition list', () => {
    const prompt = DEFAULT_AGENT_PROFILES['explore']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('READ-ONLY MODE - NO FILE MODIFICATIONS');
    expect(prompt).toContain('STRICTLY PROHIBITED');
    expect(prompt).toContain('no mv or cp');
    expect(prompt).toContain('Creating temporary files anywhere, including /tmp');
    expect(prompt).toContain('redirect operators (>, >>, |) or heredocs');
    expect(prompt).toContain('attempting to edit files will fail');
  });

  it('requires plan to end its final message with a Critical Files list', () => {
    const prompt = DEFAULT_AGENT_PROFILES['plan']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('### Critical Files for Implementation');
    expect(prompt).toContain('3-5 files most critical for implementing this plan');
  });

  it('bans a colon before tool calls', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('Do not use a colon before tool calls');
  });
});
