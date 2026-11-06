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

function removeButton(name: string): HTMLButtonElement {
  const found = document.querySelector(`button[aria-label="Remove ${name}"]`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`remove button not found: ${name}`);
  return found;
}

function memberRow(name: string, path: string): HTMLElement {
  let row: HTMLElement | null = removeButton(name).parentElement;
  while (row && !(row.textContent?.includes(name) && row.textContent.includes(path))) row = row.parentElement;
  if (!row || row.querySelectorAll('button[aria-label^="Remove "]').length !== 1) throw new Error(`member row not found: ${name}`);
  return row;
}

function pickerRow(name: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('button, label')].find((el) => el.querySelector('input[type="checkbox"]') && el.textContent?.includes(name));
  if (!row) throw new Error(`picker row not found: ${name}`);
  return row;
}

function pickerSection(): HTMLElement {
  const search = document.querySelector('input[placeholder="Search folders"]');
  if (!search) throw new Error('member search not found');
  let section: HTMLElement | null = search.parentElement;
  while (section && !(section.textContent?.includes('Add member') && section.contains(pickerRow('web')))) section = section.parentElement;
  if (!section || section.querySelector('button[aria-label^="Remove "]')) throw new Error('add-member section not found');
  return section;
}

function render(hubRow: FolderInfo) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(HubMembersDialog, { target, props: { hub: hubRow } });
  return () => unmount(component);
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(connection.send).mockReset();
  vi.mocked(connection.send).mockResolvedValue({ id: '1', success: true, data: {} });
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

    const text = memberRow('one', '/w/one').textContent ?? '';
    expect(text).toContain('/w/platform/one');
    expect(text).toMatch(/worktree/i);
  });

  it('distinguishes a persona symlink member from a code worktree member', async () => {
    destroy = render(hub);
    await tick();

    const text = memberRow('ada', '/w/ada').textContent ?? '';
    expect(text).toMatch(/symlink/i);
    expect(text).not.toMatch(/worktree/i);
  });

  it('shows the representation a new code member will use in this hub', async () => {
    destroy = render(hub);
    await tick();

    expect(pickerSection().textContent ?? '').toMatch(/(?:code[^.]*worktree|worktree[^.]*code)/i);
  });

  it('still adds and removes members by their canonical paths', async () => {
    destroy = render(hub);
    await tick();

    pickerRow('web').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_hub_member', hubPath: '/w/platform', memberPath: '/w/web' })));
    removeButton('one').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'remove_hub_member', hubPath: '/w/platform', memberPath: '/w/one' })));
  });
});
