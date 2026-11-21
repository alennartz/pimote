import { describe, expect, it, vi } from 'vitest';
import type { ThemeColorValue, ThemeDefinition } from '../../shared/dist/index.js';
import { anchorThemeDefinition, themeDefinition } from '../../shared/test/theme-fixtures.js';
import { builtinThemeDefinitions, ThemeCatalog, type ThemeCatalogOptions } from './theme-catalog.js';

function catalog(themes: readonly ThemeDefinition[], overrides: Partial<ThemeCatalogOptions> = {}): ThemeCatalog {
  const fileText = JSON.stringify({ version: 1, themes });
  return new ThemeCatalog({
    builtinThemes: [anchorThemeDefinition('pimote/light', 'Pimote Light')],
    extensionFiles: [],
    userFile: '/config/pimote/themes.json',
    defaultThemeId: 'pimote/light',
    reader: { read: vi.fn(async () => fileText) },
    ...overrides,
  });
}

function literal(value: ThemeColorValue, palette: Readonly<Record<string, string>>): string {
  return typeof value === 'string' ? value : (palette[value.palette] ?? `absent swatch ${value.palette}`);
}

describe('theme catalog token graph', () => {
  it('accepts a theme that states only the mandatory tokens', async () => {
    const snapshot = await catalog([anchorThemeDefinition('alice/anchors')]).load();
    const resolved = snapshot.themes.find((entry) => entry.id === 'alice/anchors');

    expect(snapshot.diagnostics).toEqual([]);
    expect(resolved?.ui.card).toBe('#ffffff');
    expect(resolved?.ui['muted-foreground']).toBe('#111111');
    expect(resolved?.ui['surface-hover']).toBe('#ffffff');
    expect(resolved?.editor.surface.cursor).toBe('#111111');
    expect(resolved?.editor.surface.selection).toBe('#111111');
    expect(resolved?.editor.surface['selection-foreground']).toBe('#111111');
    expect(resolved?.editor.surface['active-line']).toBe('#ffffff');
    expect(resolved?.editor.syntax['comment.documentation']).toBe('#111111');
    expect(resolved?.editor.syntax.meta).toBe('#111111');
    expect(resolved?.editor.terminal['bright-red']).toBe('#111111');
    expect(Object.keys(resolved?.editor.terminal ?? {})).toHaveLength(16);
  });

  it('names a mandatory token the theme never states', async () => {
    const broken = anchorThemeDefinition('alice/broken');
    delete broken.ui.background;
    const snapshot = await catalog([broken]).load();

    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ themeId: 'alice/broken', message: expect.stringContaining('ui.background') })]);
    expect(snapshot.themes.some((entry) => entry.id === 'alice/broken')).toBe(false);
  });

  it('resolves a token that neither the child nor its base states from the child anchors', async () => {
    const base = anchorThemeDefinition('alice/base');
    base.ui.card = '#222222';
    const child: ThemeDefinition = {
      id: 'alice/child',
      name: 'Child',
      colorScheme: 'light',
      extends: 'alice/base',
      ui: { background: '#fafafa' },
      editor: { surface: {}, syntax: {}, terminal: {} },
    };
    const snapshot = await catalog([base, child]).load();
    const resolved = snapshot.themes.find((entry) => entry.id === 'alice/child');

    expect(snapshot.diagnostics).toEqual([]);
    expect(resolved?.ui.background).toBe('#fafafa');
    expect(resolved?.ui.card).toBe('#222222');
    expect(resolved?.ui.popover).toBe('#222222');
    expect(resolved?.ui['surface-sunken']).toBe('#fafafa');
  });

  it('keeps every built-in rendering its own stated values', async () => {
    const definitions = builtinThemeDefinitions();
    const snapshot = await catalog([], { builtinThemes: definitions }).load();

    expect(snapshot.themes.filter((entry) => entry.source === 'builtin')).toHaveLength(definitions.length);
    for (const definition of definitions) {
      const resolved = snapshot.themes.find((entry) => entry.id === definition.id);
      const palette = definition.palette ?? {};
      expect(resolved).toBeDefined();
      const groups = [
        [definition.ui, resolved!.ui],
        [definition.editor.surface, resolved!.editor.surface],
        [definition.editor.syntax, resolved!.editor.syntax],
        [definition.editor.terminal, resolved!.editor.terminal],
      ] as const;
      for (const [stated, values] of groups) {
        for (const [token, value] of Object.entries(stated))
          expect(`${definition.id} ${token} ${(values as Record<string, string>)[token]}`).toBe(`${definition.id} ${token} ${literal(value, palette)}`);
      }
    }
  });

  it('keeps the fixture theme rendering its stated values', async () => {
    const definition = themeDefinition('alice/fixture');
    const snapshot = await catalog([definition]).load();

    expect(snapshot.themes.find((entry) => entry.id === 'alice/fixture')?.ui.primary).toBe('#111111');
  });
});
