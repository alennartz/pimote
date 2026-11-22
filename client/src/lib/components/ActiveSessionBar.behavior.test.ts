// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PimoteResponse } from '@pimote/shared';
import { mount, tick, unmount } from 'svelte';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
/** Drives the app's viewport breakpoint, so a test can stand where a phone or a
 *  desktop stands. `mobile-viewport` subscribes once at module load. */
let mobileListener: ((event: { matches: boolean }) => void) | null = null;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      if (query.includes('max-width: 767px')) mobileListener = listener;
    },
    removeEventListener: () => {},
  })),
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

/** Fake rail geometry: chip `index` sits `gap` past the previous chip. */
function stubChipGeometry(width: number, gap = 6): void {
  for (const [index, element] of [...document.querySelectorAll<HTMLElement>('[data-session-chip]')].entries()) {
    element.getBoundingClientRect = () => ({ left: index * (width + gap), width, height: 24, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
}

function chipPointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX, clientY });
}

function mousePointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', button: 0, clientX, clientY });
}

function railChips(): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>('[data-session-chip]')];
}

/** The registry is one singleton: give a reorder test exactly its own chips in
 *  its own order, and leave the shared session behind. */
function isolateChips(sessionIds: string[]): void {
  sessionRegistry.removeSession(id);
  sessionRegistry.applyUserSessionFacts({ order: [], selectedSessionId: null, orderVersion: 0 });
  for (const sessionId of sessionIds) sessionRegistry.addSession(sessionId, `/w/${sessionId}`, sessionId);
  sessionRegistry.applyUserSessionFacts({ order: sessionIds, selectedSessionId: null, orderVersion: 0 });
  sessionRegistry.switchTo(sessionIds[0]);
}

function releaseChips(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    sessionRegistry.removeSession(sessionId);
  }
  sessionRegistry.applyUserSessionFacts({ order: [], selectedSessionId: null, orderVersion: 0 });
}

/** The one gesture that opens the tray: a short upward pointer swipe. */
function swipeUp(element: HTMLElement, fromY = 100, toY = 60): void {
  element.dispatchEvent(chipPointer('pointerdown', 100, fromY));
  element.dispatchEvent(chipPointer('pointermove', 100, toY));
  element.dispatchEvent(chipPointer('pointerup', 100, toY));
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

afterEach(async () => {
  vi.useRealTimers();
  mobileListener?.({ matches: false });
  destroy?.();
  destroy = null;
  sessionRegistry.removeSession(id);
  document.body.innerHTML = '';
  await drainBodyScrollLockCleanup();
});

describe('active session bar behavior', () => {
  it('switches on the first tap after a swipe-opened tray is dismissed', async () => {
    render();
    await tick();
    const sessionChip = chip();

    swipeUp(sessionChip);
    await tick();
    expect(target.textContent).toContain('Session actions');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await tick();
    expect(target.textContent).not.toContain('Session actions');

    chip().click();
    expect(connection.send).toHaveBeenCalledWith({ type: 'view_session', sessionId: id, folderPath: '/w/alpha' });
  });

  it('reorders on a mouse drag and keeps the trailing click out of selection', async () => {
    const dragSessions = ['drag-alpha', 'drag-beta', 'drag-gamma'];
    try {
      isolateChips(dragSessions);
      render();
      await tick();
      stubChipGeometry(80);

      const [, second] = railChips();
      second.dispatchEvent(mousePointer('pointerdown', 100, 100));
      second.dispatchEvent(mousePointer('pointermove', 10, 100));
      second.dispatchEvent(mousePointer('pointerup', 10, 100));
      // The browser follows a mouse press and release with a click.
      second.click();
      await tick();

      expect(connection.send).toHaveBeenCalledWith({ type: 'reorder_sessions', order: [dragSessions[1], dragSessions[0], dragSessions[2]], baseVersion: 0 });
      expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'view_session', sessionId: dragSessions[1] }));
      expect(railChips().map((element) => element.dataset.sessionChip)).toEqual([dragSessions[1], dragSessions[0], dragSessions[2]]);
    } finally {
      releaseChips(dragSessions);
    }
  });

  it('leaves a press on the chip close control with the close control', async () => {
    const setPointerCapture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, writable: true, value: setPointerCapture });
    try {
      render();
      await tick();
      const closeControl = chip().querySelector<HTMLElement>('[title="Close session"]');
      expect(closeControl).toBeInstanceOf(HTMLElement);

      closeControl!.dispatchEvent(mousePointer('pointerdown', 100, 100));
      closeControl!.dispatchEvent(mousePointer('pointerup', 100, 100));
      expect(setPointerCapture).not.toHaveBeenCalled();

      // The reorder drag still holds the pointer once it is armed.
      const [first] = railChips();
      first.dispatchEvent(mousePointer('pointerdown', 100, 100));
      first.dispatchEvent(mousePointer('pointermove', 20, 100));
      expect(setPointerCapture).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    }
  });

  it('flows the row one chip per half width while the tray is open and pushes one order', async () => {
    const flowSessions = ['flow-alpha', 'flow-beta', 'flow-gamma'];
    try {
      isolateChips(flowSessions);
      render();
      await tick();
      stubChipGeometry(80);

      const [first] = railChips();
      // A sideways swipe with the tray closed scrolls the rail; the tray opens
      // from an upward swipe on the chip.
      swipeUp(first);
      await tick();
      expect(target.textContent).toContain('Session actions');

      first.dispatchEvent(chipPointer('pointerdown', 40, 100));
      first.dispatchEvent(chipPointer('pointermove', -60, 100));
      first.dispatchEvent(chipPointer('pointerup', -60, 100));
      await tick();

      expect(connection.send).toHaveBeenCalledWith({
        type: 'reorder_sessions',
        order: [flowSessions[1], flowSessions[2], flowSessions[0]],
        baseVersion: 0,
      });
    } finally {
      releaseChips(flowSessions);
    }
  });

  it('scrolls instead of reordering on a sideways swipe while the tray is closed', async () => {
    const scrollSessions = ['scroll-alpha', 'scroll-beta', 'scroll-gamma'];
    try {
      isolateChips(scrollSessions);
      render();
      await tick();
      stubChipGeometry(80);

      const [first] = railChips();
      first.dispatchEvent(chipPointer('pointerdown', 120, 100));
      first.dispatchEvent(chipPointer('pointermove', 60, 100));
      first.dispatchEvent(chipPointer('pointerup', 60, 100));
      await tick();

      expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'reorder_sessions' }));
      expect(railChips().map((element) => element.dataset.sessionChip)).toEqual(scrollSessions);
    } finally {
      releaseChips(scrollSessions);
    }
  });

  it('opens the swipe action tray on a phone long press without a chip menu', async () => {
    mobileListener?.({ matches: true });
    await tick();
    render();
    await tick();
    const sessionChip = chip();

    sessionChip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 100, clientY: 100 }));
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    sessionChip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: 100, clientY: 100 }));
    swipeUp(sessionChip);
    await tick();

    expect(target.textContent).toContain('Session actions');
  });

  it('removes the chip before the archive response in the swipe action tray', async () => {
    render();
    await tick();
    const sessionChip = chip();

    swipeUp(sessionChip);
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
    expect(connection.send).toHaveBeenCalledWith({ type: 'detach_session', sessionId: id });
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

  it('copies the session file path from the desktop context menu', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render();
    await tick();
    sessionRegistry.sessions[id].sessionFile = '/w/alpha/2026-11-16T22-31-44_alpha.jsonl';
    await tick();
    await openDesktopMenu();

    menuItem('Copy session file').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(writeText).toHaveBeenCalledWith('/w/alpha/2026-11-16T22-31-44_alpha.jsonl');
  });
});

describe('open subagent view lobes', () => {
  const rootId = 'lobe-session';

  function openChildView(path: string[], childSessionId: string): void {
    sessionRegistry.handleEvent({
      type: 'subagent_view_snapshot',
      sessionId: rootId,
      childSessionId,
      path,
      incarnation: `inc-${path.join('-')}`,
      viewCursor: 1,
      state: {
        sessionId: childSessionId,
        sessionFile: undefined,
        model: null,
        thinkingLevel: 'off',
        availableThinkingLevels: [],
        isStreaming: false,
        isCompacting: false,
        autoCompactionEnabled: true,
        messageCount: 1,
      },
      messages: [],
    });
  }

  function lobeGroup(): HTMLElement {
    const found = target.querySelector<HTMLElement>('.lobe-group');
    if (!found) throw new Error('lobe group not found');
    return found;
  }

  function childLobe(label: string): HTMLButtonElement {
    const found = [...lobeGroup().querySelectorAll<HTMLButtonElement>('.lobe.childl')].find((lobe) => lobe.textContent?.includes(label));
    if (!found) throw new Error(`child lobe not found: ${label}`);
    return found;
  }

  beforeEach(() => {
    sessionRegistry.addSession(rootId, '/w/lobe', 'lobe');
    sessionRegistry.switchTo(rootId);
  });

  afterEach(() => {
    sessionRegistry.clearSubagentRoot(rootId);
    sessionRegistry.removeSession(rootId);
  });

  it('renders open child views as lobes attached to the parent chip', async () => {
    openChildView(['scout'], 'child-scout');
    openChildView(['worker'], 'child-worker');
    render();
    await tick();

    expect(lobeGroup().dataset.sessionChip).toBe(rootId);
    expect(lobeGroup().querySelectorAll('.lobe.childl')).toHaveLength(2);
    expect(lobeGroup().textContent).toContain('scout');
    expect(lobeGroup().textContent).toContain('worker');
  });

  it('marks the selected child lobe and switches views on click', async () => {
    openChildView(['scout'], 'child-scout');
    openChildView(['worker'], 'child-worker');
    sessionRegistry.selectSubagentView(rootId, ['worker']);
    render();
    await tick();

    expect(childLobe('worker').className).toContain('viewed');
    expect(childLobe('scout').className).not.toContain('viewed');

    childLobe('scout').click();
    await tick();
    expect(sessionRegistry.getSelectedSubagentPath(rootId)).toEqual(['scout']);
  });

  it('closes only the view from a lobe dismiss button', async () => {
    openChildView(['scout'], 'child-scout');
    sessionRegistry.selectSubagentView(rootId, ['scout']);
    render();
    await tick();

    const dismiss = childLobe('scout').querySelector<HTMLElement>('[title="Close view"]');
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await tick();

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent_close_view', sessionId: rootId, path: ['scout'] }));
    expect(sessionRegistry.getSelectedSubagentPath(rootId)).toBeNull();
  });
});
