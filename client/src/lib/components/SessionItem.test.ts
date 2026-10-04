// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { SessionInfo } from '@pimote/shared';

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

// SwipeableCard arms the drag only on a mobile-sized viewport; jsdom has no
// matchMedia, and SwipeableCard calls it lazily on pointerdown.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
});

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
const { default: SessionItem } = await import('./SessionItem.svelte');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

const folderPath = '/w/alpha';

const openSession: SessionInfo = {
  id: 'sess-open',
  name: 'Open session',
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-02T00:00:00.000Z',
  messageCount: 3,
};

const idleSession: SessionInfo = {
  id: 'sess-idle',
  name: 'Idle session',
  created: '2025-12-01T00:00:00.000Z',
  modified: '2025-12-02T00:00:00.000Z',
  messageCount: 1,
};

const archivedSession: SessionInfo = {
  ...idleSession,
  id: 'sess-arch',
  name: 'Archived session',
  archived: true,
};

let target: HTMLDivElement;
let destroy: (() => void) | null = null;

function render(session: SessionInfo) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SessionItem, { target, props: { session, folderPath } });
  destroy = () => unmount(component);
}

function surface(): HTMLElement {
  const el = target.querySelector('.touch-pan-y');
  if (!(el instanceof HTMLElement)) throw new Error('swipe surface not found');
  return el;
}

/** Tray buttons render their label as exact text (icon contributes none). */
function trayLabels(): string[] {
  return Array.from(target.querySelectorAll('button'))
    .map((b) => (b.textContent ?? '').trim())
    .filter((t) => t === 'Close' || t === 'Archive' || t === 'Unarchive');
}

function dispatchPointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number) {
  surface().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: x,
      clientY: 100,
      button: 0,
    }),
  );
}

/** Horizontal drag gesture: down at fromX, glide to toX, release there. */
async function drag(fromX: number, toX: number) {
  dispatchPointer('pointerdown', fromX);
  dispatchPointer('pointermove', (fromX + toX) / 2);
  await tick();
  dispatchPointer('pointermove', toX);
  await tick();
  dispatchPointer('pointerup', toX);
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionRegistry.addSession(openSession.id, folderPath, 'alpha');
});

afterEach(() => {
  destroy?.();
  destroy = null;
  sessionRegistry.removeSession(openSession.id);
  sessionRegistry.removeSession(idleSession.id);
  document.body.innerHTML = '';
});

describe('session row swipe trays', () => {
  it('renders Close + Archive trays for a session open on this client', async () => {
    render(openSession);
    await tick();

    expect(trayLabels()).toContain('Close');
    expect(trayLabels()).toContain('Archive');
  });

  it('gives a closed session Archive but no Close tray', async () => {
    render(idleSession);
    await tick();

    expect(trayLabels()).not.toContain('Close');
    expect(trayLabels()).toContain('Archive');
  });

  it('offers Unarchive instead of Archive on an archived session', async () => {
    render(archivedSession);
    await tick();

    expect(trayLabels()).toContain('Unarchive');
    expect(trayLabels()).not.toContain('Archive');
  });

  it('keeps one context menu per row — the swipe card does not nest a second', async () => {
    render(openSession);
    await tick();

    expect(target.querySelectorAll('[data-context-menu-trigger]')).toHaveLength(1);
  });
});

describe('session row swipe gestures', () => {
  it('swiping left sends close_session and the card returns to rest', async () => {
    render(openSession);
    await tick();

    // 300 → 180 is a 120px drag: past the 104px fire threshold, still within
    // the rubber-band start so the translate is exactly -120px.
    dispatchPointer('pointerdown', 300);
    dispatchPointer('pointermove', 180);
    await tick();
    expect(surface().style.transform).toBe('translateX(-120px)');

    dispatchPointer('pointerup', 180);

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'close_session', sessionId: openSession.id }));
    // 'stay' outcome: the card springs back to rest instead of collapsing.
    await vi.waitFor(() => expect(surface().style.transform).toBe('translateX(0px)'));
  });

  it('swiping left on a closed session holds at rest and sends nothing', async () => {
    render(idleSession);
    await tick();

    dispatchPointer('pointerdown', 300);
    dispatchPointer('pointermove', 180);
    await tick();
    // No Close tray exists on this edge, so the card must not reveal a gap.
    expect(surface().style.transform).toBe('translateX(0px)');

    dispatchPointer('pointerup', 180);
    await tick();

    expect(connection.send).not.toHaveBeenCalledWith({ type: 'close_session', sessionId: idleSession.id });
  });

  it('swiping right sends archive_session', async () => {
    render(idleSession);
    await tick();

    await drag(100, 220);

    expect(connection.send).toHaveBeenCalledWith({
      type: 'archive_session',
      folderPath,
      sessionIds: [idleSession.id],
      archived: true,
    });
    // Archiving a session that is not open here must not close anything.
    expect(connection.send).not.toHaveBeenCalledWith({ type: 'close_session', sessionId: idleSession.id });
  });

  it('swiping right on an archived session unarchives it', async () => {
    render(archivedSession);
    await tick();

    await drag(100, 220);

    expect(connection.send).toHaveBeenCalledWith({
      type: 'archive_session',
      folderPath,
      sessionIds: [archivedSession.id],
      archived: false,
    });
  });
});
