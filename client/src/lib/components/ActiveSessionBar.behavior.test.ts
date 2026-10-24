// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PimoteResponse } from '@pimote/shared';
import { mount, tick, unmount } from 'svelte';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
});

vi.mock('$lib/stores/connection.svelte.js', () => {
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
const { default: ActiveSessionBar } = await import('./ActiveSessionBar.svelte');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

const id = 'touch-session';

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  return event;
}

let target: HTMLDivElement;
let destroy: (() => void) | null = null;

function chip() {
  const found = [...target.querySelectorAll('button')].find((button) => button.textContent?.includes('alpha'));
  if (!(found instanceof HTMLButtonElement)) throw new Error('chip not found');
  return found;
}

function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ActiveSessionBar, { target });
  destroy = () => unmount(component);
}

function holdResponses() {
  vi.mocked(connection.send).mockImplementation(() => new Promise<PimoteResponse>(() => {}));
}

function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [data-slot="context-menu-item"]')].find((candidate) => candidate.textContent?.trim() === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

async function openDesktopMenu() {
  chip().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connection.send).mockResolvedValue({ id: 'test', success: true, data: {} });
  vi.useFakeTimers();
  sessionRegistry.addSession(id, '/w/alpha', 'alpha');
  sessionRegistry.switchTo(id);
});

afterEach(() => {
  vi.useRealTimers();
  destroy?.();
  destroy = null;
  sessionRegistry.removeSession(id);
  document.body.innerHTML = '';
});

describe('active session bar behavior', () => {
  it('cancels upward swipe touches so the browser starts no fling', async () => {
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    const move = touchEvent('touchmove', [{ clientX: 102, clientY: 60 }]);
    sessionChip.dispatchEvent(move);
    const end = touchEvent('touchend', []);
    sessionChip.dispatchEvent(end);

    expect(move.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
  });

  it('switches on the first tap after a swipe-opened tray is dismissed', async () => {
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    sessionChip.dispatchEvent(touchEvent('touchmove', [{ clientX: 100, clientY: 60 }]));
    sessionChip.dispatchEvent(touchEvent('touchend', []));
    await tick();
    expect(target.textContent).toContain('Session actions');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await tick();
    expect(target.textContent).not.toContain('Session actions');

    chip().click();
    expect(connection.send).toHaveBeenCalledWith({ type: 'view_session', sessionId: id });
  });

  it('leaves horizontal drags to the browser', async () => {
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    const move = touchEvent('touchmove', [{ clientX: 160, clientY: 95 }]);
    sessionChip.dispatchEvent(move);
    const end = touchEvent('touchend', []);
    sessionChip.dispatchEvent(end);

    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
  });

  it('closes a long-press context menu when the same gesture becomes an upward swipe', async () => {
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 100, clientY: 100 }));
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    sessionChip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: 100, clientY: 100 }));
    sessionChip.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    sessionChip.dispatchEvent(touchEvent('touchmove', [{ clientX: 100, clientY: 60 }]));
    sessionChip.dispatchEvent(touchEvent('touchend', []));
    await tick();

    expect(target.textContent).toContain('Session actions');
    expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull();

    const close = [...target.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Close');
    expect(close).toBeInstanceOf(HTMLButtonElement);
    holdResponses();
    (close as HTMLButtonElement).click();
    await tick();
    expect(sessionRegistry.sessions[id]).toBeUndefined();
    expect(connection.send).toHaveBeenCalledWith({ type: 'close_session', sessionId: id });
  });

  it('removes the chip before the archive response in the swipe action tray', async () => {
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    sessionChip.dispatchEvent(touchEvent('touchmove', [{ clientX: 100, clientY: 60 }]));
    sessionChip.dispatchEvent(touchEvent('touchend', []));
    await tick();

    const archive = [...target.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Archive');
    expect(archive).toBeInstanceOf(HTMLButtonElement);
    holdResponses();
    (archive as HTMLButtonElement).click();
    await tick();

    expect(sessionRegistry.sessions[id]).toBeUndefined();
    expect(connection.send).toHaveBeenCalledWith({
      type: 'archive_session',
      folderPath: '/w/alpha',
      sessionIds: [id],
      archived: true,
    });
  });

  it('removes the chip before the close response from the desktop context menu', async () => {
    render();
    await tick();
    holdResponses();
    await openDesktopMenu();

    menuItem('Close session').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(sessionRegistry.sessions[id]).toBeUndefined();
    expect(connection.send).toHaveBeenCalledWith({ type: 'close_session', sessionId: id });
  });

  it('removes the chip before the archive response from the desktop context menu', async () => {
    render();
    await tick();
    holdResponses();
    await openDesktopMenu();

    menuItem('Archive session').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(sessionRegistry.sessions[id]).toBeUndefined();
    expect(connection.send).toHaveBeenCalledWith({
      type: 'archive_session',
      folderPath: '/w/alpha',
      sessionIds: [id],
      archived: true,
    });
  });
});
