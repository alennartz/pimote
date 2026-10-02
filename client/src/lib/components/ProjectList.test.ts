// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { ProjectInfo } from '@pimote/shared';

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

vi.mock('$lib/stores/connection.svelte.js', () => {
  // Module-scope stores register listeners (onEvent/onDisconnect/…) at import
  // time; answer any such call with a no-op spy.
  const base: Record<string, unknown> = { status: 'connected', send: vi.fn(async () => ({ success: true, data: {} })) };
  const connection = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      const fn = vi.fn();
      target[prop] = fn;
      return fn;
    },
  });
  return { connection };
});

const { default: ProjectList } = await import('./ProjectList.svelte');
const { projectStore } = await import('$lib/stores/project-store.svelte.js');

const alpha: ProjectInfo = {
  path: '/w/alpha',
  name: 'alpha',
  kind: 'single',
  activeSessionCount: 0,
  externalProcessCount: 0,
};

let target: HTMLDivElement;

function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ProjectList, { target });
  return () => unmount(component);
}

function rowNameButton(): HTMLButtonElement {
  const button = target.querySelector('[data-project-name]')?.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('project row button not found');
  return button;
}

function menuItem(): Element | null {
  return document.querySelector('[data-slot="context-menu-item"]');
}

function isExpanded(): boolean {
  return (target.textContent ?? '').includes('No sessions yet');
}

function openMenu() {
  rowNameButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  projectStore.projects = [alpha];
  projectStore.loading = false;
  projectStore.showArchived = false;
  projectStore.repos = [];
  projectStore.roots = [];
  projectStore.sessions.clear();
  projectStore.sessions.set(alpha.path, []);
});

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
});

describe('project rows', () => {
  it('starts collapsed and expands on tap', async () => {
    destroy = render();
    await tick();
    expect(isExpanded()).toBe(false);

    rowNameButton().click();
    await tick();
    expect(isExpanded()).toBe(true);
  });

  it('opens the project context menu on right-click / long-press', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    expect(menuItem()).not.toBeNull();
    expect(isExpanded()).toBe(false);
  });

  it('swallows the release click that follows a long-press, then behaves normally', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    expect(menuItem()).not.toBeNull();

    // The long-press fires while the finger is down; the release still emits a
    // click on the row. It must not toggle the project behind the open menu.
    rowNameButton().click();
    await tick();
    expect(isExpanded()).toBe(false);

    // The suppression is one-shot: the next, deliberate tap works.
    rowNameButton().click();
    await tick();
    expect(isExpanded()).toBe(true);
  });

  it('opens the Add tag dialog from the menu item', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    const item = menuItem();
    expect(item).not.toBeNull();

    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(document.body.textContent).toContain('Tag the project');
    expect(document.body.textContent).toContain('alpha');
  });
});
