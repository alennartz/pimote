/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { AppInfo } from '@pimote/shared';
import { AppsStore } from '$lib/stores/apps-store.svelte.js';
import AppTiles from './AppTiles.svelte';

const APPS: AppInfo[] = [
  {
    slug: 'budget',
    title: 'Budget Tracker',
    icon: 'https://cdn.example.com/budget.png',
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

function renderTiles(store: AppsStore, search = ''): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(AppTiles, { target, props: { store, search } });
  destroy = () => unmount(component);
  return target;
}

describe('AppTiles', () => {
  it('renders one new-tab link per app with icon and name', async () => {
    const store = new AppsStore({ send: vi.fn() });
    store.handleEvent({ type: 'apps_changed', apps: APPS, sync: { status: 'synced' } });

    const el = renderTiles(store);
    await tick();

    const links = [...el.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('https://budget.apps.example.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.textContent).toContain('Budget Tracker');

    const icons = [...el.querySelectorAll('img')];
    expect(icons.map((icon) => icon.getAttribute('src'))).toEqual(['/app-icons/budget', 'https://notes.apps.example.com/favicon.ico']);
  });

  it('shows the letter tile for an app whose icon candidates all fail', async () => {
    const store = new AppsStore({ send: vi.fn() });
    store.handleEvent({ type: 'apps_changed', apps: [APPS[1]!], sync: { status: 'synced' } });

    const el = renderTiles(store);
    await tick();

    const icon = el.querySelector('img') as HTMLImageElement;
    expect(icon).toBeTruthy();
    icon.dispatchEvent(new Event('error'));
    await tick();

    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('Q');
  });

  it('filters tiles by search query', async () => {
    const store = new AppsStore({ send: vi.fn() });
    store.handleEvent({ type: 'apps_changed', apps: APPS, sync: { status: 'synced' } });

    const el = renderTiles(store, 'budget');
    await tick();

    const links = [...el.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('Budget Tracker');
  });

  it('renders nothing when no apps are registered', async () => {
    const store = new AppsStore({ send: vi.fn() });
    store.handleEvent({ type: 'apps_changed', apps: [], sync: { status: 'synced' } });

    const el = renderTiles(store);
    await tick();

    expect(el.querySelector('section')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });
});
