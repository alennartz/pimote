// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse, ThemeCatalogSnapshot, UserSessionsChangedEvent } from '@pimote/shared';
import { resolvedTheme } from '../../../../shared/test/theme-fixtures.js';
import AppearanceSettings from './AppearanceSettings.svelte';
import { ThemeStore } from '../stores/theme-store.svelte.js';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

const snapshot: ThemeCatalogSnapshot = {
  revision: 1,
  defaultThemeId: 'pimote/light',
  themes: [
    resolvedTheme('pimote/light', 'Pimote Light'),
    resolvedTheme('pimote/dark', 'Pimote Dark'),
    resolvedTheme('publisher/night', 'Publisher Night', 'extension'),
    resolvedTheme('alice/custom', 'Alice Custom', 'user'),
  ],
  diagnostics: [],
};

function button(name: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => name.test(entry.getAttribute('aria-label') ?? entry.textContent ?? ''));
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function render(viewport: 'desktop' | 'mobile' = 'desktop') {
  const send = vi.fn(async (command: PimoteCommand): Promise<PimoteResponse> => ({ id: '1', success: true, data: command.type === 'get_theme_catalog' ? snapshot : undefined }));
  const apply = vi.fn();
  const store = new ThemeStore({ user: 'alice', send, storage: { getItem: () => null, setItem: () => {} }, apply });
  await store.loadCatalog();
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(AppearanceSettings, { target, props: { store, viewport } });
  await tick();
  return { store, send, apply };
}

function profile(selectedThemeId: string | null): UserSessionsChangedEvent {
  return { type: 'user_sessions_changed', sessions: [], views: [], order: [], selectedSessionId: null, orderVersion: 0, selectedThemeId, fresh: false };
}

describe('Appearance settings', () => {
  it('offers the default and all available theme sources', async () => {
    await render();
    expect(button(/Follow server default/i)).toBeTruthy();
    expect(button(/Pimote Light/i)).toBeTruthy();
    expect(button(/Publisher Night/i)).toBeTruthy();
    expect(button(/Alice Custom/i)).toBeTruthy();
  });

  it('previews on this device, gates Save, and restores the saved palette on Cancel', async () => {
    const { store, send, apply } = await render();
    button(/Alice Custom/i).click();
    await tick();
    expect(button(/Save theme/i).disabled).toBe(true);
    store.handleProfile(profile('pimote/light'));
    store.sessionAdoptionComplete = true;
    button(/Alice Custom/i).click();
    await tick();
    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toMatch(/preview/i);
    expect(status?.textContent).toMatch(/Alice Custom/i);
    expect(status?.textContent).toMatch(/other devices/i);
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'alice/custom' }));
    expect(button(/Save theme/i).disabled).toBe(false);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_theme' }));
    button(/^Cancel$/i).click();
    await tick();
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pimote/light' }));
  });

  it('saves the chosen theme and can clear the override', async () => {
    const { store, send } = await render();
    store.handleProfile(profile('pimote/light'));
    store.sessionAdoptionComplete = true;
    button(/Alice Custom/i).click();
    await tick();
    button(/Save theme/i).click();
    await tick();
    expect(send).toHaveBeenCalledWith({ type: 'set_theme', themeId: 'alice/custom' });
    store.handleProfile(profile('alice/custom'));
    button(/Follow server default/i).click();
    await tick();
    button(/Save theme/i).click();
    await tick();
    expect(send).toHaveBeenCalledWith({ type: 'set_theme', themeId: null });
  });

  it('cancels a preview when mobile settings close', async () => {
    const { store, send, apply } = await render('mobile');
    store.handleProfile(profile('pimote/light'));
    store.sessionAdoptionComplete = true;
    button(/Alice Custom/i).click();
    await tick();
    button(/Close/i).click();
    await tick();
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pimote/light' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_theme' }));
  });
});
