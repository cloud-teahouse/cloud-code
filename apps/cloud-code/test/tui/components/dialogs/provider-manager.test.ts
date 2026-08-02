import type { ProviderConfig } from '@cloud-code/sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '#/tui/components/dialogs/provider-manager';
import { darkColors } from '#/tui/theme/colors';

// Truecolor SGR fragments for the darkColors tokens we assert on
// (see theme/colors.ts). Forcing chalk.level below guarantees they appear.
const PRIMARY = '38;2;79;168;255'; // colors.primary  #4FA8FF
const MUTED = '38;2;107;107;107'; // colors.textMuted #6B6B6B
const BOLD = '[1m';
const ESC = String.fromCodePoint(27);

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function rendered(component: ProviderManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeComponent(overrides: Partial<ProviderManagerOptions> = {}): ProviderManagerComponent {
  return new ProviderManagerComponent({
    providers: {} as Record<string, ProviderConfig>,
    onAdd: vi.fn(),
    onDeleteSource: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
}

function addRowLine(component: ProviderManagerComponent, width = 120): string | undefined {
  return component.render(width).find((line) => line.includes('Add New Platform'));
}

describe('ProviderManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders [ Add New Platform ] in the brand color, never muted, when not selected', () => {
    // A configured provider occupies row 0 (selected); the add row sits below
    // it and is therefore not the highlighted row.
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(PRIMARY);
    expect(line).not.toContain(MUTED);
  });

  it('bolds [ Add New Platform ] when it is the selected row', () => {
    // With no configured providers the synthetic add row is the only row, so it
    // starts as the highlighted selection.
    const component = makeComponent();
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(BOLD);
    expect(line).toContain(PRIMARY);
  });

  it('labels the kimi and chatgpt-codex providers with their service names', () => {
    const component = makeComponent({
      providers: {
        kimi: { baseUrl: 'https://kimi.test' },
        'chatgpt-codex': { baseUrl: 'https://codex.test' },
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
    });
    const plain = component
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('Kimi Code');
    expect(plain).toContain('ChatGPT Codex');
    // Everything else keeps its raw provider id.
    expect(plain).toContain('acme');
    expect(plain).not.toContain('chatgpt-codex');
  });

  it('marks the active provider with the shared "← current" marker, not a bullet', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const plain = component
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('← current');
    expect(plain).not.toContain('●');
  });

  it('uses the same header shape as the model dialog (one top border, title, hint, no inner border)', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const lines = component.render(120).map((l) => l.replaceAll(SGR, ''));
    const isBorder = (l: string | undefined): boolean => /^─+$/.test((l ?? '').trim());

    const titleIdx = lines.findIndex((l) => l.includes('Providers'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The line directly under the title is the hint, never an inner border (the
    // old `border · title · border` sandwich is gone).
    expect(isBorder(lines[titleIdx + 1])).toBe(false);
    expect(lines[titleIdx + 1]).toContain('navigate');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
    // Blank line separates the hint from the body, exactly like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
    // Only the top and bottom full-width borders remain — two, not three.
    expect(lines.filter(isBorder).length).toBe(2);
  });

  it('deletes the highlighted provider via the D key (transition alias) with a y/N confirm', () => {
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onDeleteSource,
    });
    component.handleInput('D');
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('y');
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });

  it('Home/End jump the highlight to the first/last row', () => {
    const onAdd = vi.fn();
    const providers = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`p${String(i)}`, { baseUrl: `https://p${String(i)}.test` }]),
    ) as unknown as Record<string, ProviderConfig>;
    const component = makeComponent({ providers, onAdd });

    component.handleInput(`${ESC}[F`); // End → the pinned add row
    component.handleInput('\r');
    expect(onAdd).toHaveBeenCalledOnce();

    component.handleInput(`${ESC}[H`); // Home → the first provider row
    const selectedLine = rendered(component)
      .split('\n')
      .find((line) => line.includes('❯'));
    expect(selectedLine).toContain('p0');
  });

  it('lists the cascaded models in the delete confirmation', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      models: {
        'acme/m1': { provider: 'acme', model: 'm1', maxContextSize: 1024 },
        'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 1024 },
        'other/m3': { provider: 'other', model: 'm3', maxContextSize: 1024 },
      } as unknown as ProviderManagerOptions['models'],
    });
    component.handleInput('D');
    const text = rendered(component);
    expect(text).toContain('Delete platform "acme"? [y/N]');
    expect(text).toContain('Also deletes 2 models: acme/m1, acme/m2');
    expect(text).not.toContain('other/m3');
  });

  it('truncates a long cascade list in the delete confirmation', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      models: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((id) => [
          `acme/${id}`,
          { provider: 'acme', model: id, maxContextSize: 1024 },
        ]),
      ) as unknown as ProviderManagerOptions['models'],
    });
    component.handleInput('D');
    const text = rendered(component);
    expect(text).toContain('acme/a, acme/b, acme/c +2 more');
  });

  it('badges custom (standalone) providers but not managed sources', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
        'managed:chatgpt-codex': { type: 'openai_responses' },
        registry: {
          baseUrl: 'https://reg.test/v1',
          source: { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' },
        },
      } as unknown as Record<string, ProviderConfig>,
    });
    const text = rendered(component);
    const acmeLine = text.split('\n').find((line) => line.includes('acme'));
    expect(acmeLine).toContain('[custom]');
    // The managed provider gets a row (label = id) but no badge.
    const managedLine = text.split('\n').find((line) => line.includes('managed:chatgpt-codex'));
    expect(managedLine).toBeDefined();
    expect(managedLine).not.toContain('[custom]');
    // The registry source row (labeled by URL) carries no badge either.
    const registryLine = text.split('\n').find((line) => line.includes('reg.test'));
    expect(registryLine).toBeDefined();
    expect(registryLine).not.toContain('[custom]');
  });

  it('fires onEditProvider via E on a custom row and onEditGuard on a managed row (transition alias)', () => {
    const onEditProvider = vi.fn();
    const onEditGuard = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
        registry: {
          baseUrl: 'https://reg.test/v1',
          source: { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' },
        },
      } as unknown as Record<string, ProviderConfig>,
      onEditProvider,
      onEditGuard,
    });
    // Row 0 is the custom provider (insertion order).
    component.handleInput('e');
    expect(onEditProvider).toHaveBeenCalledWith('acme');
    expect(onEditGuard).not.toHaveBeenCalled();

    // Move to the registry row — E routes to the guard with the row label.
    component.handleInput(`${ESC}[B`);
    component.handleInput('E');
    expect(onEditGuard).toHaveBeenCalledTimes(1);
    expect(onEditProvider).toHaveBeenCalledTimes(1);

    // E on the add row is ignored.
    component.handleInput(`${ESC}[B`);
    component.handleInput('e');
    expect(onEditGuard).toHaveBeenCalledTimes(1);
  });

  it('shows the Alt+E hint only when an edit callback is provided, and always advertises Alt+D', () => {
    const withEdit = makeComponent({ onEditProvider: vi.fn() });
    expect(rendered(withEdit)).toContain('Alt+E edit');
    expect(rendered(withEdit)).toContain('Alt+D delete');
    const withoutEdit = makeComponent();
    expect(rendered(withoutEdit)).not.toContain('Alt+E edit');
    expect(rendered(withoutEdit)).toContain('Alt+D delete');
  });

  it('arms the delete confirm via the canonical Alt+D (CSI-u and legacy ESC-prefixed forms)', () => {
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onDeleteSource,
    });
    component.handleInput(`${ESC}[100;3u`); // alt+d
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('n'); // disarm
    component.handleInput(`${ESC}d`); // legacy alt+d
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('y');
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });

  it('fires onEditProvider via the canonical Alt+E, keeping bare E as an alias', () => {
    const onEditProvider = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      onEditProvider,
    });
    component.handleInput(`${ESC}[101;3u`); // alt+e
    expect(onEditProvider).toHaveBeenCalledWith('acme');
    component.handleInput(`${ESC}e`); // legacy alt+e
    expect(onEditProvider).toHaveBeenCalledTimes(2);
    component.handleInput('e'); // transition alias
    expect(onEditProvider).toHaveBeenCalledTimes(3);
  });

  it('closes on Esc', () => {
    const onClose = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      onClose,
    });
    component.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
