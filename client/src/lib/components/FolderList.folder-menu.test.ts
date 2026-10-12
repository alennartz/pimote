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
const { fileEditorStore } = await import('$lib/stores/file-editor.svelte.js');

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

const alpha = makeFolder({ path: '/w/alpha', name: 'alpha' });
const archivedRow = makeFolder({ path: '/w/old', name: 'old', archived: true });

const memberRepo = { path: '/w/one', name: 'one', branch: null, dirty: false, ahead: 0, behind: 0, missing: false };
const hub = makeFolder({ path: '/w/stack', name: 'stack', shortcutCount: 1, repos: [memberRepo], members: [{ path: '/w/one', name: 'one', nature: 'code' }] });
const shortcutHub = makeFolder({ path: '/w/shortcuts', name: 'shortcuts', shortcutCount: 1 });
const emptyHub = makeFolder({ path: '/w/empty', name: 'empty', members: [], repos: [] });

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
  folderStore.folders = [alpha];
  folderStore.loading = false;
  folderStore.showArchived = false;
  folderStore.repos = [];
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

describe('row context menu — hub membership', () => {
  it.each([shortcutHub, emptyHub])('offers member management on $name without relying on repos', async (folder) => {
    folderStore.folders = [folder];
    destroy = render();
    await tick();
    openMenu(folder.path);
    await tick();
    expect(menuItem('Manage members…')).not.toBeNull();
    expect(menuItem('Disband hub')).toBeNull();
  });
  it('offers "Manage members…" on hub rows only', async () => {
    folderStore.folders = [hub, alpha];
    destroy = render();
    await tick();

    openMenu(hub.path);
    await tick();
    requireMenuItem('Manage members…');

    openMenu(alpha.path);
    await tick();
    expect(menuItem('Manage members…')).toBeNull();
  });

  it('selecting "Manage members…" opens the hub members dialog', async () => {
    folderStore.folders = [hub];
    destroy = render();
    await tick();

    openMenu(hub.path);
    await tick();
    requireMenuItem('Manage members…').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect((document.body.textContent ?? '').includes('a hub is a folder composed of shortcuts to its members')).toBe(true);
  });
});

describe('row context menu — folder editor', () => {
  it('opens instructions for the selected folder, not global instructions', async () => {
    const open = vi.spyOn(fileEditorStore, 'openFolderInstructions').mockResolvedValue();
    destroy = render();
    await tick();
    openMenu(alpha.path);
    await tick();
    requireMenuItem('Edit AGENTS.md…').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(open).toHaveBeenCalledWith(alpha.path, alpha.name);
  });
});

describe('row context menu — archive and restore', () => {
  it('"Archive project" archives the folder through update_folder', async () => {
    const sessions = [{ id: 's1', name: 'Session', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', messageCount: 1, archived: false }];
    folderStore.sessions.set(alpha.path, sessions);
    destroy = render();
    await tick();

    openMenu(alpha.path);
    await tick();
    requireMenuItem('Archive project').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_folder', folderPath: '/w/alpha', archived: true }));
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'archive_session' }));
    expect(folderStore.sessions.get(alpha.path)).toEqual(sessions);
    expect(sessions[0].archived).toBe(false);
  });

  it('archived rows offer "Restore project" which restores through update_folder', async () => {
    folderStore.folders = [archivedRow];
    folderStore.showArchived = true;
    destroy = render();
    await tick();

    openMenu(archivedRow.path);
    await tick();
    requireMenuItem('Restore project').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_folder', folderPath: '/w/old', archived: false }));
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'archive_session' }));
  });
});
