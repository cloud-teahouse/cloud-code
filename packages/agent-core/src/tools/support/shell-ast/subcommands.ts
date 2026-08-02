/**
 * tree-sitter-bash AST traversal helpers, ported from opencode
 * (`packages/opencode/src/tool/shell.ts` `parts` / `source` / `commands`).
 *
 * A `command` node exists for every simple command in the input, including
 * those nested inside `&&`/`||`/`;`/`|` chains, subshells and command
 * substitutions (`$(...)` / backticks) — `descendantsOfType('command')`
 * recurses into all of them, which is what makes adversarial nesting
 * (`git push $(rm -rf ~)`) visible to per-segment permission checks.
 */

import type { Node } from 'web-tree-sitter';

export interface CommandPart {
  readonly type: string;
  readonly text: string;
}

export interface PartsOptions {
  /**
   * Also collect `number` nodes. tree-sitter-bash types bare numeric
   * arguments as `number`, not `word` (`timeout 10 ls` → [timeout, ls]
   * without them). Wrapper stripping needs the numbers to validate
   * wrapper arguments (the `timeout` DURATION, `nice -n N`); the segments
   * data plane keeps the legacy word/string-only view.
   */
  readonly includeNumbers?: boolean;
  /**
   * Also collect `command_substitution` nodes as single tokens (text like
   * `$(whoami)`). Wrapper stripping needs them so a substituted flag
   * value (`sudo -u $(whoami) rm x`) stays visible and fails the
   * flag-value allowlist instead of letting the flag consume the next
   * token as its value.
   */
  readonly includeSubstitutions?: boolean;
}

/**
 * Tokens of a single command node: the command name plus its word/string
 * arguments. Variable assignments (`FOO=1 cmd`), redirections and command
 * substitutions are NOT tokens, so the arity prefix is computed from the
 * words a human would read as "the command".
 */
export function parts(node: Node, options?: PartsOptions): CommandPart[] {
  const out: CommandPart[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'command_elements') {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j);
        if (!item || item.type === 'command_argument_sep' || item.type === 'redirection') continue;
        out.push({ type: item.type, text: item.text });
      }
      continue;
    }
    if (
      child.type !== 'command_name' &&
      child.type !== 'command_name_expr' &&
      child.type !== 'word' &&
      child.type !== 'string' &&
      child.type !== 'raw_string' &&
      child.type !== 'concatenation' &&
      (child.type !== 'number' || options?.includeNumbers !== true) &&
      (child.type !== 'command_substitution' || options?.includeSubstitutions !== true)
    ) {
      continue;
    }
    out.push({ type: child.type, text: child.text });
  }
  return out;
}

/**
 * Source text for a command node. When the command is wrapped in a
 * `redirected_statement` the parent's text is used, so the subject keeps
 * the `> file` suffix while {@link parts} stays redirect-free.
 */
export function source(node: Node): string {
  return (node.parent?.type === 'redirected_statement' ? node.parent.text : node.text).trim();
}

/** All `command` descendants of `root`, in document order (outer first). */
export function commandNodes(root: Node): Node[] {
  const out: Node[] = [];
  for (const node of root.descendantsOfType('command')) {
    if (node !== null) out.push(node);
  }
  return out;
}
