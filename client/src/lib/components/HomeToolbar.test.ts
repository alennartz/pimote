// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';
import type { SessionInfo } from '@pimote/shared';

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
  const base: Record<string, unknown> = {
    status: 'connected',
    managerRoot: '/w/manager',
    send: vi.fn(async () => ({ success: true, data: {} })),
  };
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

const { default: HomeToolbar } = await import('./HomeToolbar.svelte');
const { folderStore } = await import('$lib/stores/folder-store.svelte.js');

const managerRoot = '/w/manager';

function makeManagerSession(index: number): SessionInfo {
  return {
    id: `manager-${index}`,
    name: `Manager session ${index}`,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
    messageCount: index + 1,
  };
}

let destroy: (() => void) | null = null;

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(HomeToolbar, { target });
  return () => unmount(component);
}

function modeToggle(): HTMLButtonElement {
  const button = document.querySelector('button[aria-label="Switch to the manager"], button[aria-label="Switch to search"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('mode toggle not found');
  return button;
}

afterEach(async () => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
  folderStore.sessions.clear();
  vi.restoreAllMocks();
  await drainBodyScrollLockCleanup();
});

describe('combined search / manager box', () => {
  it('defaults to search mode with both glyphs visible on one toggle', async () => {
    destroy = render();
    await tick();

    expect(document.querySelector('input[aria-label="Search folders"]')).not.toBeNull();
    expect(document.querySelector('textarea[aria-label="Message the manager"]')).toBeNull();
    // One control, two glyphs: both are always rendered, the active one is highlighted.
    expect(modeToggle().getAttribute('data-mode')).toBe('search');
    expect(modeToggle().getAttribute('aria-label')).toBe('Switch to the manager');
    expect(modeToggle().querySelector('.lucide-search')).not.toBeNull();
    expect(modeToggle().querySelector('.lucide-sparkles')).not.toBeNull();
  });

  it('a single tap anywhere on the pair swaps into manager mode, and back', async () => {
    destroy = render();
    await tick();

    modeToggle().click();
    await tick();
    expect(document.querySelector('textarea[aria-label="Message the manager"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Search folders"]')).toBeNull();
    expect(modeToggle().getAttribute('data-mode')).toBe('manager');
    expect(modeToggle().getAttribute('aria-label')).toBe('Switch to search');
    expect(modeToggle().querySelector('.lucide-search')).not.toBeNull();
    expect(modeToggle().querySelector('.lucide-sparkles')).not.toBeNull();

    modeToggle().click();
    await tick();
    expect(document.querySelector('input[aria-label="Search folders"]')).not.toBeNull();
    expect(document.querySelector('textarea[aria-label="Message the manager"]')).toBeNull();
    expect(modeToggle().getAttribute('data-mode')).toBe('search');
  });

  it('keeps previous-session rows from shrinking when the dropdown overflows', async () => {
    const sessions = Array.from({ length: 8 }, (_, index) => makeManagerSession(index));
    folderStore.sessions.set(managerRoot, sessions);
    vi.spyOn(folderStore, 'loadSessions').mockResolvedValue(undefined);
    destroy = render();
    await tick();

    modeToggle().click();
    await tick();
    const previousSessions = document.querySelector('button[aria-label="Previous sessions"]');
    if (!(previousSessions instanceof HTMLButtonElement)) throw new Error('previous sessions button not found');
    previousSessions.click();
    await tick();

    const rowButtons = sessions.map((session) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes(session.name!));
      if (!button) throw new Error(`session row not found: ${session.name}`);
      return button;
    });
    expect(rowButtons).toHaveLength(sessions.length);
    expect(rowButtons.every((button) => button.closest('div.shrink-0') !== null)).toBe(true);
  });

  it('the New session button opens the folder picker', async () => {
    destroy = render();
    await tick();

    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('New session'));
    expect(button).toBeDefined();
    button!.click();
    await tick();

    expect(document.body.textContent).toContain('Start a new session');
  });
});
