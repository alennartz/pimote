// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

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

const { default: HomeToolbar } = await import('./HomeToolbar.svelte');

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

afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
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
