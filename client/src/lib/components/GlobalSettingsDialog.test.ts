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

/** Open the mobile pane picker and choose one pane by its label. */
async function choosePane(label: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Settings pane:"]');
  if (!trigger) throw new Error('Missing settings pane picker');
  trigger.click();
  await tick();
  await tick();
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((node) => node.textContent?.trim().startsWith(label));
  if (!item) throw new Error(`Missing settings pane: ${label}`);
  item.click();
  await tick();
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

  it('renders desktop tabs, dirty state, and a missing-file creation hint without a visible Settings title', async () => {
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
    await choosePane('Appearance');
    expect(document.querySelector('[role="tabpanel"][aria-label="Appearance"]')).not.toBeNull();
    const body = document.querySelector<HTMLElement>('[role="dialog"] form > div.min-h-0.flex-1.overflow-hidden');
    expect(body?.classList.contains('flex')).toBe(true);
    expect(body?.classList.contains('flex-col')).toBe(true);
  });

  it('keeps the desktop tab strip to four files plus an overflow menu', async () => {
    const files = [
      { path: '/one.json', label: 'one.json' },
      { path: '/two.json', label: 'two.json' },
      { path: '/three.json', label: 'three.json' },
      { path: '/four.json', label: 'four.json' },
      { path: '/five.json', label: 'five.json' },
      { path: '/six.json', label: 'six.json' },
    ];
    const directFileCount = 4;
    const store = await render('desktop', null, files);
    await store.loadManifest();
    await tick();

    const tabs = document.querySelector('[aria-label="Settings files"]');
    expect(tabs?.textContent).toContain(files[directFileCount - 1].label);
    expect(tabs?.textContent).not.toContain(files[directFileCount].label);

    const more = document.querySelector<HTMLButtonElement>('button[aria-label^="More settings files"]');
    expect(more).not.toBeNull();
    more?.click();
    await tick();
    await tick();
    const menuItems = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
    const items = menuItems.map((item) => item.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(files.slice(directFileCount).map((file) => file.label)));
    const selectedFile = files[directFileCount];
    menuItems.find((item) => item.textContent?.trim() === selectedFile.label)?.click();
    await tick();
    expect(store.activePath).toBe(selectedFile.path);
    expect(more?.getAttribute('aria-label')).toContain(`current ${selectedFile.label}`);
    button('User').click();
    await tick();
    expect(more?.getAttribute('aria-label')).toBe('More settings files');
  });

  it('reaches every settings pane from the mobile picker', async () => {
    const files = [
      { path: '/one.json', label: 'one.json' },
      { path: '/two.json', label: 'two.json' },
      { path: '/three.json', label: 'three.json' },
      { path: '/four.json', label: 'four.json' },
      { path: '/five.json', label: 'five.json' },
      { path: '/six.json', label: 'six.json' },
    ];
    const store = await render('mobile', null, files);
    await store.loadManifest();
    await tick();

    expect(document.querySelector('button[aria-label^="More settings files"]')).toBeNull();
    await choosePane('six.json');
    expect(store.activePath).toBe('/six.json');
    expect(document.querySelector('button[aria-label^="Settings pane: six.json"]')).not.toBeNull();

    store.edit('/six.json', 'draft');
    await tick();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Settings pane:"]');
    expect(trigger?.textContent).toContain('*');
    expect(trigger?.getAttribute('aria-label')).toContain('unsaved changes');
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

  it('keeps tag insertion reachable on mobile', async () => {
    const store = await render('mobile');
    await store.loadManifest();
    await store.select('/agent/AGENTS.md');
    await tick();
    button('Tag').click();
    await tick();
    expect(document.querySelector('input[aria-label="Tag name"]')).not.toBeNull();
    expect(button('Wrap')).toBeTruthy();
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
