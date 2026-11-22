// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { FolderInfo, LauncherSessionHit } from '@pimote/shared';
import type { GlobalLauncherActions, LauncherCommand, LauncherSearchTransport } from '$lib/launcher/contracts.js';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const { default: GlobalLauncher } = await import('./GlobalLauncher.svelte');

function makeFolder(path: string, name: string): FolderInfo {
  return {
    path,
    name,
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

function makeSession(sessionId: string, name: string, folderPath = '/w/pimote'): LauncherSessionHit {
  return {
    sessionId,
    folderPath,
    folderName: 'pimote',
    name,
    firstMessage: name,
    modified: 1_700_000_000_000,
    archived: false,
  };
}

let destroy: (() => void) | null = null;

afterEach(async () => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  await drainBodyScrollLockCleanup();
});

function renderLauncher(
  opts: {
    transport?: LauncherSearchTransport;
    commands?: LauncherCommand[];
    actions?: GlobalLauncherActions;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const actions: GlobalLauncherActions = opts.actions ?? {
    startSessionInFolder: vi.fn(),
    openSession: vi.fn(),
  };
  const transport: LauncherSearchTransport = opts.transport ?? {
    search: vi.fn(async () => ({
      folders: [makeFolder('/w/pimote', 'pimote')],
      sessions: [makeSession('sess-1', 'Fix retry backoff')],
    })),
  };
  const commands: LauncherCommand[] = opts.commands ?? [{ id: 'settings', label: 'Open Settings', keywords: ['config'], group: 'app', run: vi.fn() }];

  const component = mount(GlobalLauncher, {
    target,
    props: {
      transport,
      getCommands: () => commands,
      actions,
      debounceMs: 0,
    },
  });
  flushSync();
  destroy = () => unmount(component);
  return { actions, transport, commands };
}

function findLauncherInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[role="dialog"] input');
}

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  await tick();
}

describe('GlobalLauncher contract', () => {
  it('opens on Mod+K even from inside a text-entry field and focuses its search input', async () => {
    renderLauncher();
    const textarea = document.createElement('textarea');
    textarea.value = 'keep my draft';
    document.body.appendChild(textarea);
    textarea.focus();

    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    const input = findLauncherInput();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(textarea.value).toBe('keep my draft');
  });

  it('closes on Escape and marks the event defaultPrevented so underlying listeners do not fire', async () => {
    renderLauncher();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(findLauncherInput()).not.toBeNull();

    const windowListener = vi.fn((e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') {
        // Simulates InputBar's window Escape streaming-abort guard.
        return 'leaked';
      }
      return 'blocked';
    });
    window.addEventListener('keydown', windowListener);

    try {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      (findLauncherInput() ?? document.body).dispatchEvent(esc);
      await settle();

      expect(findLauncherInput()).toBeNull();
      expect(esc.defaultPrevented).toBe(true);
      for (const result of windowListener.mock.results) {
        expect(result.value).not.toBe('leaked');
      }
    } finally {
      window.removeEventListener('keydown', windowListener);
    }
  });

  it('activates folders, sessions, and commands through the injected actions and resets query on reopen', async () => {
    const runCommand = vi.fn();
    const startSessionInFolder = vi.fn();
    const openSession = vi.fn();
    const session = makeSession('sess-1', 'Fix retry backoff');

    renderLauncher({
      actions: { startSessionInFolder, openSession },
      commands: [{ id: 'settings', label: 'Open Settings', group: 'app', run: runCommand }],
      transport: {
        search: vi.fn(async () => ({
          folders: [makeFolder('/w/pimote', 'pimote')],
          sessions: [session],
        })),
      },
    });

    // 1. Open and activate folder hit.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    const folderItem = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes('pimote'));
    expect(folderItem).toBeDefined();
    folderItem!.click();
    await settle();
    expect(startSessionInFolder).toHaveBeenCalledWith('/w/pimote');
    expect(findLauncherInput()).toBeNull();

    // 2. Reopen, narrow with '>' to commands, activate command.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    const input = findLauncherInput()!;
    expect(input.value).toBe('');
    input.value = '> settings';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    const commandItem = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes('Open Settings'));
    expect(commandItem).toBeDefined();
    commandItem!.click();
    await settle();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(findLauncherInput()).toBeNull();

    // 3. Reopen and activate session hit; query must start empty again.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(findLauncherInput()!.value).toBe('');
    const sessionItem = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes('Fix retry backoff'));
    expect(sessionItem).toBeDefined();
    sessionItem!.click();
    await settle();
    expect(openSession).toHaveBeenCalledWith(session);
  });
});
