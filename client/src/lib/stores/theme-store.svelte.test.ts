import { describe, expect, it, vi } from 'vitest';
import type { PimoteResponse, ResolvedTheme, ThemeCatalogSnapshot } from '@pimote/shared';
import { ThemeStore, type ThemeStoreStorage } from './theme-store.svelte.js';

function storage(): ThemeStoreStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function theme(id: string): ResolvedTheme {
  return {
    id,
    name: id,
    source: id.startsWith('pimote/') ? 'builtin' : 'user',
    colorScheme: id.includes('light') ? 'light' : 'dark',
    ui: {},
    editor: { surface: {}, syntax: {}, terminal: {} },
  } as ResolvedTheme;
}

function snapshot(): ThemeCatalogSnapshot {
  return { revision: 4, defaultThemeId: 'pimote/light', themes: [theme('pimote/light'), theme('pimote/dark'), theme('alice/custom')], diagnostics: [] };
}

function store(send: (command: any) => Promise<PimoteResponse> = async () => ({ id: '1', success: true, data: snapshot() })) {
  return new ThemeStore({ user: 'alice', send, storage: storage(), apply: vi.fn() });
}

describe('ThemeStore', () => {
  it('loads the full catalog through the PWA-only request', async () => {
    const send = vi.fn(async () => ({ id: 'catalog', success: true, data: snapshot() }) satisfies PimoteResponse);
    const instance = store(send);

    await expect(instance.loadCatalog()).resolves.toMatchObject({ revision: 4, themes: expect.arrayContaining([expect.objectContaining({ id: 'alice/custom' })]) });
    expect(send).toHaveBeenCalledWith({ type: 'get_theme_catalog' });
  });

  it('refreshes after a revision-only catalog change event', async () => {
    const send = vi.fn(async () => ({ id: 'catalog', success: true, data: snapshot() }) satisfies PimoteResponse);
    const instance = store(send);

    await expect(instance.handleCatalogChanged({ type: 'theme_catalog_changed', revision: 5 })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ type: 'get_theme_catalog' });
  });

  it('adopts the shared user selection only after profile reconciliation', () => {
    const instance = store();

    instance.handleProfile({
      type: 'user_sessions_changed',
      sessions: [],
      views: [],
      order: [],
      selectedSessionId: null,
      orderVersion: 0,
      selectedThemeId: 'alice/custom',
      fresh: false,
    });

    expect(instance.selectedThemeId).toBe('alice/custom');
    expect(instance.profileReconciled).toBe(true);
  });

  it('previews a paired UI and editor palette without changing the saved selection', () => {
    const instance = store();
    instance.catalog = snapshot();
    instance.selectedThemeId = 'pimote/light';

    instance.preview('alice/custom');

    expect(instance.previewThemeId).toBe('alice/custom');
    expect(instance.selectedThemeId).toBe('pimote/light');
  });

  it('restores the saved palette when Cancel is pressed', () => {
    const instance = store();
    instance.selectedThemeId = 'pimote/light';
    instance.previewThemeId = 'pimote/dark';

    instance.cancel();

    expect(instance.previewThemeId).toBe('pimote/light');
  });

  it('keeps Save disabled until profile reconciliation and session adoption finish', () => {
    const instance = store();

    expect(instance.saveDisabled).toBe(true);
    instance.profileReconciled = true;
    expect(instance.saveDisabled).toBe(true);
    instance.sessionAdoptionComplete = true;
    expect(instance.saveDisabled).toBe(false);
  });

  it('saves a null selection to follow the server default', async () => {
    const send = vi.fn(async () => ({ id: 'save', success: true }) satisfies PimoteResponse);
    const instance = store(send);
    instance.previewThemeId = null;
    instance.profileReconciled = true;
    instance.sessionAdoptionComplete = true;

    await expect(instance.save()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ type: 'set_theme', themeId: null });
  });
});
