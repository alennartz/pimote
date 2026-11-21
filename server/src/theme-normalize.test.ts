import { describe, expect, it, vi } from 'vitest';
import { MANDATORY_TOKENS, tokenNamespace, type ThemeDefinition } from '../../shared/dist/index.js';
import { themeDefinition, anchorThemeDefinition } from '../../shared/test/theme-fixtures.js';
import { ThemeCatalog } from './theme-catalog.js';
import { normalizeThemeFile } from './theme-normalize.js';

const uiAnchors = MANDATORY_TOKENS.filter((token) => tokenNamespace(token) === 'ui').map((token) => token.slice('ui.'.length));
const surfaceAnchors = MANDATORY_TOKENS.filter((token) => tokenNamespace(token) === 'editor.surface').map((token) => token.slice('editor.surface.'.length));
const syntaxAnchors = MANDATORY_TOKENS.filter((token) => tokenNamespace(token) === 'editor.syntax').map((token) => token.slice('editor.syntax.'.length));
const terminalAnchors = MANDATORY_TOKENS.filter((token) => tokenNamespace(token) === 'editor.terminal').map((token) => token.slice('editor.terminal.'.length));

function file(...themes: readonly ThemeDefinition[]): string {
  return JSON.stringify({ version: 1, themes }, null, 2);
}

function definition(id = 'alice/full'): ThemeDefinition {
  return themeDefinition(id, 'Full');
}

async function resolvedByCatalog(raw: string): Promise<unknown> {
  const service = new ThemeCatalog({
    builtinThemes: [],
    extensionFiles: ['/themes/in.json'],
    userFile: '/themes/empty.json',
    defaultThemeId: 'pimote/light',
    reader: { read: vi.fn(async (path: string) => (path === '/themes/in.json' ? raw : file())) },
  });
  const snapshot = await service.load();
  await service.close();
  return snapshot.themes;
}

describe('theme normalize', () => {
  it('keeps the anchors and drops every statement that repeats its fallback', () => {
    const result = normalizeThemeFile(file(definition()));

    expect(Object.keys(result.themes[0]!.ui).sort()).toEqual([...uiAnchors].sort());
    expect(Object.keys(result.themes[0]!.editor.syntax).sort()).toEqual([...syntaxAnchors, 'meta'].sort());
    expect(Object.keys(result.themes[0]!.editor.terminal).sort()).toEqual([...terminalAnchors].sort());
    expect(result.themes[0]!.editor.surface['gutter-background']).toBeUndefined();
    expect(result.themes[0]!.editor.surface.cursor).toBe('#222222');
    expect(Object.keys(result.themes[0]!.editor.surface)).toEqual(expect.arrayContaining([...surfaceAnchors]));
  });

  it('keeps a statement that departs from its fallback', () => {
    const theme = definition();
    theme.ui.card = '#222222';
    const result = normalizeThemeFile(file(theme));

    expect(result.themes[0]!.ui.card).toBe('#222222');
    expect(result.changed).toBe(true);
  });

  it('is idempotent', () => {
    const once = normalizeThemeFile(file(definition()));
    const twice = normalizeThemeFile(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(false);
  });

  it('preserves the resolved theme', async () => {
    const theme = definition();
    theme.ui.card = '#222222';
    theme.ui.accent = '#333333';
    theme.editor.surface.selection = '#444444';
    theme.editor.syntax['comment.documentation'] = '#555555';
    const raw = file(theme);
    const normalized = normalizeThemeFile(raw).text;

    expect(await resolvedByCatalog(normalized)).toEqual(await resolvedByCatalog(raw));
  });

  it('drops statements that only repeat the inherited base', () => {
    const base = definition('pimote/light');
    base.ui.primary = '#123456';
    const child: ThemeDefinition = {
      id: 'alice/child',
      name: 'Child',
      colorScheme: 'light',
      extends: 'pimote/light',
      ui: { primary: '#123456' },
      editor: { surface: {}, syntax: {}, terminal: {} },
    };
    const result = normalizeThemeFile(file(child), { builtinThemes: [base] });

    expect(result.themes[0]!.ui).toEqual({});
    expect(result.themes[0]!.editor.surface).toEqual({});
    expect(result.themes[0]!.extends).toBe('pimote/light');
  });

  it('reports the deepest depth per namespace and the statements that reach past an unstated parent', () => {
    const theme = anchorThemeDefinition('alice/anchors');
    theme.ui.accent = '#333333';
    const result = normalizeThemeFile(file(theme));
    const profile = result.profiles['alice/anchors']!;

    expect(profile.depth.ui).toBe(4);
    expect(profile.depth['editor.terminal']).toBe(0);
    expect(profile.reach).toEqual(['ui.accent']);
  });

  it('keeps the palette entries the theme still references', async () => {
    const theme = anchorThemeDefinition('alice/palette');
    const palette = Object.fromEntries(Object.entries(theme.ui).map(([role, value]) => [`swatch-${role}`, value as string]));
    const referenced = Object.fromEntries(Object.entries(theme.ui).map(([role]) => [role, { palette: `swatch-${role}` }]));
    const result = normalizeThemeFile(file({ ...theme, palette, ui: referenced }));
    const normalized = result.themes[0]!;

    expect(Object.keys(normalized.palette ?? {}).length).toBeGreaterThan(0);
    expect(await resolvedByCatalog(result.text)).toEqual(await resolvedByCatalog(file({ ...theme, palette, ui: referenced })));
  });

  it('leaves a base untouched when a theme in the same file overrides a chained token', async () => {
    const base = anchorThemeDefinition('alice/base');
    base.ui.card = '#111111';
    const child: ThemeDefinition = {
      id: 'alice/child',
      name: 'Child',
      colorScheme: 'dark',
      extends: 'alice/base',
      ui: { card: '#222222' },
      editor: { surface: {}, syntax: {}, terminal: {} },
    };
    const raw = file(base, child);
    const result = normalizeThemeFile(raw);

    expect(result.diagnostics).toEqual([]);
    expect(await resolvedByCatalog(result.text)).toEqual(await resolvedByCatalog(raw));
  });

  it('reports the tokens it could not resolve instead of writing a file', () => {
    const broken = anchorThemeDefinition('alice/broken');
    delete broken.ui.background;
    const result = normalizeThemeFile(file(broken));

    expect(result.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('ui.background') })]);
    expect(result.changed).toBe(false);
  });
});
