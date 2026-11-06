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
const { default: FolderCreatorWizard } = await import('./FolderCreatorWizard.svelte');
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

const alpha = makeFolder({ path: '/roots/alpha', name: 'alpha' });
const ada = makeFolder({ path: '/roots/ada', name: 'ada', nature: 'persona' });

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return found;
}

function kindButton(kind: string): HTMLElement {
  const icon = document.querySelector(`[data-folder-icon="${kind}"]`);
  if (!icon) throw new Error(`kind icon not found: ${kind}`);
  return (icon.closest('button') ?? icon) as HTMLElement;
}

function fillName(name: string): void {
  const input = document.body.querySelector('input[placeholder="Folder name"]') as HTMLInputElement;
  if (!input) throw new Error('name input not found');
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FolderCreatorWizard, { target, props: {} });
  return () => unmount(component);
}

/** Walk to the code-hub Members phase. */
async function openMembersStep(): Promise<void> {
  kindButton('code-hub').click();
  await tick();
  fillName('platform');
  button('Next').click();
  await tick();
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(connection.send).mockClear();
  folderStore.folders = [alpha, ada];
  folderStore.roots = ['/roots'];
  vi.mocked(connection.send).mockImplementation(async (command: any) => {
    if (command.type === 'create_hub') {
      return { id: '1', success: true, data: { folderPath: `/roots/${command.name}` } };
    }
    return { id: '1', success: true, data: {} };
  });
});

afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
});

describe('FolderCreatorWizard — code member layout choice', () => {
  it('offers Symlinks and Detached worktrees in the hub Members phase', async () => {
    destroy = render();
    await openMembersStep();

    expect(button('Symlinks')).toBeTruthy();
    expect(button('Detached worktrees')).toBeTruthy();
  });

  it('states in the helper text that personas always use symlinks', async () => {
    destroy = render();
    await openMembersStep();
    button('Detached worktrees').click();
    await tick();

    expect((document.body.textContent ?? '').toLowerCase()).toContain('symlink');
  });

  it('sends create_hub with detached-worktree representation when that layout is chosen', async () => {
    destroy = render();
    await openMembersStep();

    button('Detached worktrees').click();
    await tick();
    const row = [...document.querySelectorAll<HTMLElement>('button, label')].find((el) => el.querySelector('input[type="checkbox"]') && el.textContent?.includes('alpha'));
    if (!row) throw new Error('picker row not found: alpha');
    row.click();
    button('Next').click();
    await tick();
    button('Create').click();

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_hub', name: 'platform', memberRepresentation: 'worktree' })));
  });
});
