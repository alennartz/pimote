import { describe, expect, it, vi } from 'vitest';
import { createManagerThemePort } from './theme-port.js';

function selection(user: string, selectedThemeId: string | null) {
  return {
    selectedThemeId,
    activeThemeId: selectedThemeId ?? 'pimote/light',
    theme: {
      id: selectedThemeId ?? 'pimote/light',
      name: selectedThemeId === 'pimote/dark' ? 'Pimote Dark' : 'Pimote Light',
      source: 'builtin' as const,
      colorScheme: selectedThemeId === 'pimote/dark' ? ('dark' as const) : ('light' as const),
      ui: {},
      editor: { surface: {}, syntax: {}, terminal: {} },
    },
    user,
  };
}

describe('createManagerThemePort', () => {
  it('rejects an unknown user before changing preferences', async () => {
    const preferences = { setKnownUserTheme: vi.fn() };
    const port = createManagerThemePort({
      profiles: { summaries: () => [{ name: 'alice', sessionCount: 1 }] },
      preferences,
      broadcastUserThemeChanged: vi.fn(),
      prepareDemo: vi.fn(),
    });

    await expect(port.setKnownUserTheme('bob', 'pimote/dark')).rejects.toThrow('Unknown user: bob');
    expect(preferences.setKnownUserTheme).not.toHaveBeenCalled();
  });

  it('persists a known user selection, broadcasts it, and returns a compact assignment', async () => {
    const preferences = { setKnownUserTheme: vi.fn(async (user: string, themeId: string | null) => selection(user, themeId)) };
    const broadcast = vi.fn();
    const port = createManagerThemePort({
      profiles: { summaries: () => [{ name: 'alice', sessionCount: 1 }] },
      preferences,
      broadcastUserThemeChanged: broadcast,
      prepareDemo: vi.fn(),
    });

    await expect(port.setKnownUserTheme('alice', 'pimote/dark')).resolves.toEqual({
      user: 'alice',
      selectedThemeId: 'pimote/dark',
      activeThemeId: 'pimote/dark',
      themeName: 'Pimote Dark',
      colorScheme: 'dark',
      source: 'builtin',
    });
    expect(preferences.setKnownUserTheme).toHaveBeenCalledWith('alice', 'pimote/dark');
    expect(broadcast).toHaveBeenCalledWith('alice');
  });

  it('passes draft demo preparation through the injected builder', async () => {
    const bundle = { folderPath: '/tmp/demo', title: 'Theme demo', themeIds: ['alice/custom'], diagnostics: [] };
    const prepareDemo = vi.fn(async () => bundle);
    const port = createManagerThemePort({
      profiles: { summaries: () => [] },
      preferences: { setKnownUserTheme: vi.fn() },
      broadcastUserThemeChanged: vi.fn(),
      prepareDemo,
    });

    await expect(port.prepareDemo('/tmp/themes.json')).resolves.toBe(bundle);
    expect(prepareDemo).toHaveBeenCalledWith('/tmp/themes.json');
  });
});
