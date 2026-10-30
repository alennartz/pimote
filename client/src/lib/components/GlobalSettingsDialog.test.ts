// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import GlobalSettingsDialog from './GlobalSettingsDialog.svelte';
import { GlobalSettingsStore } from '../stores/global-settings.svelte.js';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

async function render(viewport: 'desktop' | 'mobile' = 'desktop', surface: 'home' | 'conversation' = 'home') {
  const store = new GlobalSettingsStore(async (command) => {
    if (command.type === 'get_global_settings')
      return {
        id: '1',
        success: true,
        data: {
          files: [
            { path: '/agent/AGENTS.md', label: 'AGENTS.md' },
            { path: '/config.json', label: 'config.json' },
          ],
        },
      };
    return { id: '1', success: true, data: { path: '/agent/AGENTS.md', exists: command.type === 'file_get' && command.path !== '/config.json', content: '' } };
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(GlobalSettingsDialog, { target, props: { store, viewport, surface, snippets: ['note'] } });
  await tick();
  return store;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

describe('Settings dialog rendering', () => {
  it.each(['desktop', 'mobile'] as const)('opens the %s home overlay through its accessible gear', async (viewport) => {
    await render(viewport);
    const gear = document.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]');
    expect(gear).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    gear!.click();
    await tick();
    await tick();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  });

  it('omits the home gear on conversation surfaces', async () => {
    await render('desktop', 'conversation');
    expect(document.querySelector('[aria-label="Open Settings"]')).toBeNull();
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
