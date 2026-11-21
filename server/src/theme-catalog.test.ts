import { describe, expect, it, vi } from 'vitest';
import { themeDefinition as theme } from '../../shared/test/theme-fixtures.js';
import { builtinThemeDefinitions, ThemeCatalog, type ThemeCatalogOptions } from './theme-catalog.js';
import { ThemePreferences } from './theme-preferences.js';

function catalog(overrides: Partial<ThemeCatalogOptions> = {}): ThemeCatalog {
  const fileText = JSON.stringify({ version: 1, themes: [] });
  return new ThemeCatalog({
    builtinThemes: [theme('pimote/light', 'Pimote Light'), theme('pimote/dark', 'Pimote Dark')],
    extensionFiles: [],
    userFile: '/config/pimote/themes.json',
    defaultThemeId: 'pimote/light',
    reader: { read: vi.fn(async () => fileText) },
    ...overrides,
  });
}

describe('ThemeCatalog', () => {
  it('ships all eleven named built-in themes as complete, valid palettes', async () => {
    const service = catalog({ builtinThemes: builtinThemeDefinitions() });
    const snapshot = await service.load();
    expect(snapshot.themes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'pimote/light',
        'pimote/dark',
        'pimote/dracula',
        'pimote/tokyo-night',
        'pimote/nord',
        'pimote/gruvbox-dark',
        'pimote/solarized-light',
        'pimote/catppuccin-mocha',
        'pimote/catppuccin-latte',
        'pimote/everforest-medium-dark',
      ]),
    );
    expect(snapshot.themes.filter((entry) => entry.source === 'builtin')).toHaveLength(10);
    const required = theme('fixture/theme');
    for (const entry of snapshot.themes) {
      expect(Object.keys(entry.ui)).toEqual(expect.arrayContaining(Object.keys(required.ui)));
      expect(Object.keys(entry.editor.surface)).toEqual(expect.arrayContaining(Object.keys(required.editor.surface)));
      expect(Object.keys(entry.editor.syntax)).toEqual(expect.arrayContaining(Object.keys(required.editor.syntax)));
      expect(Object.keys(entry.editor.terminal)).toEqual(expect.arrayContaining(Object.keys(required.editor.terminal)));
    }
  });

  it('fills selected-chip status roles for existing standalone theme files', async () => {
    const legacyTheme = theme('alice/legacy-theme');
    delete legacyTheme.ui['status-streaming-on-primary'];
    delete legacyTheme.ui['status-reconnecting-on-primary'];
    const reader = {
      read: async (path: string) => (path === '/extensions/legacy.json' ? JSON.stringify({ version: 1, themes: [legacyTheme] }) : JSON.stringify({ version: 1, themes: [] })),
    };
    const service = catalog({ extensionFiles: ['/extensions/legacy.json'], reader });
    const snapshot = await service.load();
    const resolved = snapshot.themes.find((entry) => entry.id === legacyTheme.id);
    await service.close();

    expect(snapshot.diagnostics).toEqual([]);
    expect(resolved?.ui['status-streaming-on-primary']).toBe(resolved?.ui['primary-foreground']);
    expect(resolved?.ui['status-reconnecting-on-primary']).toBe(resolved?.ui['primary-foreground']);
  });

  it.each([
    ['pimote/dracula', '#50fa7b', '#ffb86c', '#ffb86c', '#ff5555', '#50fa7b'],
    ['pimote/tokyo-night', '#9ece6a', '#e0af68', '#e0af68', '#f7768e', '#73daca'],
    ['pimote/nord', '#a3be8c', '#ebcb8b', '#ebcb8b', '#bf616a', '#a3be8c'],
    ['pimote/gruvbox-dark', '#b8bb26', '#fe8019', '#fe8019', '#fb4934', '#98971a'],
    ['pimote/solarized-light', '#859900', '#cb4b16', '#b58900', '#dc322f', '#859900'],
    ['pimote/catppuccin-mocha', '#a6e3a1', '#fab387', '#fab387', '#f38ba8', '#a6e3a1'],
    ['pimote/catppuccin-latte', '#40a02b', '#fe640b', '#fe640b', '#d20f39', '#40a02b'],
    ['pimote/everforest-medium-dark', '#A7C080', '#DBBC7F', '#E69875', '#E67E80', '#A7C080'],
  ] as const)('uses palette-aligned semantic statuses and ANSI green for %s', async (id, success, warning, reconnecting, error, ansiGreen) => {
    const service = catalog({ builtinThemes: builtinThemeDefinitions() });
    const snapshot = await service.load();
    const theme = snapshot.themes.find((entry) => entry.id === id);
    expect(theme?.ui).toMatchObject({
      'status-connected': success,
      'status-streaming': success,
      warning,
      'status-reconnecting': reconnecting,
      destructive: error,
      'status-error': error,
    });
    expect(theme?.editor.terminal.green).toBe(ansiGreen);
  });

  it('resolves an extension theme that extends a built-in through its legacy ID', async () => {
    const child = {
      ...theme('alice/dracula-child'),
      extends: 'dracula/dracula',
      ui: {},
      editor: { surface: {}, syntax: {}, terminal: {} },
    };
    const service = catalog({
      builtinThemes: builtinThemeDefinitions(),
      extensionFiles: ['/extensions/child.json'],
      reader: { read: async (path: string) => (path === '/extensions/child.json' ? JSON.stringify({ version: 1, themes: [child] }) : JSON.stringify({ version: 1, themes: [] })) },
    });

    await expect(service.load()).resolves.toMatchObject({
      themes: expect.arrayContaining([expect.objectContaining({ id: 'alice/dracula-child', ui: expect.objectContaining({ background: '#282a36' }) })]),
    });
  });

  it('publishes built-ins, extensions, and user themes in source order', async () => {
    const extension = theme('publisher/night', 'Publisher Night');
    const user = theme('alice/custom', 'Alice Custom');
    const reader = {
      read: vi.fn(async (path: string) =>
        path === '/extensions/night.json' ? JSON.stringify({ version: 1, themes: [extension] }) : JSON.stringify({ version: 1, themes: [user] }),
      ),
    };
    const service = catalog({ extensionFiles: ['/extensions/night.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      defaultThemeId: 'pimote/light',
      themes: [
        expect.objectContaining({ id: 'pimote/light', source: 'builtin' }),
        expect.objectContaining({ id: 'pimote/dark', source: 'builtin' }),
        expect.objectContaining({ id: 'publisher/night', source: 'extension' }),
        expect.objectContaining({ id: 'alice/custom', source: 'user' }),
      ],
    });
  });

  it('rejects malformed files without blocking valid sources and records diagnostics', async () => {
    const reader = { read: vi.fn(async (path: string) => (path === '/extensions/bad.json' ? '{broken' : JSON.stringify({ version: 1, themes: [theme('alice/custom')] }))) };
    const service = catalog({ extensionFiles: ['/extensions/bad.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: [expect.objectContaining({ id: 'pimote/light' }), expect.objectContaining({ id: 'pimote/dark' }), expect.objectContaining({ id: 'alice/custom' })],
      diagnostics: [expect.objectContaining({ path: '/extensions/bad.json' })],
    });
  });

  it('drops reserved built-in IDs and later duplicates instead of shadowing earlier entries', async () => {
    const extension = theme('pimote/light', 'Extension Light');
    const first = theme('publisher/duplicate', 'First');
    const later = theme('publisher/duplicate', 'Later');
    const reader = { read: vi.fn(async (path: string) => JSON.stringify({ version: 1, themes: path === '/extensions/themes.json' ? [extension, first, later] : [] })) };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: expect.arrayContaining([
        expect.objectContaining({ id: 'pimote/light', name: 'Pimote Light' }),
        expect.objectContaining({ id: 'publisher/duplicate', name: 'First' }),
      ]),
      diagnostics: expect.arrayContaining([expect.objectContaining({ themeId: 'pimote/light' }), expect.objectContaining({ themeId: 'publisher/duplicate' })]),
    });
  });

  it('resolves palette references and inheritance into complete token maps', async () => {
    const reader = {
      read: vi.fn(async (path: string) =>
        JSON.stringify({
          version: 1,
          themes:
            path === '/extensions/themes.json'
              ? [
                  {
                    ...theme('alice/base'),
                    palette: { accent: '#123456', inherited: '#789abc' },
                    ui: { ...theme('alice/base').ui, primary: { palette: 'accent' } },
                  },
                  {
                    ...theme('alice/child'),
                    extends: 'alice/base',
                    palette: { accent: '#abcdef' },
                    ui: { accent: { palette: 'accent' }, primary: { palette: 'inherited' } },
                    editor: { surface: {}, syntax: {}, terminal: {} },
                  },
                ]
              : [],
        }),
      ),
    };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: expect.arrayContaining([
        expect.objectContaining({ id: 'alice/base', ui: expect.objectContaining({ primary: '#123456' }) }),
        expect.objectContaining({ id: 'alice/child', ui: expect.objectContaining({ primary: '#789abc', accent: '#abcdef' }) }),
      ]),
    });
  });

  it('rejects inheritance cycles and unresolved references without loading partial themes', async () => {
    const reader = {
      read: vi.fn(async (path: string) =>
        JSON.stringify({
          version: 1,
          themes:
            path === '/extensions/themes.json'
              ? [
                  { ...theme('alice/a'), extends: 'alice/b' },
                  { ...theme('alice/b'), extends: 'alice/a' },
                  { ...theme('alice/missing'), extends: 'publisher/absent' },
                ]
              : [],
        }),
      ),
    };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: [expect.objectContaining({ id: 'pimote/light' }), expect.objectContaining({ id: 'pimote/dark' })],
      diagnostics: expect.arrayContaining([expect.objectContaining({ themeId: 'alice/a' }), expect.objectContaining({ themeId: 'alice/missing' })]),
    });
  });

  it.each([
    ['unsupported version', { version: 2, themes: [theme('alice/invalid')] }],
    ['missing required role', { version: 1, themes: [{ ...theme('alice/invalid'), ui: {} }] }],
    ['invalid color', { version: 1, themes: [{ ...theme('alice/invalid'), ui: { ...theme('alice/invalid').ui, primary: 'not-a-color' } }] }],
    ['missing palette reference', { version: 1, themes: [{ ...theme('alice/invalid'), ui: { ...theme('alice/invalid').ui, primary: { palette: 'absent' } } }] }],
  ])('rejects %s without blocking the built-ins', async (_description, input) => {
    const reader = { read: async (path: string) => (path === '/extensions/bad.json' ? JSON.stringify(input) : JSON.stringify({ version: 1, themes: [] })) };
    const snapshot = await catalog({ extensionFiles: ['/extensions/bad.json'], reader }).load();
    expect(snapshot.themes.some((entry) => entry.id === 'alice/invalid')).toBe(false);
    expect(snapshot.themes.some((entry) => entry.id === 'pimote/light')).toBe(true);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.path === '/extensions/bad.json')).toBe(true);
  });

  it('accepts low-contrast colors without warnings', async () => {
    const lowContrast = theme('alice/low-contrast');
    lowContrast.ui.background = '#ffffff';
    lowContrast.ui.foreground = '#ffffff';
    const reader = { read: async () => JSON.stringify({ version: 1, themes: [lowContrast] }) };
    const snapshot = await catalog({ reader }).load();
    expect(snapshot.themes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'alice/low-contrast' })]));
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('falls back without changing a saved theme when its parent disappears', async () => {
    let userThemes = [theme('alice/base')];
    const child = { ...theme('publisher/child'), extends: 'alice/base' };
    const reader = {
      read: async (path: string) => JSON.stringify({ version: 1, themes: path === '/extensions/themes.json' ? [child] : userThemes }),
    };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });
    const prefs = new ThemePreferences({
      catalog: service,
      profiles: { selectedTheme: () => 'publisher/child', setSelectedTheme: async () => true },
    });
    await service.load();
    expect(prefs.resolve('alice').activeThemeId).toBe('publisher/child');
    userThemes = [];
    await service.reload();
    expect(prefs.resolve('alice')).toMatchObject({ selectedThemeId: 'publisher/child', activeThemeId: 'pimote/light' });
  });

  it('retains the last valid user contribution after an invalid edit', async () => {
    const read = vi
      .fn<ThemeCatalogOptions['reader']['read']>()
      .mockResolvedValueOnce(JSON.stringify({ version: 1, themes: [theme('alice/custom')] }))
      .mockResolvedValueOnce('{broken');
    const service = catalog({ reader: { read } });

    await service.load();
    await expect(service.reload()).resolves.toMatchObject({ themes: expect.arrayContaining([expect.objectContaining({ id: 'alice/custom' })]) });
  });

  it('watches the user file and publishes a revision when a valid edit changes themes', async () => {
    let userFile = JSON.stringify({ version: 1, themes: [] });
    let changed: (() => void) | undefined;
    const reader: ThemeCatalogOptions['reader'] = {
      read: async () => userFile,
      watch: (_path, listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    };
    const service = catalog({ reader });
    const initial = await service.load();
    const update = new Promise<Awaited<ReturnType<ThemeCatalog['load']>>>((resolve) => service.onChange(resolve));
    userFile = JSON.stringify({ version: 1, themes: [theme('alice/custom')] });
    expect(changed).toBeDefined();
    changed?.();
    const snapshot = await update;
    expect(snapshot.revision).toBeGreaterThan(initial.revision);
    expect(snapshot.themes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'alice/custom' })]));
    await service.close();
  });

  it('increments revisions and notifies subscribers when a valid source changes', async () => {
    const service = catalog();
    const seen: number[] = [];
    service.onChange((snapshot) => seen.push(snapshot.revision));

    const initial = await service.load();
    const changed = await service.setDefaultTheme('pimote/dark');

    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(seen).toContain(changed.revision);
  });

  it('publishes a changed default without rewriting saved user selections', async () => {
    const service = catalog();

    const initial = await service.load();
    const changed = await service.setDefaultTheme('pimote/dark');
    expect(changed.defaultThemeId).toBe('pimote/dark');
    expect(changed.revision).toBeGreaterThan(initial.revision);
  });
});
