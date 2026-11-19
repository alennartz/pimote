import { describe, expect, it } from 'vitest';
import type { ResolvedTheme, ThemeCatalogSnapshot } from '../../shared/dist/index.js';
import { ThemePreferences } from './theme-preferences.js';

function resolved(id: string, colorScheme: 'light' | 'dark' = 'dark'): ResolvedTheme {
  return { id, name: id, source: id.startsWith('pimote/') ? 'builtin' : 'user', colorScheme, ui: {}, editor: { surface: {}, syntax: {}, terminal: {} } } as ResolvedTheme;
}

function service(selectedThemeId: string | null = null): ThemePreferences {
  const snapshot: ThemeCatalogSnapshot = {
    revision: 1,
    defaultThemeId: 'pimote/light',
    themes: [resolved('pimote/light', 'light'), resolved('pimote/dark'), resolved('alice/custom')],
    diagnostics: [],
  };
  return new ThemePreferences({
    catalog: { snapshot: () => snapshot },
    profiles: {
      selectedTheme: () => selectedThemeId,
      setSelectedTheme: async () => true,
    },
  });
}

describe('ThemePreferences', () => {
  it('returns the full catalog snapshot for the PWA request', () => {
    expect(service().getCatalog()).toMatchObject({ revision: 1, defaultThemeId: 'pimote/light' });
  });

  it('persists a valid theme ID and resolves it as the active theme', async () => {
    await expect(service().setTheme('alice', 'pimote/dark')).resolves.toMatchObject({ selectedThemeId: 'pimote/dark', activeThemeId: 'pimote/dark' });
  });

  it('accepts null to follow the configured server default', async () => {
    await expect(service('pimote/dark').setTheme('alice', null)).resolves.toMatchObject({ selectedThemeId: null, activeThemeId: 'pimote/light' });
  });

  it('rejects IDs that are not in the current catalog', async () => {
    await expect(service().setTheme('alice', 'missing/theme')).rejects.toThrow(/theme/i);
  });

  it('falls back to the server default when a saved theme disappears but keeps the saved ID', () => {
    expect(service('missing/theme').resolve('alice')).toMatchObject({ selectedThemeId: 'missing/theme', activeThemeId: 'pimote/light' });
  });

  it('falls back to Pimote Light when the configured server default is unavailable', () => {
    const prefs = service();
    expect(prefs.resolve('alice')).toMatchObject({ activeThemeId: 'pimote/light', theme: expect.objectContaining({ id: 'pimote/light' }) });
  });
});
