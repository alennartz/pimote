// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { ResolvedTheme, ThemeCatalogSnapshot } from '@pimote/shared';
import AppearanceSettings from './AppearanceSettings.svelte';
import { ThemeStore } from '../stores/theme-store.svelte.js';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

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

function store(): ThemeStore {
  const snapshot: ThemeCatalogSnapshot = {
    revision: 1,
    defaultThemeId: 'pimote/light',
    themes: [theme('pimote/light'), theme('pimote/dark'), theme('alice/custom')],
    diagnostics: [],
  };
  return new ThemeStore({
    user: 'alice',
    send: async () => ({ id: '1', success: true, data: snapshot }),
    storage: { getItem: () => null, setItem: vi.fn() },
    apply: vi.fn(),
  });
}

async function render(viewport: 'desktop' | 'mobile') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const themeStore = store();
  component = mount(AppearanceSettings, { target, props: { store: themeStore, viewport } });
  await tick();
  return themeStore;
}

describe('Appearance settings', () => {
  it.each(['desktop', 'mobile'] as const)('shows the Appearance tab and paired UI/code previews on %s', async (viewport) => {
    await render(viewport);
    const panel = document.querySelector('[role="tabpanel"][aria-label="Appearance"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toMatch(/Color theme|interface|code/i);
    expect(panel?.querySelectorAll('button').length).toBeGreaterThanOrEqual(3);
  });

  it('offers Follow server default alongside built-in, extension, and user themes', async () => {
    await render('desktop');
    const labels = [...document.querySelectorAll('[role="tabpanel"][aria-label="Appearance"] button')].map((node) => node.textContent ?? '');
    expect(labels.join(' ')).toMatch(/Follow server default/);
    expect(labels.join(' ')).toMatch(/Pimote Light|Pimote Dark/);
    expect(labels.join(' ')).toMatch(/Alice Custom/);
  });

  it('previews locally, disables Save until reconciliation, and restores on Cancel', async () => {
    const themeStore = await render('desktop');
    const custom = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Alice Custom'));
    if (!custom) throw new Error('Missing custom theme button');
    custom.click();
    await tick();
    expect(themeStore.previewThemeId).toBe('alice/custom');
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Save theme'));
    if (!save) throw new Error('Missing Save theme button');
    expect(save.disabled).toBe(false);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Cancel');
    if (!cancel) throw new Error('Missing Cancel button');
    cancel.click();
    expect(themeStore.previewThemeId).toBe(themeStore.selectedThemeId);
  });

  it('saves the selected preview to the shared user and places mobile Save in the header', async () => {
    const themeStore = await render('mobile');
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Save theme'));
    if (!save) throw new Error('Missing Save theme button');
    save.click();
    await tick();
    expect(themeStore.selectedThemeId).toBe('alice/custom');
    expect(save.closest('header')).not.toBeNull();
  });
});
