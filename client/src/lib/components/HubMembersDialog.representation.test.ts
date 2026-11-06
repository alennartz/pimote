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
const { default: HubMembersDialog } = await import('./HubMembersDialog.svelte');
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

const hub = makeFolder({
  path: '/w/platform',
  name: 'platform',
  shortcutCount: 0,
  hub: { representation: 'worktree' },
  members: [
    { path: '/w/one', name: 'one', nature: 'code', representation: 'worktree', worktreePath: '/w/platform/one' },
    { path: '/w/ada', name: 'ada', nature: 'persona', representation: 'symlink' },
  ],
});
const web = makeFolder({ path: '/w/web', name: 'web' });

function render(hubRow: FolderInfo) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(HubMembersDialog, { target, props: { hub: hubRow } });
  return () => unmount(component);
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(connection.send).mockClear();
  folderStore.folders = [hub, web];
  folderStore.roots = [];
  folderStore.loading = false;
  folderStore.showArchived = false;
  folderStore.sessions.clear();
});

afterEach(async () => {
  destroy?.();
  destroy = null;
  vi.mocked(connection.send).mockClear();
  document.body.innerHTML = '';
  await drainBodyScrollLockCleanup();
});

describe('HubMembersDialog — member representation display', () => {
  it('lists a code worktree member with its nested checkout path', async () => {
    destroy = render(hub);
    await tick();

    const text = document.body.textContent ?? '';
    expect(text).toContain('one');
    expect(text).toContain('/w/platform/one');
    expect(text.toLowerCase()).toContain('worktree');
  });

  it('distinguishes a persona symlink member from a code worktree member', async () => {
    destroy = render(hub);
    await tick();

    const text = document.body.textContent ?? '';
    expect(text).toContain('ada');
    expect(text).toContain('/w/ada');
    // The persona member's row states its symlink representation.
    expect(text.toLowerCase()).toContain('symlink');
  });

  it('shows the representation a new code member will use in this hub', async () => {
    destroy = render(hub);
    await tick();

    // The add-member picker states that code members join as detached
    // worktrees in a worktree hub.
    expect((document.body.textContent ?? '').toLowerCase()).toContain('worktree');
  });
});
