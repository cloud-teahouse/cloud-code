import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  parseSelectToolsQuery,
  searchToolCandidates,
  SelectToolsTool,
  type SelectToolsInput,
  type ToolSearchCandidate,
} from '../../src/tools/builtin/select-tools';
import { executeTool } from './fixtures/execute-tool';

describe('parseSelectToolsQuery', () => {
  it('parses the select: exact-name form', () => {
    expect(parseSelectToolsQuery('select:Read,Edit, Grep')).toEqual({
      kind: 'select',
      names: ['Read', 'Edit', 'Grep'],
    });
    expect(parseSelectToolsQuery('select:')).toEqual({ kind: 'select', names: [] });
  });

  it('splits bare keywords and +required terms, lowercased', () => {
    expect(parseSelectToolsQuery('+Slack send Message')).toEqual({
      kind: 'search',
      required: ['slack'],
      terms: ['send', 'message'],
    });
    expect(parseSelectToolsQuery('notebook jupyter')).toEqual({
      kind: 'search',
      required: [],
      terms: ['notebook', 'jupyter'],
    });
    // A lone "+" is a bare term, not a required marker.
    expect(parseSelectToolsQuery('+')).toEqual({ kind: 'search', required: [], terms: ['+'] });
  });
});

describe('searchToolCandidates', () => {
  const pool: readonly ToolSearchCandidate[] = [
    { name: 'mcp__slack__send_message', description: 'Send a Slack message to a channel' },
    { name: 'mcp__slack__list_channels', description: 'List workspace channels' },
    { name: 'mcp__github__create_issue', description: 'Create an issue; message the team' },
    { name: 'mcp__jira__create_ticket', description: 'File a Jira ticket' },
  ];

  it('requires +terms in the tool name and ranks name hits above description hits', () => {
    const matches = searchToolCandidates(pool, { required: ['slack'], terms: ['send'] }, 5);
    // create_issue mentions "send"... no — its description says "message the
    // team"; only slack tools pass the required filter, and send_message
    // scores on the name.
    expect(matches.map((m) => m.name)).toEqual(['mcp__slack__send_message']);
  });

  it('ranks by score with name-hits first, ties broken by name', () => {
    const matches = searchToolCandidates(pool, { required: [], terms: ['message'] }, 5);
    // send_message: name hit (2). create_issue: description hit (1).
    expect(matches.map((m) => m.name)).toEqual([
      'mcp__slack__send_message',
      'mcp__github__create_issue',
    ]);
  });

  it('drops zero-score candidates and caps the result count', () => {
    const matches = searchToolCandidates(pool, { required: [], terms: ['create'] }, 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe('mcp__github__create_issue');
  });

  it('with only +terms, returns every passing tool sorted by name', () => {
    const matches = searchToolCandidates(pool, { required: ['create'], terms: [] }, 5);
    expect(matches.map((m) => m.name)).toEqual([
      'mcp__github__create_issue',
      'mcp__jira__create_ticket',
    ]);
  });

  it('matches case-insensitively', () => {
    const matches = searchToolCandidates(pool, { required: [], terms: ['SLACK'] }, 5);
    expect(matches).toHaveLength(2);
  });
});

interface StubToolManager {
  readonly loadable: readonly string[];
  readonly loaded: ReadonlySet<string>;
  readonly descriptions: Readonly<Record<string, string>>;
}

function selectToolsAgent(manager: StubToolManager): {
  agent: Agent;
  appended: Array<{ readonly tools?: readonly { readonly name: string }[] }>;
  marked: string[];
} {
  const appended: Array<{ readonly tools?: readonly { readonly name: string }[] }> = [];
  const marked: string[] = [];
  const agent = {
    toolSelectEnabled: true,
    tools: {
      loadableDynamicToolNames: () => [...manager.loadable].toSorted((a, b) => a.localeCompare(b)),
      loadedDynamicToolNames: () => manager.loaded,
      getDynamicToolSchema: (name: string) =>
        manager.descriptions[name] === undefined
          ? undefined
          : {
              name,
              description: manager.descriptions[name],
              parameters: { type: 'object' },
            },
      markDynamicToolsLoaded: (names: Iterable<string>) => {
        marked.push(...names);
      },
    },
    context: {
      appendMessage: (message: { readonly tools?: readonly { readonly name: string }[] }) => {
        appended.push(message);
      },
    },
  } as unknown as Agent;
  return { agent, appended, marked };
}

const MANAGER: StubToolManager = {
  loadable: ['mcp__slack__send_message', 'mcp__slack__list_channels', 'mcp__github__create_issue'],
  loaded: new Set<string>(),
  descriptions: {
    mcp__slack__send_message: 'Send a Slack message to a channel',
    mcp__slack__list_channels: 'List workspace channels',
    mcp__github__create_issue: 'Create an issue on GitHub',
  },
};

async function runSelect(
  agent: Agent,
  args: SelectToolsInput,
): Promise<{ readonly output: unknown; readonly isError?: boolean }> {
  return executeTool(new SelectToolsTool(agent), {
    turnId: '1',
    toolCallId: 'call-1',
    args,
    signal: new AbortController().signal,
  });
}

describe('SelectToolsTool query execution', () => {
  it('loads exact names from the select: query form', async () => {
    const { agent, appended } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, { query: 'select:mcp__github__create_issue' });

    expect(result.isError).toBeUndefined();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.tools?.map((t) => t.name)).toEqual(['mcp__github__create_issue']);
  });

  it('keyword search loads the best matches and reports them', async () => {
    const { agent, appended, marked } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, { query: '+slack send' });

    expect(result.isError).toBeUndefined();
    expect(appended[0]!.tools?.map((t) => t.name)).toEqual(['mcp__slack__send_message']);
    expect(marked).toEqual(['mcp__slack__send_message']);
    expect(String(result.output)).toContain('Matched: mcp__slack__send_message');
    expect(String(result.output)).toContain('Loaded: mcp__slack__send_message');
  });

  it('reports already-loaded matches as available without re-injecting', async () => {
    const { agent, appended } = selectToolsAgent({
      ...MANAGER,
      loaded: new Set(['mcp__slack__send_message']),
    });
    // "send" matches only the already-loaded tool, so nothing re-injects.
    const result = await runSelect(agent, { query: 'send' });

    expect(result.isError).toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(String(result.output)).toContain('Already available: mcp__slack__send_message');
  });

  it('errors with guidance when the query matches nothing', async () => {
    const { agent } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, { query: 'nonexistent-xyz' });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('No tools matched');
  });

  it('errors when neither names nor query are given', async () => {
    const { agent } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, {});

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('Nothing to load');
  });

  it('honors maxResults for keyword search', async () => {
    const { agent, appended } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, { query: 'slack', maxResults: 1 });

    expect(result.isError).toBeUndefined();
    expect(appended[0]!.tools).toHaveLength(1);
  });

  it('names and query union, keeping per-name unknown reporting', async () => {
    const { agent, appended } = selectToolsAgent(MANAGER);
    const result = await runSelect(agent, {
      names: ['bogus_tool'],
      query: 'select:mcp__github__create_issue',
    });

    expect(result.isError).toBeUndefined();
    expect(appended[0]!.tools?.map((t) => t.name)).toEqual(['mcp__github__create_issue']);
    expect(String(result.output)).toContain('Unknown tool: bogus_tool');
  });
});
