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

const adaFolder = makeFolder({ path: '/w/ada', name: 'ada', nature: 'persona', persona: { name: 'Ada' } });
const otherFolder = makeFolder({ path: '/w/other', name: 'other', nature: 'persona' });

// Registry hub with one persona member.
const hub = makeFolder({
  path: '/w/stack',
  name: 'stack',
  shortcutCount: 1,
  members: [{ path: '/w/ada', name: 'ada', nature: 'persona' }],
});

function shows(text: string): boolean {
  return (document.body.textContent ?? '').includes(text);
}

function checkboxRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, label')].filter((el) => el.querySelector('input[type="checkbox"]'));
}

function checkboxRow(name: string): HTMLElement {
  const found = checkboxRows().find((el) => el.textContent?.includes(name));
  if (!found) throw new Error(`picker row not found: ${name}`);
  return found;
}

function removeButton(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Remove ${name}`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`remove button not found: ${name}`);
  return found;
}

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(HubMembersDialog, { target, props: { hub } });
  return () => unmount(component);
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  folderStore.folders = [adaFolder, otherFolder];
  vi.mocked(connection.send).mockReset();
  vi.mocked(connection.send).mockResolvedValue({ id: '1', success: true, data: {} });
});

afterEach(async () => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
  await drainBodyScrollLockCleanup();
});

describe('HubMembersDialog', () => {
  it('opens with the one comprehension header line', () => {
    destroy = render();

    expect(shows('a hub is a folder composed of shortcuts to its members')).toBe(true);
  });

  it('lists current members with remove buttons that remove by path', async () => {
    destroy = render();
    await tick();

    expect(shows('ada')).toBe(true);
    removeButton('ada').click();
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'remove_hub_member', hubPath: '/w/stack', memberPath: '/w/ada' }));
  });

  it('offers discovered folders minus current members as checkbox candidates', () => {
    destroy = render();

    expect(checkboxRow('other')).toBeTruthy();
    expect(checkboxRows().some((el) => el.textContent?.includes('ada'))).toBe(false);
  });

  it.each(['add_hub_member', 'remove_hub_member'])('shows a server rejection from %s', async (type) => {
    vi.mocked(connection.send).mockResolvedValue({ id: '1', success: false, error: 'Member change refused' });
    destroy = render();
    await tick();
    if (type === 'add_hub_member') checkboxRow('other').click();
    else removeButton('ada').click();
    await vi.waitFor(() => expect(shows('Member change refused')).toBe(true));
  });

  it('adds a picked persona candidate by path', async () => {
    destroy = render();
    await tick();

    checkboxRow('other').click();
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_hub_member', hubPath: '/w/stack', memberPath: '/w/other' }));
  });
});
