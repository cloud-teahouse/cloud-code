/**
 * Convention guard for tool detail bodies: every dim detail body under a tool
 * header renders through the shared tree gutter in the `textDim` tone — each
 * logical entry opens with `├─` (or `└─` for the last entry of the card's
 * last detail block) and its wrap continuations align on the lighter
 * continuation gutter instead of opening new branches (see
 * DETAIL_TREE_MIDDLE/DETAIL_TREE_LAST/DETAIL_TREE_CONTINUATION* in
 * tui/constant/symbols). Command cards (Bash/ExecSession tool cards and the
 * `!` shell-run card) are the one exception: they render the `$ command` /
 * `⎿ output` shape owned by shell-execution.ts, so the `⎿` mark must stay
 * confined to the command-card modules and per-renderer ad-hoc indentation
 * must not come back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MESSAGES_DIR = join(import.meta.dirname, '../../../../src/tui/components/messages');
// Command-card modules: the only places the `⎿` output mark may appear.
const COMMAND_CARD_MODULES = new Set(['shell-execution.ts', 'shell-run.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('tool detail tree convention', () => {
  it('only command-card modules use the ⎿ output mark', () => {
    const files = sourceFiles(MESSAGES_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (COMMAND_CARD_MODULES.has(file.slice(MESSAGES_DIR.length + 1))) {
        expect(content, file).toContain('COMMAND_OUTPUT_MARK');
      } else {
        expect(content, file).not.toContain('⎿');
      }
    }
  });

  it('non-command tool detail bodies render through the shared tree gutter', () => {
    const content = readFileSync(join(MESSAGES_DIR, 'tool-call.ts'), 'utf8');
    expect(content).toContain('DETAIL_TREE_MIDDLE');
    expect(content).toContain('DETAIL_TREE_LAST');
  });

  it('the tree gutter renders in the textDim tone', () => {
    const expectations: Record<string, RegExp> = {
      'tool-call.ts': /fg\('textDim', gutter\)/,
      // Group/read rows are whole-row textDim (gutter, path and tail share
      // one wrap), so the gutter can never drift to a different tone.
      'tool-group.ts': /fg\('textDim', `\$\{branch\}\$\{label\}/,
      'read-group.ts': /fg\('textDim', ` {2}\$\{branch\} \$\{path\}/,
    };
    for (const [name, pattern] of Object.entries(expectations)) {
      const content = readFileSync(join(MESSAGES_DIR, name), 'utf8');
      expect(content, name).toMatch(pattern);
    }
    // AgentGroup deliberately keeps the upstream unstyled branch glyphs
    // (user decision — the Coder Agent card keeps its original look).
    const agentGroup = readFileSync(join(MESSAGES_DIR, 'agent-group.ts'), 'utf8');
    expect(agentGroup).not.toMatch(/fg\('textDim', isLast \? '└─' : '├─'\)/u);
  });

  it('command cards render the $/⎿ shape instead of the tree gutter', () => {
    const content = readFileSync(join(MESSAGES_DIR, 'shell-execution.ts'), 'utf8');
    expect(content).toContain('COMMAND_PROMPT');
    expect(content).toContain('COMMAND_OUTPUT_MARK');
    expect(content).not.toContain('DETAIL_TREE_MIDDLE');
  });

  it('detail renderers do not hand-roll indentation or tones', () => {
    for (const name of ['truncated.ts', 'summary.ts', 'media.ts', 'goal.ts']) {
      const content = readFileSync(join(MESSAGES_DIR, 'tool-renderers', name), 'utf8');
      // Body rows render flush left; the gutter wrapper owns indentation.
      expect(content, name).not.toMatch(/new Text\(`\s+\$/);
    }
  });
});
