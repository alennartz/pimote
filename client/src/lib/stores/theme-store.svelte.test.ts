import { describe, expect, it, vi } from 'vitest';
import type { PimoteCommand, PimoteResponse, ThemeCatalogSnapshot, UserSessionsChangedEvent } from '@pimote/shared';
import { resolvedTheme } from '../../../../shared/test/theme-fixtures.js';
import { ThemeStore, type ThemeStoreStorage } from './theme-store.svelte.js';

function snapshot(): ThemeCatalogSnapshot {
  return {
    revision: 4,
    defaultThemeId: 'pimote/light',
    themes: [resolvedTheme('pimote/light', 'Pimote Light'), resolvedTheme('pimote/dark', 'Pimote Dark'), resolvedTheme('alice/custom', 'Alice Custom', 'user')],
    diagnostics: [],
  };
}

function storage(): ThemeStoreStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function profile(selectedThemeId: string | null): UserSessionsChangedEvent {
  return { type: 'user_sessions_changed', sessions: [], views: [], order: [], selectedSessionId: null, orderVersion: 0, selectedThemeId, fresh: false };
}

function setup() {
  let current = snapshot();
  const send = vi.fn(
    async (command: PimoteCommand): Promise<PimoteResponse> => ({
      id: '1',
      success: true,
      data: command.type === 'get_theme_catalog' ? current : undefined,
    }),
  );
  const apply = vi.fn();
  const cache = storage();
  const instance = new ThemeStore({ user: 'alice', send, storage: cache, apply });
  return {
    instance,
    send,
    apply,
    cache,
    changeCatalog: (next: ThemeCatalogSnapshot) => {
      current = next;
    },
  };
}

describe('ThemeStore', () => {
  it('requests and refreshes the catalog after a revision event', async () => {
    const { instance, send, changeCatalog } = setup();
    await instance.loadCatalog();
    expect(instance.catalog?.revision).toBe(4);
    changeCatalog({ ...snapshot(), revision: 5, defaultThemeId: 'pimote/dark' });
    await instance.handleCatalogChanged({ type: 'theme_catalog_changed', revision: 5 });
    expect(instance.catalog).toMatchObject({ revision: 5, defaultThemeId: 'pimote/dark' });
    expect(send).toHaveBeenCalledWith({ type: 'get_theme_catalog' });
  });

  it('previews the full theme locally and restores the saved palette on Cancel', async () => {
    const { instance, send, apply } = setup();
    await instance.loadCatalog();
    instance.handleProfile(profile('pimote/light'));
    instance.preview('alice/custom');
    expect(instance.selectedThemeId).toBe('pimote/light');
    expect(instance.activeTheme?.id).toBe('alice/custom');
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'alice/custom', ui: expect.any(Object), editor: expect.any(Object) }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_theme' }));
    instance.cancel();
    expect(instance.activeTheme?.id).toBe('pimote/light');
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pimote/light' }));
  });

  it('gates Save on reconciliation and session adoption', async () => {
    const { instance } = setup();
    await instance.loadCatalog();
    instance.preview('pimote/dark');
    expect(instance.saveDisabled).toBe(true);
    instance.handleProfile(profile('pimote/light'));
    expect(instance.saveDisabled).toBe(true);
    instance.sessionAdoptionComplete = true;
    instance.preview('pimote/dark');
    expect(instance.saveDisabled).toBe(false);
  });

  it('saves a preview and follows the server default when null is selected', async () => {
    const { instance, send } = setup();
    await instance.loadCatalog();
    instance.handleProfile(profile('pimote/light'));
    instance.sessionAdoptionComplete = true;
    instance.preview('alice/custom');
    await instance.save();
    expect(send).toHaveBeenCalledWith({ type: 'set_theme', themeId: 'alice/custom' });
    instance.handleProfile(profile('alice/custom'));
    instance.preview(null);
    await instance.save();
    expect(send).toHaveBeenCalledWith({ type: 'set_theme', themeId: null });
  });

  it('caches the active resolved theme for the user after profile reconciliation', async () => {
    const { instance, cache } = setup();
    await instance.loadCatalog();
    instance.handleProfile(profile('alice/custom'));
    const cached = cache.getItem(instance.cacheKey());
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toMatchObject({ id: 'alice/custom', ui: expect.any(Object), editor: expect.any(Object) });
  });

  it('retains a missing saved ID while applying the server default', async () => {
    const { instance, apply } = setup();
    await instance.loadCatalog();
    instance.handleProfile(profile('missing/theme'));
    expect(instance.selectedThemeId).toBe('missing/theme');
    expect(instance.activeTheme?.id).toBe('pimote/light');
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pimote/light' }));
  });
});
