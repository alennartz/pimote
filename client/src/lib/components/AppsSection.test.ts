/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { AppInfo, PimoteCommand, PimoteResponse } from '@pimote/shared';
import { AppsStore } from '$lib/stores/apps-store.svelte.js';
import AppsSection from './AppsSection.svelte';

const APPS: AppInfo[] = [
  {
    slug: 'budget',
    title: 'Budget Tracker',
    description: 'Monthly spending ledger',
    target: 'http://127.0.0.1:4173',
    url: 'https://budget.apps.example.com',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  },
  {
    slug: 'notes',
    title: 'Quick Notes',
    target: 'http://127.0.0.1:4174',
    url: 'https://notes.apps.example.com',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  },
];

let destroy: (() => void) | undefined;

afterEach(async () => {
  await destroy?.();
  destroy = undefined;
  document.body.replaceChildren();
});

function renderSection(store: AppsStore, search = ''): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(AppsSection, { target, props: { store, search } });
  destroy = () => unmount(component);
  return target;
}

describe('AppsSection', () => {
  it('renders external new-tab links for registered apps', async () => {
    const store = new AppsStore({ send: vi.fn() });
    store.handleEvent({ type: 'apps_changed', apps: APPS, sync: { status: 'synced' } });

    const el = renderSection(store);
    await tick();

    const links = [...el.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('https://budget.apps.example.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links.map((link) => link.textContent)).toEqual([expect.stringContaining('Budget Tracker'), expect.stringContaining('Quick Notes')]);
  });

  it('displays sync error banner and triggers resync when clicked', async () => {
    const send = vi.fn(async (cmd: PimoteCommand): Promise<PimoteResponse> => {
      if (cmd.type === 'resync_apps') {
        return { id: '1', success: true, data: { sync: { status: 'synced' } } };
      }
      return { id: '0', success: false, error: 'unexpected' };
    });
    const store = new AppsStore({ send });
    store.handleEvent({
      type: 'apps_changed',
      apps: APPS,
      sync: { status: 'error', error: 'Caddy unreachable' },
    });

    const el = renderSection(store);
    await tick();

    expect(el.textContent).toContain('Caddy unreachable');
    const resyncButton = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Resync'));
    expect(resyncButton).toBeTruthy();
    resyncButton!.click();
    await tick();
    await Promise.resolve();
    await tick();

    expect(send).toHaveBeenCalledWith({ type: 'resync_apps' });
    expect(store.sync.status).toBe('synced');
  });

  it('requires confirmation before removing an app', async () => {
    const send = vi.fn(async (cmd: PimoteCommand): Promise<PimoteResponse> => {
      if (cmd.type === 'remove_app') {
        return { id: '1', success: true, data: { removed: true, sync: { status: 'synced' } } };
      }
      return { id: '0', success: false, error: 'unexpected' };
    });
    const store = new AppsStore({ send });
    store.handleEvent({ type: 'apps_changed', apps: [APPS[0]!], sync: { status: 'synced' } });

    const el = renderSection(store);
    await tick();

    const trashButton = el.querySelector('button[aria-label="Remove Budget Tracker"]') as HTMLButtonElement | null;
    expect(trashButton).toBeTruthy();
    trashButton!.click();
    await tick();

    expect(send).not.toHaveBeenCalled();

    const confirmButton = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove');
    expect(confirmButton).toBeTruthy();
    confirmButton!.click();
    await tick();
    await Promise.resolve();
    await tick();

    expect(send).toHaveBeenCalledWith({ type: 'remove_app', slug: 'budget' });
    expect(store.apps).toEqual([]);
  });
});
