/**
 * Covers the current TodoListTool contract.
 *
 * The todo state now lives in the agent tool store. The tool returns a
 * user-readable string in `output` and persists structured todos through
 * the injected store.
 */

import { describe, expect, it } from 'vitest';

import { HookDefSchema } from '../../src/config/schema';
import { HookEngine } from '../../src/session/hooks';
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  TodoListInputSchema,
  TodoListTool,
  type TodoItem,
  type TodoTaskHookEmitter,
} from '../../src/tools/builtin/state/todo-list';
import type { ToolStore } from '../../src/tools/store';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeStore(initial: readonly TodoItem[] = []): {
  store: ToolStore;
  getTodos(): readonly TodoItem[];
} {
  let todos = [...initial];
  return {
    store: {
      get: (key) => (key === TODO_STORE_KEY ? todos : undefined),
      set: (key, value) => {
        if (key === TODO_STORE_KEY) {
          todos = [...(value as readonly TodoItem[])];
        }
      },
    },
    getTodos: () => todos,
  };
}

function makeTool(
  initial: readonly TodoItem[] = [],
  hooks?: TodoTaskHookEmitter,
): {
  tool: TodoListTool;
  getTodos(): readonly TodoItem[];
} {
  const { store, getTodos } = makeStore(initial);
  return { tool: new TodoListTool(store, hooks), getTodos };
}

interface RecordedHookCall {
  readonly event: string;
  readonly matcherValue?: string;
  readonly inputData?: Record<string, unknown>;
}

function makeHookRecorder(): {
  emitter: TodoTaskHookEmitter;
  calls: RecordedHookCall[];
} {
  const calls: RecordedHookCall[] = [];
  return {
    calls,
    emitter: {
      fireAndForgetTrigger(event, args) {
        calls.push({ event, matcherValue: args.matcherValue, inputData: args.inputData });
      },
    },
  };
}

describe('TodoListTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { tool } = makeTool();

    expect(TODO_LIST_TOOL_NAME).toBe('TodoList');
    expect(TODO_STORE_KEY).toBe('todo');
    expect(tool.name).toBe(TODO_LIST_TOOL_NAME);
    expect(tool.description.length).toBeGreaterThan(0);
    // Plan-mode planning goes to the plan file, not the TodoList — the description
    // must not present TodoList as the plan-mode mechanism.
    expect(tool.description).toContain('plan file');
    // Query mode triggers on `args.todos === undefined`, not on zero args.
    expect(tool.description).toContain('no `todos` argument');
    expect(TodoListInputSchema.safeParse({}).success).toBe(true);
    expect(
      TodoListInputSchema.safeParse({ todos: [{ title: 'x', status: 'wip' }] }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        todos: { type: 'array' },
      },
    });
  });

  it('description includes an Avoid churn section with the anti-spin guardrails', () => {
    const { tool } = makeTool();
    const { description } = tool;

    expect(description).toContain('**Avoid churn:**');
    // (1) do not re-call the tool when nothing meaningful changed between calls.
    expect(description).toMatch(/nothing meaningful has changed/i);
    expect(description).toMatch(/real progress/i);
    // (2) when unsure of the current state, use query mode first.
    expect(description).toMatch(/query mode/i);
    // (3) when stuck, tell the user instead of repeatedly re-ordering todos.
    expect(description).toMatch(/tell the user/i);
  });

  it('description teaches the use vs not-use boundary with paired examples and reasoning', () => {
    const { description } = makeTool().tool;

    // Behavioral tool descriptions carry the example-plus-reasoning structure
    // (TodoWrite port): paired positive/negative <example> blocks, each with a
    // <reasoning> explaining the discrimination — not bare category lists.
    expect(description).toContain('**Examples of when to use the todo list:**');
    expect(description).toContain('**Examples of when NOT to use the todo list:**');
    expect(description).toContain('<example>');
    expect(description).toContain('<reasoning>');
    // Discipline clauses: single in_progress, no batched completions, done means done.
    expect(description).toContain('keep exactly one task `in_progress`');
    expect(description).toContain('do not batch completions');
    expect(description).toContain('Never mark a task `done` if tests are failing');
    expect(description).not.toContain('Kimi Code');
  });

  it('description encourages proactive progress updates without allowing churn', () => {
    const { tool } = makeTool();
    const { description } = tool;

    expect(description).toMatch(/proactively and often/i);
    expect(description).toMatch(/immediately after finishing/i);
    expect(description).toMatch(/exactly one/i);
    expect(description).toMatch(/in_progress/i);
    expect(description).toMatch(/tests are failing/i);
    expect(description).toContain('**Avoid churn:**');
  });

  it('query mode renders the current list without mutating it', async () => {
    const { tool, getTodos } = makeTool([{ title: 'existing', status: 'in_progress' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Current todo list');
    expect(result.output).toContain('[in_progress] existing');
    expect(getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
  });

  it('exposes the visible todo items in the tool-call display', () => {
    const { tool } = makeTool([{ title: 'existing', status: 'in_progress' }]);

    const execution = tool.resolveExecution({});

    if (execution.isError === true) throw new TypeError('expected runnable execution');
    expect(execution.display).toEqual({
      kind: 'todo_list',
      items: [{ title: 'existing', status: 'in_progress' }],
    });
  });

  it('write mode replaces the list and defensively copies todos into the store', async () => {
    const { tool, getTodos } = makeTool();
    const todos: TodoItem[] = [
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ];

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos },
      signal,
    });
    todos[0] = { title: 'leaked', status: 'done' };

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Todo list updated');
    expect(result.output).toContain('[pending] first');
    expect(result.output).toContain('[in_progress] second');
    expect(result.output).toContain(
      'Ensure that you continue to use the todo list to track progress.',
    );
    expect(result.output).toContain('exactly one task in_progress');
    expect(getTodos()).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);
  });

  it('renders a done todo with a marker matching the status enum value', async () => {
    const { tool } = makeTool([{ title: 'shipped', status: 'done' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('[done] shipped');
    expect(result.output).not.toContain('[completed]');
  });

  it('clear mode empties the list', async () => {
    const { tool, getTodos } = makeTool([{ title: 'x', status: 'pending' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [] },
      signal,
    });

    expect(result).toMatchObject({ isError: false, output: 'Todo list cleared.' });
    expect(getTodos()).toEqual([]);
  });

  it('clear mode does not add the progress-tracking reminder', async () => {
    const { tool } = makeTool([{ title: 'x', status: 'pending' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [] },
      signal,
    });

    expect(result).toMatchObject({ isError: false, output: 'Todo list cleared.' });
  });

  it('resolveExecution description reflects the mode', () => {
    const { tool } = makeTool();
    const readExecution = tool.resolveExecution({});
    const clearExecution = tool.resolveExecution({ todos: [] });
    const updateExecution = tool.resolveExecution({ todos: [{ title: 'x', status: 'pending' }] });

    expect(readExecution.isError).toBeFalsy();
    expect(clearExecution.isError).toBeFalsy();
    expect(updateExecution.isError).toBeFalsy();
    if (
      readExecution.isError === true ||
      clearExecution.isError === true ||
      updateExecution.isError === true
    ) {
      throw new TypeError('expected runnable executions');
    }
    expect(readExecution.description).toBe('Reading todo list');
    expect(clearExecution.description).toBe('Clearing todo list');
    expect(updateExecution.description).toBe('Updating todo list');
  });
});


describe('structured fields', () => {
  it('round-trips id/activeForm/owner/blockedBy/blocks/metadata through the store', async () => {
    const { tool, getTodos } = makeTool();
    const todos: TodoItem[] = [
      {
        id: 'a',
        title: 'Change the schema',
        status: 'in_progress',
        activeForm: 'Changing the schema',
        owner: 'coder',
        metadata: { pr: 12, links: ['x'] },
      },
      { id: 'b', title: 'Update tests', status: 'pending', blockedBy: ['a'] },
      { id: 'c', title: 'Write docs', status: 'pending', blocks: ['b'] },
    ];

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(getTodos()).toEqual(todos);
    expect(TodoListInputSchema.safeParse({ todos }).success).toBe(true);
  });

  it('stores legacy items without adding empty optional keys', async () => {
    const { tool, getTodos } = makeTool();

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [{ title: 'x', status: 'pending' }] },
      signal,
    });

    const first = getTodos()[0];
    if (first === undefined) throw new TypeError('expected one stored todo');
    expect(Object.keys(first)).toEqual(['title', 'status']);
  });
});

describe('dependency gate', () => {
  it('rejects setting a blocked todo to in_progress and leaves the store unchanged', async () => {
    const { tool, getTodos } = makeTool([{ id: 'a', title: 'A', status: 'pending' }]);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'pending' },
          { id: 'b', title: 'B', status: 'in_progress', blockedBy: ['a'] },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('"b"');
    expect(result.output).toContain('blocked by "a"');
    expect(getTodos()).toEqual([{ id: 'a', title: 'A', status: 'pending' }]);
  });

  it('allows starting once every blocker is done', async () => {
    const { tool, getTodos } = makeTool();

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'done' },
          { id: 'b', title: 'B', status: 'in_progress', blockedBy: ['a'] },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(getTodos()[1]).toMatchObject({ id: 'b', status: 'in_progress' });
  });

  it('ignores blockers that are not in the list', async () => {
    const { tool } = makeTool();

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [{ id: 'b', title: 'B', status: 'in_progress', blockedBy: ['ghost'] }] },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
  });

  it('treats blocks as advisory: only blockedBy gates starting', async () => {
    const { tool } = makeTool();

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'pending', blocks: ['b'] },
          { id: 'b', title: 'B', status: 'in_progress' },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
  });

  it('resolves title references for todos without an id', async () => {
    const { tool } = makeTool();

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { title: 'Setup', status: 'pending' },
          { title: 'Build', status: 'in_progress', blockedBy: ['Setup'] },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('blocked by "Setup"');
  });
});

describe('task lifecycle hooks', () => {
  it('fires TaskCreated for every new item, keyed by id or title', async () => {
    const { emitter, calls } = makeHookRecorder();
    const { tool } = makeTool([], emitter);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'pending' },
          { title: 'legacy', status: 'pending' },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(calls).toEqual([
      {
        event: 'TaskCreated',
        matcherValue: 'a',
        inputData: { taskId: 'a', taskTitle: 'A', taskStatus: 'pending' },
      },
      {
        event: 'TaskCreated',
        matcherValue: 'legacy',
        inputData: { taskId: 'legacy', taskTitle: 'legacy', taskStatus: 'pending' },
      },
    ]);
  });

  it('fires TaskCompleted only for items that newly reach done', async () => {
    const { emitter, calls } = makeHookRecorder();
    const { tool } = makeTool(
      [
        { id: 'a', title: 'A', status: 'in_progress' },
        { id: 'b', title: 'B', status: 'done' },
      ],
      emitter,
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'done' },
          { id: 'b', title: 'B', status: 'done' },
          { id: 'c', title: 'C', status: 'done' },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(calls).toEqual([
      {
        event: 'TaskCompleted',
        matcherValue: 'a',
        inputData: { taskId: 'a', taskTitle: 'A', taskStatus: 'done' },
      },
      // 'b' was already done — no event. 'c' is new — TaskCreated, not TaskCompleted.
      {
        event: 'TaskCreated',
        matcherValue: 'c',
        inputData: { taskId: 'c', taskTitle: 'C', taskStatus: 'done' },
      },
    ]);
  });

  it('includes the owner in the hook payload when present', async () => {
    const { emitter, calls } = makeHookRecorder();
    const { tool } = makeTool([], emitter);

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { todos: [{ id: 'a', title: 'A', status: 'pending', owner: 'coder' }] },
      signal,
    });

    expect(calls[0]?.inputData).toMatchObject({ taskOwner: 'coder' });
  });

  it('does not fire hooks in query mode or after a rejected write', async () => {
    const { emitter, calls } = makeHookRecorder();
    const { tool } = makeTool([{ id: 'a', title: 'A', status: 'pending' }], emitter);

    const query = await executeTool(tool, { turnId: 't1', toolCallId: 'call_1', args: {}, signal });
    expect(query).toMatchObject({ isError: false });

    const rejected = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: {
        todos: [
          { id: 'a', title: 'A', status: 'pending' },
          { id: 'b', title: 'B', status: 'in_progress', blockedBy: ['a'] },
        ],
      },
      signal,
    });
    expect(rejected).toMatchObject({ isError: true });

    expect(calls).toEqual([]);
  });

  it('wires into HookEngine structurally and the config schema accepts the new events', () => {
    // Compile-time wiring check: the session HookEngine must satisfy the
    // emitter interface the tool consumes.
    const engine: TodoTaskHookEmitter = new HookEngine([]);
    expect(engine).toBeDefined();

    expect(HookDefSchema.safeParse({ event: 'TaskCreated', command: 'echo hi' }).success).toBe(
      true,
    );
    expect(HookDefSchema.safeParse({ event: 'TaskCompleted', command: 'echo hi' }).success).toBe(
      true,
    );
  });
});
