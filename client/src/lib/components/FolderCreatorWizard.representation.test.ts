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

function kindButton(): HTMLButtonElement {
  const found = document.querySelector('button[aria-label="New code hub"]');
  if (!(found instanceof HTMLButtonElement)) throw new Error('code hub button not found');
  return found;
}

function layoutDescription(): string {
  const symlinks = button('Symlinks');
  let section: HTMLElement | null = symlinks.parentElement;
  while (section) {
    if (section.contains(button('Detached worktrees'))) {
      const helper = [...section.querySelectorAll<HTMLElement>('p, div, span')].find(
        (el) => !el.querySelector('button, input') && /persona[^.]*symlink/i.test(el.textContent ?? ''),
      );
      if (helper) return helper.textContent ?? '';
    }
    section = section.parentElement;
  }
  throw new Error('layout description not found');
}

function selectMember(name: string): void {
  const row = [...document.querySelectorAll<HTMLElement>('button, label')].find((el) => el.querySelector('input[type="checkbox"]') && el.textContent?.includes(name));
  if (!row) throw new Error(`picker row not found: ${name}`);
  row.click();
}

async function createHub(): Promise<void> {
  selectMember('alpha');
  await tick();
  button('Next').click();
  await tick();
  button('Create').click();
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
  kindButton().click();
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

  it('explains the code and persona layouts in the choice helper', async () => {
    destroy = render();
    await openMembersStep();
    expect(layoutDescription()).toMatch(/persona[^.]*symlink/i);

    button('Detached worktrees').click();
    await tick();
    expect(layoutDescription()).toMatch(/code[^.]*worktree/i);
    expect(layoutDescription()).toMatch(/persona[^.]*symlink/i);
  });

  it('creates a symlink hub by default and opens a session in the returned folder', async () => {
    destroy = render();
    await openMembersStep();
    let finishCreation!: (response: any) => void;
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'create_hub')
        return new Promise((resolve) => {
          finishCreation = resolve;
        });
      return { id: '1', success: false, error: 'session_open_cancelled' };
    });
    await createHub();

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_hub', name: 'platform', memberPaths: ['/roots/alpha'] })));
    const command = vi
      .mocked(connection.send)
      .mock.calls.map(([request]) => request)
      .find((request) => request.type === 'create_hub');
    expect(command?.type === 'create_hub' && (command.memberRepresentation === undefined || command.memberRepresentation === 'symlink')).toBe(true);
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session' }));
    finishCreation({ id: '1', success: true, data: { folderPath: '/canonical/platform' } });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/canonical/platform' })));
  });

  it('sends create_hub with detached-worktree representation when that layout is chosen', async () => {
    destroy = render();
    await openMembersStep();

    button('Detached worktrees').click();
    await tick();
    await createHub();

    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'create_hub', name: 'platform', memberPaths: ['/roots/alpha'], memberRepresentation: 'worktree' }),
      ),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/platform' })));
  });
});
