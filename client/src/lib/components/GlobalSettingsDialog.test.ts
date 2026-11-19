// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';
import GlobalSettingsDialog from './GlobalSettingsDialog.svelte';
import { GlobalSettingsStore } from '../stores/global-settings.svelte.js';
import { ThemeStore } from '../stores/theme-store.svelte.js';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  await drainBodyScrollLockCleanup();
});

async function render(
  viewport: 'desktop' | 'mobile' = 'desktop',
  themeStore: ThemeStore | null = null,
  files = [
    { path: '/agent/AGENTS.md', label: 'AGENTS.md' },
    { path: '/config.json', label: 'config.json' },
  ],
) {
  const store = new GlobalSettingsStore(async (command) => {
    if (command.type === 'get_global_settings')
      return {
        id: '1',
        success: true,
        data: { files },
      };
    return { id: '1', success: true, data: { path: '/agent/AGENTS.md', exists: command.type === 'file_get' && command.path !== '/config.json', content: '' } };
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(GlobalSettingsDialog, { target, props: { store, viewport, snippets: ['note'], themeStore } });
  await tick();
  return store;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

describe('Settings dialog rendering', () => {
  it('does not render a floating trigger', async () => {
    await render();
    expect(document.querySelector('[aria-label="Open Settings"]')).toBeNull();
  });

  it.each(['desktop', 'mobile'] as const)('opens the %s overlay when its store is opened', async (viewport) => {
    const store = await render(viewport);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await store.loadManifest();
    await tick();
    await tick();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  });

  it('renders tabs, dirty state, and a missing-file creation hint without a visible Settings title', async () => {
    const store = await render();
    await store.loadManifest();
    await store.select('/agent/AGENTS.md');
    store.edit('/agent/AGENTS.md', 'draft');
    await tick();
    const tabs = document.querySelector('[aria-label="Settings files"]');
    expect(tabs?.textContent).toContain('AGENTS.md');
    expect(tabs?.textContent).toContain('config.json');
    expect(tabs?.textContent).toMatch(/unsaved|\*/i);
    expect([...document.querySelectorAll('h1,h2,h3')].some((node) => node.textContent?.trim() === 'Settings')).toBe(false);
    await store.select('/config.json');
    await tick();
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/new file|created.*sav|sav.*creat/i);
  });

  it('constrains the Appearance pane inside the scrollable dialog body', async () => {
    const themeStore = new ThemeStore({
      user: 'test',
      send: async () => ({ id: '1', success: true }),
      storage: { getItem: () => null, setItem: () => {} },
      apply: () => {},
    });
    const store = await render('mobile', themeStore);
    await store.loadManifest();
    button('Appearance').click();
    await tick();
    expect(document.querySelector('[role="tabpanel"][aria-label="Appearance"]')).not.toBeNull();
    const body = document.querySelector<HTMLElement>('[role="dialog"] form > div.min-h-0.flex-1.overflow-hidden');
    expect(body?.classList.contains('flex')).toBe(true);
    expect(body?.classList.contains('flex-col')).toBe(true);
  });

  it.each(['desktop', 'mobile'] as const)('moves excess settings files into a More files menu on %s', async (viewport) => {
    const files = [
      { path: '/one.json', label: 'one.json' },
      { path: '/two.json', label: 'two.json' },
      { path: '/three.json', label: 'three.json' },
      { path: '/four.json', label: 'four.json' },
      { path: '/five.json', label: 'five.json' },
      { path: '/six.json', label: 'six.json' },
    ];
    const store = await render(viewport, null, files);
    await store.loadManifest();
    await tick();

    const tabs = document.querySelector('[aria-label="Settings files"]');
    expect(tabs?.textContent).toContain('one.json');
    expect(tabs?.textContent).toContain('four.json');
    expect(tabs?.textContent).not.toContain('five.json');

    const more = document.querySelector<HTMLButtonElement>('button[aria-label^="More settings files"]');
    expect(more).not.toBeNull();
    more?.click();
    await tick();
    await tick();
    const menuItems = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
    const items = menuItems.map((item) => item.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(['five.json', 'six.json']));
    menuItems.find((item) => item.textContent?.trim() === 'five.json')?.click();
    await tick();
    expect(store.activePath).toBe('/five.json');
    expect(more?.getAttribute('aria-label')).toContain('current five.json');
    button('User').click();
    await tick();
    expect(more?.getAttribute('aria-label')).toBe('More settings files');
  });

  it('shows the Tag row only for Markdown tabs', async () => {
    const store = await render();
    await store.loadManifest();
    await store.select('/agent/AGENTS.md');
    await tick();
    expect(button('Tag')).toBeTruthy();
    await store.select('/config.json');
    await tick();
    expect([...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Tag')).toBe(false);
  });

  it.each(['desktop', 'mobile'] as const)('renders %s per-file actions in the approved location', async (viewport) => {
    const store = await render(viewport);
    await store.loadManifest();
    await store.select('/agent/AGENTS.md');
    await tick();
    expect(button('Save').disabled).toBe(true);
    store.edit('/agent/AGENTS.md', 'draft');
    await tick();
    const close = button(viewport === 'desktop' ? 'Cancel' : 'Close');
    const region = viewport === 'desktop' ? 'footer' : 'header';
    expect(close.closest(region)).not.toBeNull();
    expect(button('Save').closest(region)).not.toBeNull();
    expect(button('Save').disabled).toBe(false);
    close.click();
    await tick();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Discard unsaved changes?');
    button('Keep editing').click();
    await tick();
    expect(store.open).toBe(true);
    expect(store.hasDirtyDrafts()).toBe(true);
  });
});
