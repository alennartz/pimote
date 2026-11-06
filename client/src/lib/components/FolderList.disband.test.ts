// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';
import type { FolderInfo } from '@pimote/shared';

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

const { connection } = await import('$lib/stores/connection.svelte.js');
const { default: FolderList } = await import('./FolderList.svelte');
const { folderStore } = await import('$lib/stores/folder-store.svelte.js');

function makeFolder(overrides: Partial<FolderInfo> & Pick<FolderInfo, 'path' | 'name'>): FolderInfo {
  return {
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...overrides,
  };
}

const memberRepo = { path: '/w/one', name: 'one', branch: null, dirty: false, ahead: 0, behind: 0, missing: false };
const worktreeHub = makeFolder({
  path: '/w/platform',
  name: 'platform',
  shortcutCount: 0,
  hub: { representation: 'worktree' },
  repos: [memberRepo],
  members: [{ path: '/w/one', name: 'one', nature: 'code', representation: 'worktree', worktreePath: '/w/platform/one' }],
});
const symlinkHub = makeFolder({
  path: '/w/stack',
  name: 'stack',
  shortcutCount: 1,
  members: [{ path: '/w/one', name: 'one', nature: 'code', representation: 'symlink' }],
});
/** A promised worktree hub: the hub fact is the only hub signal — no members
 *  and no shortcut occurrences yet. */
const promisedWorktreeHub = makeFolder({ path: '/w/promised', name: 'promised', shortcutCount: 0, hub: { representation: 'worktree' } });

let target: HTMLDivElement;

function render() {
  target = document.createElement('div');
  target.style.height = '800px';
  Object.defineProperties(target, {
    offsetHeight: { value: 800 },
    offsetWidth: { value: 600 },
  });
  document.body.appendChild(target);
  const component = mount(FolderList, { target, props: { scrollElement: target } });
  return () => unmount(component);
}

function nameButton(path: string): HTMLButtonElement {
  const button = target.querySelector(`[data-folder-path="${path}"]`)?.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error(`folder row button not found: ${path}`);
  return button;
}

function menuItem(label: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find((item) => item.textContent?.trim() === label) ?? null;
}

function requireMenuItem(label: string): HTMLElement {
  const item = menuItem(label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

function openMenu(path: string) {
  nameButton(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  folderStore.folders = [worktreeHub];
  folderStore.loading = false;
  folderStore.showArchived = false;
  folderStore.roots = [];
  folderStore.sessions.clear();
});

afterEach(async () => {
  destroy?.();
  destroy = null;
  vi.mocked(connection.send).mockClear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  await drainBodyScrollLockCleanup();
});

describe('row context menu — guarded worktree disband', () => {
  it('offers "Disband worktree hub…" on worktree hubs and not on symlink hubs', async () => {
    folderStore.folders = [worktreeHub, symlinkHub];
    destroy = render();
    await tick();

    openMenu(worktreeHub.path);
    await tick();
    requireMenuItem('Disband worktree hub…');

    openMenu(symlinkHub.path);
    await tick();
    expect(menuItem('Disband worktree hub…')).toBeNull();
  });

  it('identifies hubs from the hub fact rather than shortcut count alone', async () => {
    folderStore.folders = [promisedWorktreeHub];
    destroy = render();
    await tick();

    // No members and no shortcut occurrences; the hub fact alone makes this
    // a hub row.
    openMenu(promisedWorktreeHub.path);
    await tick();
    requireMenuItem('Manage members…');
  });

  it('asks for confirmation stating nested worktrees are removed without merging or deleting branches', async () => {
    folderStore.folders = [worktreeHub];
    destroy = render();
    await tick();

    openMenu(worktreeHub.path);
    await tick();
    requireMenuItem('Disband worktree hub…').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    const text = document.body.textContent ?? '';
    expect(text).toContain('worktree');
    expect(text).toContain('merge');
  });

  it('sends disband_hub with the hub path on confirmation', async () => {
    folderStore.folders = [worktreeHub];
    destroy = render();
    await tick();

    openMenu(worktreeHub.path);
    await tick();
    requireMenuItem('Disband worktree hub…').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Disband');
    if (!confirm) throw new Error('confirm button not found');
    confirm.click();
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'disband_hub', hubPath: '/w/platform' }));
  });

  it('keeps the dialog open and lists the blocking state when validation fails', async () => {
    vi.mocked(connection.send).mockImplementation(async () => ({ id: '1', success: false, error: 'Cannot disband: one has uncommitted changes' }));
    folderStore.folders = [worktreeHub];
    destroy = render();
    await tick();

    openMenu(worktreeHub.path);
    await tick();
    requireMenuItem('Disband worktree hub…').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Disband');
    if (!confirm) throw new Error('confirm button not found');
    confirm.click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'disband_hub' })));
    await tick();

    expect(document.body.textContent ?? '').toContain('uncommitted changes');
    // The confirmation dialog is still open: the Disband button is present.
    expect([...document.body.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Disband')).toBe(true);
  });
});
