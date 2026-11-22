// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: new Proxy(
    { status: 'connected', managerRoot: null, send: vi.fn(async () => ({ success: true, data: {} })) },
    {
      get(target, property) {
        return property in target ? target[property as keyof typeof target] : vi.fn();
      },
    },
  ),
}));

const { default: MessageList } = await import('./MessageList.svelte');

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 800;
/** The edge the reader must never reach: the frame catches up here. */
const NEAR_TOP_PX = 100;
/** Parked inside the prepared buffer, away from the edge. */
const INSIDE_BUFFER_PX = 1000;

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let container: HTMLElement;
let scrollPosition: { top: number };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function paint(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(16);
  flushSync();
}

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mountList(): void {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(MessageList, { target });
  container = target.querySelector<HTMLElement>('.message-list')!;
  // jsdom computes no layout: rows have a fixed height, so the scroll extent
  // follows the mounted row count the way a real transcript's would.
  scrollPosition = { top: 0 };
  const position = scrollPosition;
  Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => VIEWPORT_HEIGHT });
  Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => rowKeys().length * ROW_HEIGHT });
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => position.top,
    set: (value: number) => {
      position.top = Math.max(0, Math.min(value, container.scrollHeight - VIEWPORT_HEIGHT));
    },
  });
}

function seedSession(id: string, count: number, text: (index: number) => string = (index) => `message ${index}`): void {
  sessionRegistry.addSession(id, `/work/${id}`, id);
  const session = sessionRegistry.sessions[id];
  session.messages = Array.from({ length: count }, (_, index) => ({
    role: 'assistant' as const,
    entryId: `${id}-entry-${index}`,
    content: [{ type: 'text' as const, text: text(index) }],
  }));
  session.messageKeys = session.messages.map((_, index) => `m${index}`);
}

function rowKeys(): string[] {
  return [...target.querySelectorAll<HTMLElement>('.transcript-row')].map((row) => row.dataset.messageKey ?? '');
}

function scrollTo(top: number): void {
  container.scrollTop = top;
  container.dispatchEvent(new Event('scroll'));
}

/** Drive the reader up to the top of the mounted window, then let the frame
 *  that grows it and the scroll correction that follows it land. Returns the
 *  offset and extent the reader had before the window grew. */
async function readerScrollsToWindowTop(): Promise<{ top: number; height: number }> {
  paint(); // let the initial pin to the bottom land first
  scrollTo(NEAR_TOP_PX);
  await settle(5);
  const before = { top: scrollPosition.top, height: container.scrollHeight };
  paint();
  await settle(40);
  flushSync();
  return before;
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('MessageList rendered window', () => {
  it('shows and mounts a previous user message above the rendered window', async () => {
    seedSession('s1', 200);
    const session = sessionRegistry.sessions.s1;
    session.messages[0] = { role: 'user', entryId: 'u0', content: [{ type: 'text', text: 'old prompt' }] };
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    await settle();
    paint();
    container.dispatchEvent(new Event('scroll'));
    paint();

    expect(rowKeys()).not.toContain('m0');
    expect(target.querySelector('.sticky-preview')?.textContent).toContain('old prompt');

    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    target.querySelector<HTMLButtonElement>('.sticky-preview .jump')!.click();
    await settle();
    flushSync();

    expect(rowKeys()).toContain('m0');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('mounts the tail of a long transcript, not every row', () => {
    seedSession('s1', 200);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();

    const keys = rowKeys();
    expect(keys.length).toBeLessThan(200);
    // The reader lands at the bottom, so the newest row must be there.
    expect(keys.at(-1)).toBe('m199');
    // A window that cannot overflow the viewport would strand the older rows.
    expect(keys.length * ROW_HEIGHT).toBeGreaterThan(VIEWPORT_HEIGHT);
  });

  it('mounts older rows when the reader reaches the top, without moving what they read', async () => {
    seedSession('s1', 200);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    const mountedBefore = rowKeys();
    const firstBefore = mountedBefore[0];

    const before = await readerScrollsToWindowTop();

    const mountedAfter = rowKeys();
    expect(mountedAfter.length).toBeGreaterThan(mountedBefore.length);
    // Older rows joined above the window, and the newest row is still mounted.
    expect(mountedAfter).toContain(firstBefore);
    expect(mountedAfter.at(-1)).toBe('m199');
    // The rows above push the offset down by exactly the height they add, so
    // the line the reader was on does not move.
    expect(scrollPosition.top - before.top).toBe(container.scrollHeight - before.height);
  });

  it('keeps rows prepared ahead of the reader, out of the scroll frame', async () => {
    seedSession('s1', 400);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    paint();
    const rowsBefore = rowKeys().length;

    // A reader who stops inside the buffer has already scrolled past the point
    // where more rows were needed, so the preparation runs on its own.
    scrollTo(INSIDE_BUFFER_PX);
    await settle(5);
    const topBefore = scrollPosition.top;
    await settle(40);
    flushSync();

    expect(rowKeys().length).toBeGreaterThan(rowsBefore);
    // Room above the reader, or the whole transcript, is mounted.
    expect(scrollPosition.top >= 2400 || rowKeys()[0] === 'm0').toBe(true);
    expect(scrollPosition.top).toBeGreaterThan(topBefore);
  });

  it('holds the mounted rows when the agent appends while the reader is above them', async () => {
    seedSession('s1', 200);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    const tailStartKey = rowKeys()[0];
    await readerScrollsToWindowTop();
    const firstAfterExtending = rowKeys()[0];
    expect(firstAfterExtending).not.toBe(tailStartKey);

    const session = sessionRegistry.sessions.s1;
    session.messages = [...session.messages, { role: 'assistant', entryId: 's1-entry-new', content: [{ type: 'text', text: 'appended' }] } as (typeof session.messages)[number]];
    session.messageKeys = [...(session.messageKeys ?? []), 'm-new'];
    flushSync();

    expect(rowKeys()[0]).toBe(firstAfterExtending);
    expect(rowKeys().at(-1)).toBe('m-new');
  });

  it('renders the tail of the next session after a switch', async () => {
    seedSession('s1', 200);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    const tailRows = rowKeys().length;
    await readerScrollsToWindowTop();
    expect(rowKeys().length).toBeGreaterThan(tailRows);

    seedSession('s2', 150);
    sessionRegistry.switchTo('s2');
    flushSync();

    const keys = rowKeys();
    expect(keys.at(-1)).toBe('m149');
    expect(keys.length).toBeLessThan(150);
    expect(keys.length * ROW_HEIGHT).toBeGreaterThan(VIEWPORT_HEIGHT);
  });
});

describe('MessageList find across the window', () => {
  it('mounts an older row before jumping to its match', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    seedSession('s1', 200, (index) => (index === 5 ? 'needle in an old row' : `message ${index}`));
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    expect(rowKeys()).not.toContain('m5');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
    flushSync();
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Find in conversation"]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    flushSync();

    target.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click();
    await settle();
    flushSync();

    expect(rowKeys()).toContain('m5');
  });
});

describe('MessageList transcript bottom shortcut contract', () => {
  function detachTranscript(top = 200): void {
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    scrollTo(top);
    flushSync();
  }

  it('Mod+End scrolls a detached transcript to the bottom even when a textarea is focused', async () => {
    seedSession('s1', 40);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    paint();

    detachTranscript(200);
    expect(target.querySelector('button.scroll-to-bottom')).not.toBeNull();

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();

    const event = new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true });
    composer.dispatchEvent(event);
    await settle(10);
    paint();

    expect(event.defaultPrevented).toBe(true);
    expect(target.querySelector('button.scroll-to-bottom')).toBeNull();
  });

  it('plain End keeps native caret behavior inside a textarea and scrolls only outside text-entry targets', async () => {
    seedSession('s1', 40);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    paint();

    detachTranscript(200);
    expect(target.querySelector('button.scroll-to-bottom')).not.toBeNull();

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();

    const inField = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    composer.dispatchEvent(inField);
    await settle(10);
    expect(inField.defaultPrevented).toBe(false);
    expect(target.querySelector('button.scroll-to-bottom')).not.toBeNull();

    composer.blur();
    const outside = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    await settle(10);
    paint();
    expect(outside.defaultPrevented).toBe(true);
    expect(target.querySelector('button.scroll-to-bottom')).toBeNull();
  });

  it('ignores Mod+F and Mod+End while focus is inside an open dialog', async () => {
    seedSession('s1', 40);
    sessionRegistry.switchTo('s1');
    mountList();
    flushSync();
    paint();

    detachTranscript(200);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogInput = document.createElement('input');
    dialog.appendChild(dialogInput);
    document.body.appendChild(dialog);
    dialogInput.focus();

    const modF = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    dialogInput.dispatchEvent(modF);
    const modEnd = new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true });
    dialogInput.dispatchEvent(modEnd);
    await settle(10);

    expect(modF.defaultPrevented).toBe(false);
    expect(modEnd.defaultPrevented).toBe(false);
    expect(target.querySelector('input[aria-label="Find in conversation"]')).toBeNull();
    expect(document.activeElement).toBe(dialogInput);
    expect(target.querySelector('button.scroll-to-bottom')).not.toBeNull();
  });
});
