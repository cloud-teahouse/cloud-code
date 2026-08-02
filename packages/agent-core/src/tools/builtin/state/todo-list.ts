/**
 * TodoListTool — structured TODO list management tool.
 *
 * The LLM uses this tool to maintain a visible plan of sub-tasks during
 * plan-mode workflows and multi-step operations. A single tool serves
 * both reads and writes:
 *
 *   - `resolveExecution({ todos: [...] })` — replace the full list
 *   - `resolveExecution({ todos: [] })`    — clear the list
 *   - `resolveExecution({})`               — query current list (no mutation)
 *
 * Storage: todos live in the agent-level tool store. Writes go through
 * `tools.update_store`, so the store update is visible on wire replay.
 *
 * Items optionally carry structured fields beyond title/status: an `id`
 * other items can reference in `blockedBy`/`blocks`, an `activeForm`
 * phrase for the UI while in progress, an `owner`, and free-form
 * `metadata`. A write that sets a still-blocked todo to in_progress is
 * rejected; state migrations (a todo appears, a todo reaches done) fire
 * the TaskCreated / TaskCompleted session hooks when a hook engine is
 * attached.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './todo-list.md?raw';

// ── TODO state shape ─────────────────────────────────────────────────

export const TODO_LIST_TOOL_NAME = 'TodoList' as const;
export const TODO_STORE_KEY = 'todo';
const TODO_LIST_WRITE_REMINDER =
  'Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly id?: string;
  readonly title: string;
  readonly status: TodoStatus;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly blockedBy?: readonly string[];
  readonly blocks?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Minimal slice of the session HookEngine the tool needs. Structurally
 * satisfied by `HookEngine`; kept narrow so the tool stays testable and
 * free of a session-level import cycle.
 */
export interface TodoTaskHookEmitter {
  fireAndForgetTrigger(
    event: string,
    args: {
      matcherValue?: string;
      inputData?: Record<string, unknown>;
    },
  ): unknown;
}

declare module '../../store' {
  interface ToolStoreData {
    todo: readonly TodoItem[];
  }
}

// ── Schema ───────────────────────────────────────────────────────────

const TodoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable identifier for the todo. Other todos reference it in blockedBy/blocks. Todos without an id are referenced by title.',
    ),
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
  activeForm: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Present continuous form shown in the UI while the todo is in_progress (e.g., "Running tests").',
    ),
  owner: z
    .string()
    .min(1)
    .optional()
    .describe('Who owns the todo right now (e.g., a subagent name). Informational only.'),
  blockedBy: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Ids of todos that must be done before this one can start. A todo with unresolved blockers cannot be set to in_progress.',
    ),
  blocks: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Ids of todos this todo blocks. Advisory mirror of blockedBy; only blockedBy gates starting.',
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arbitrary key-value metadata to attach to the todo.'),
});

export interface TodoListInput {
  todos?: TodoItem[];
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});

// ── Dependency semantics ─────────────────────────────────────────────

/** Identity used for dependency references and hook diffing. */
function todoKey(todo: TodoItem): string {
  return todo.id ?? todo.title;
}

/**
 * Validate the dependency gate for a write: a todo listed as in_progress
 * must not have blockers that are still unresolved (present in the list
 * and not done). References to absent todos are ignored — a removed or
 * never-created blocker does not gate. Returns the error message for the
 * first violation, or undefined when the write is legal.
 */
function findBlockedStart(todos: readonly TodoItem[]): string | undefined {
  const byKey = new Map<string, TodoItem>();
  for (const todo of todos) {
    byKey.set(todoKey(todo), todo);
  }
  for (const todo of todos) {
    if (todo.status !== 'in_progress') continue;
    const unresolved = (todo.blockedBy ?? []).filter((ref) => {
      const blocker = byKey.get(ref);
      return blocker !== undefined && blocker.status !== 'done';
    });
    if (unresolved.length > 0) {
      const blockers = unresolved.map((ref) => `"${ref}"`).join(', ');
      return (
        `Todo "${todoKey(todo)}" cannot be set to in_progress: blocked by ${blockers}. ` +
        'Mark the blocking todos done first, or remove the dependency if it no longer applies.'
      );
    }
  }
  return undefined;
}

// ── Implementation ───────────────────────────────────────────────────

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    return `  ${marker} ${t.title}`;
  });
  return [title, ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class TodoListTool implements BuiltinTool<TodoListInput> {
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(
    private readonly store: ToolStore,
    private readonly hooks?: TodoTaskHookEmitter,
  ) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description =
      args.todos === undefined
        ? 'Reading todo list'
        : args.todos.length === 0
          ? 'Clearing todo list'
          : 'Updating todo list';
    return {
      description,
      display: {
        kind: 'todo_list',
        items: (args.todos ?? this.getTodos()).map((todo) => ({
          title: todo.title,
          status: todo.status,
        })),
      },
      approvalRule: this.name,
      execute: async () => {
        // Query mode — return the current list without mutation.
        if (args.todos === undefined) {
          const current = this.getTodos();
          return { isError: false, output: renderTodoList(current) };
        }

        // Dependency gate — reject the write before any state changes.
        const blockedError = findBlockedStart(args.todos);
        if (blockedError !== undefined) {
          return { isError: true, output: blockedError };
        }

        // Write mode — replace the full list and return the new state.
        const previous = this.getTodos();
        this.setTodos(args.todos);
        const stored = this.getTodos();
        this.emitTaskHooks(previous, stored);
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER}`;
        return { isError: false, output };
      },
    };
  }

  /**
   * Diff a committed write against the previous list and fire task
   * lifecycle hooks: TaskCreated for todos that were not in the list
   * before, TaskCompleted for todos that newly reached done. Items are
   * matched by id (falling back to title). Fire-and-forget: hook
   * outcomes never affect the write result.
   */
  private emitTaskHooks(previous: readonly TodoItem[], current: readonly TodoItem[]): void {
    const hooks = this.hooks;
    if (hooks === undefined) return;
    const previousByKey = new Map(previous.map((todo) => [todoKey(todo), todo]));
    try {
      for (const todo of current) {
        const key = todoKey(todo);
        const before = previousByKey.get(key);
        if (before === undefined) {
          hooks.fireAndForgetTrigger('TaskCreated', {
            matcherValue: key,
            inputData: taskHookInput(todo),
          });
        } else if (before.status !== 'done' && todo.status === 'done') {
          hooks.fireAndForgetTrigger('TaskCompleted', {
            matcherValue: key,
            inputData: taskHookInput(todo),
          });
        }
      }
    } catch {
      // Hook emission must never fail a todo write.
    }
  }

  private getTodos(): readonly TodoItem[] {
    const todos = this.store.get(TODO_STORE_KEY);
    return todos ?? [];
  }

  private setTodos(todos: readonly TodoItem[]): void {
    this.store.set(TODO_STORE_KEY, todos.map(normalizeTodoItem));
  }
}

function taskHookInput(todo: TodoItem): Record<string, unknown> {
  return {
    taskId: todoKey(todo),
    taskTitle: todo.title,
    taskStatus: todo.status,
    ...(todo.owner !== undefined ? { taskOwner: todo.owner } : {}),
  };
}

/** Defensive copy for the store: drops absent optional fields entirely. */
function normalizeTodoItem(todo: TodoItem): TodoItem {
  return {
    ...(todo.id !== undefined ? { id: todo.id } : {}),
    title: todo.title,
    status: todo.status,
    ...(todo.activeForm !== undefined ? { activeForm: todo.activeForm } : {}),
    ...(todo.owner !== undefined ? { owner: todo.owner } : {}),
    ...(todo.blockedBy !== undefined ? { blockedBy: [...todo.blockedBy] } : {}),
    ...(todo.blocks !== undefined ? { blocks: [...todo.blocks] } : {}),
    ...(todo.metadata !== undefined ? { metadata: { ...todo.metadata } } : {}),
  };
}
