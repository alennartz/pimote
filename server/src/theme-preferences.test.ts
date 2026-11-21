import { describe, expect, it } from 'vitest';
import type { ThemeCatalogSnapshot } from '../../shared/dist/index.js';
import { resolvedTheme } from '../../shared/test/theme-fixtures.js';
import { ThemePreferences } from './theme-preferences.js';

function service(selectedThemeId: string | null = null, defaultThemeId = 'pimote/light'): ThemePreferences {
  const snapshot: ThemeCatalogSnapshot = {
    revision: 1,
    defaultThemeId,
    themes: [resolvedTheme('pimote/light'), resolvedTheme('pimote/dark'), resolvedTheme('alice/custom', 'Alice Custom', 'user')],
    diagnostics: [],
  };
  return new ThemePreferences({
    catalog: { snapshot: () => snapshot },
    profiles: {
      selectedTheme: () => selectedThemeId,
      setSelectedTheme: async (_user, themeId) => {
        selectedThemeId = themeId;
        return true;
      },
    },
  });
}

describe('ThemePreferences', () => {
  it('returns the full catalog snapshot for the PWA request', () => {
    expect(service().getCatalog()).toMatchObject({ revision: 1, defaultThemeId: 'pimote/light' });
  });

  it('persists a valid theme ID and resolves it as the active theme', async () => {
    const prefs = service();
    await expect(prefs.setTheme('alice', 'pimote/dark')).resolves.toMatchObject({ selectedThemeId: 'pimote/dark', activeThemeId: 'pimote/dark' });
    expect(prefs.resolve('alice')).toMatchObject({ selectedThemeId: 'pimote/dark', activeThemeId: 'pimote/dark' });
  });

  it('accepts null to follow the configured server default', async () => {
    await expect(service('pimote/dark').setTheme('alice', null)).resolves.toMatchObject({ selectedThemeId: null, activeThemeId: 'pimote/light' });
  });

  it('uses strict persistence for an existing-user administration change', async () => {
    let calledWith: [string, string | null] | undefined;
    const setSelectedThemeStrict = async (user: string, themeId: string | null) => {
      calledWith = [user, themeId];
      return true;
    };
    const prefs = new ThemePreferences({
      catalog: { snapshot: () => ({ revision: 1, defaultThemeId: 'pimote/light', themes: [resolvedTheme('pimote/light')], diagnostics: [] }) },
      profiles: { selectedTheme: () => null, setSelectedTheme: async () => true, hasUser: () => true, setSelectedThemeStrict },
    });

    await expect(prefs.setKnownUserTheme('alice', 'pimote/light')).resolves.toMatchObject({ activeThemeId: 'pimote/light' });
    expect(calledWith).toEqual(['alice', 'pimote/light']);
  });

  it('rejects IDs that are not in the current catalog', async () => {
    const prefs = service('pimote/dark');
    await expect(prefs.setTheme('alice', 'missing/theme')).rejects.toThrow();
    expect(prefs.resolve('alice').selectedThemeId).toBe('pimote/dark');
  });

  it('falls back to the server default when a saved theme disappears but keeps the saved ID', () => {
    expect(service('missing/theme').resolve('alice')).toMatchObject({ selectedThemeId: 'missing/theme', activeThemeId: 'pimote/light' });
  });

  it('updates followers when the default changes without replacing saved overrides', () => {
    let defaultThemeId = 'pimote/light';
    const selections = new Map<string, string | null>([
      ['alice', null],
      ['bob', 'alice/custom'],
    ]);
    const prefs = new ThemePreferences({
      catalog: {
        snapshot: () => ({
          revision: 1,
          defaultThemeId,
          themes: [resolvedTheme('pimote/light'), resolvedTheme('pimote/dark'), resolvedTheme('alice/custom', 'Alice Custom', 'user')],
          diagnostics: [],
        }),
      },
      profiles: {
        selectedTheme: (user) => selections.get(user) ?? null,
        setSelectedTheme: async (user, themeId) => {
          selections.set(user, themeId);
          return true;
        },
      },
    });
    expect(prefs.resolve('alice').activeThemeId).toBe('pimote/light');
    defaultThemeId = 'pimote/dark';
    expect(prefs.resolve('alice').activeThemeId).toBe('pimote/dark');
    expect(prefs.resolve('bob')).toMatchObject({ selectedThemeId: 'alice/custom', activeThemeId: 'alice/custom' });
  });

  it('falls back to Pimote Light when the configured server default is unavailable', () => {
    const prefs = service(null, 'missing/default');
    expect(prefs.resolve('alice')).toMatchObject({ activeThemeId: 'pimote/light', theme: expect.objectContaining({ id: 'pimote/light' }) });
  });
});
