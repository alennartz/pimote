// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
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
const { default: NewSessionDialog } = await import('./NewSessionDialog.svelte');
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

const alpha = makeFolder({ path: '/w/alpha', name: 'alpha' });
const persona = makeFolder({
  path: '/w/personas/ada-dir',
  name: 'ada-dir',
  nature: 'persona',
  persona: { name: 'Ada', description: 'Research assistant' },
});

let destroy: (() => void) | null = null;

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(NewSessionDialog, { target, props: { open: true } });
  return () => unmount(component);
}

function shows(text: string): boolean {
  return (document.body.textContent ?? '').includes(text);
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return found;
}

/** Picker rows carry the name plus the path — match on contained text. */
function rowButton(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`row not found: ${text}`);
  return found;
}

beforeEach(() => {
  folderStore.folders = [alpha, persona];
  folderStore.roots = ['/roots'];
});

afterEach(() => {
  destroy?.();
  destroy = null;
  vi.mocked(connection.send).mockImplementation(async () => ({ id: '1', success: true, data: {} }));
  document.body.innerHTML = '';
});

describe('folder picker', () => {
  it('lists discovered folders and opens a session on selection', async () => {
    destroy = render();
    await tick();

    expect(shows('alpha')).toBe(true);
    expect(shows('Ada')).toBe(true);

    rowButton('alpha').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/w/alpha' }));
  });

  it('persona display names are discoverable in the picker search', async () => {
    destroy = render();
    await tick();

    const input = document.body.querySelector('input[placeholder="Search folders"]') as HTMLInputElement;
    input.value = 'ada';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    expect(shows('Ada')).toBe(true);
    expect(shows('alpha')).toBe(false);
    expect(shows('No matching folders.')).toBe(false);
  });
});

describe('folder creation', () => {
  it('sends create_folder with the chosen root and name, then opens the session', async () => {
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'create_folder') return { id: '1', success: true, data: { folderPath: '/roots/beta' } };
      if (command.type === 'list_folders') return { id: '1', success: true, data: { folders: [alpha, persona], roots: ['/roots'] } };
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    button('Create new folder').click();
    await tick();
    // Single configured root skips the root-selection step.
    expect(shows('New folder in')).toBe(true);

    const input = document.body.querySelector('input[placeholder="Folder name"]') as HTMLInputElement;
    input.value = 'beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    button('Create').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'create_folder', root: '/roots', name: 'beta' }));
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/roots/beta' }));
  });

  it('falls back to folder vocabulary on creation failure', async () => {
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'create_folder') return { id: '1', success: false, error: 'boom' };
      if (command.type === 'list_folders') return { id: '1', success: true, data: { folders: [alpha, persona], roots: ['/roots'] } };
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    button('Create new folder').click();
    await tick();

    const input = document.body.querySelector('input[placeholder="Folder name"]') as HTMLInputElement;
    input.value = 'beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    button('Create').click();
    await vi.waitFor(() => expect(shows('boom')).toBe(true));
  });
});
