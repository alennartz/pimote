import { describe, expect, it, vi } from 'vitest';
import type { ThemeDefinition } from '../../shared/dist/index.js';
import { ThemeCatalog, type ThemeCatalogOptions } from './theme-catalog.js';

function theme(id: string, name = id): ThemeDefinition {
  return {
    id,
    name,
    colorScheme: id.includes('light') ? 'light' : 'dark',
    ui: {},
    editor: { surface: {}, syntax: {}, terminal: {} },
  };
}

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
    const reader = { read: vi.fn(async () => JSON.stringify({ version: 1, themes: [extension, first, later] })) };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: [expect.objectContaining({ id: 'pimote/light', name: 'Pimote Light' }), expect.objectContaining({ id: 'publisher/duplicate', name: 'First' })],
      diagnostics: expect.arrayContaining([expect.objectContaining({ themeId: 'pimote/light' }), expect.objectContaining({ themeId: 'publisher/duplicate' })]),
    });
  });

  it('resolves palette references and inheritance into complete token maps', async () => {
    const reader = {
      read: vi.fn(async () =>
        JSON.stringify({
          version: 1,
          themes: [
            {
              ...theme('alice/base'),
              palette: { accent: '#123456' },
              ui: { primary: { palette: 'accent' } },
              extends: undefined,
            },
            {
              ...theme('alice/child'),
              extends: 'alice/base',
              ui: { accent: { palette: 'accent' } },
            },
          ],
        }),
      ),
    };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: [
        expect.objectContaining({ id: 'alice/base', ui: expect.objectContaining({ primary: '#123456' }) }),
        expect.objectContaining({ id: 'alice/child', ui: expect.objectContaining({ accent: '#123456' }) }),
      ],
    });
  });

  it('rejects inheritance cycles and unresolved references without loading partial themes', async () => {
    const reader = {
      read: vi.fn(async () =>
        JSON.stringify({
          version: 1,
          themes: [
            { ...theme('alice/a'), extends: 'alice/b' },
            { ...theme('alice/b'), extends: 'alice/a' },
            { ...theme('alice/missing'), extends: 'publisher/absent' },
          ],
        }),
      ),
    };
    const service = catalog({ extensionFiles: ['/extensions/themes.json'], reader });

    await expect(service.load()).resolves.toMatchObject({
      themes: [expect.objectContaining({ id: 'pimote/light' }), expect.objectContaining({ id: 'pimote/dark' })],
      diagnostics: expect.arrayContaining([expect.objectContaining({ themeId: 'alice/a' }), expect.objectContaining({ themeId: 'alice/missing' })]),
    });
  });

  it('retains the last valid user contribution after an invalid edit', async () => {
    const read = vi
      .fn<ThemeCatalogOptions['reader']['read']>()
      .mockResolvedValueOnce(JSON.stringify({ version: 1, themes: [theme('alice/custom')] }))
      .mockResolvedValueOnce('{broken');
    const service = catalog({ reader: { read } });

    await service.load();
    await expect(service.reload()).resolves.toMatchObject({ themes: [expect.objectContaining({ id: 'alice/custom' })] });
  });

  it('increments revisions and notifies subscribers when a valid source changes', async () => {
    const service = catalog();
    const seen: number[] = [];
    service.onChange((snapshot) => seen.push(snapshot.revision));

    await service.load();
    await service.reload();

    expect(seen).toEqual([1, 2]);
  });

  it('publishes a changed default without rewriting saved user selections', async () => {
    const service = catalog();

    await service.load();
    await expect(service.setDefaultTheme('pimote/dark')).resolves.toMatchObject({ defaultThemeId: 'pimote/dark', revision: 2 });
  });
});
