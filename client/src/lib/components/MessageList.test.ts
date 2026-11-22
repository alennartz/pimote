// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { flushSync } from 'svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

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

const { default: MessageList } = await import('./MessageList.svelte');

class RecordingResizeObserver {
  static instances: RecordingResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    RecordingResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

function fireResize(target: Element) {
  for (const observer of RecordingResizeObserver.instances) {
    if (observer.observed.has(target)) observer.callback([], observer as unknown as ResizeObserver);
  }
}

/** Element geometry jsdom cannot compute, with a real scrollTop clamp. */
function stubGeometry(el: HTMLElement) {
  const geometry = { scrollHeight: 1000, clientHeight: 400, top: 0 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geometry.top,
    set: (value: number) => {
      geometry.top = Math.max(0, Math.min(value, geometry.scrollHeight - geometry.clientHeight));
    },
  });
  return geometry;
}

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let container: HTMLElement;
let inner: HTMLElement;
let geometry: ReturnType<typeof stubGeometry>;
let frameCallbacks: Map<number, FrameRequestCallback>;
let nextFrameId: number;

function paintFrame() {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) callback(16);
  flushSync();
}

beforeEach(async () => {
  frameCallbacks = new Map();
  nextFrameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frameCallbacks.delete(id));
  RecordingResizeObserver.instances = [];
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  const session = sessionRegistry.viewed!;
  session.messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  session.messageKeys = ['m1'];
  target = document.createElement('div');
  document.body.append(target);
  component = mount(MessageList, { target });
  container = target.querySelector<HTMLElement>('.message-list')!;
  inner = target.querySelector<HTMLElement>('.message-list-inner')!;
  geometry = stubGeometry(container);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
});

function settle() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('MessageList streaming menus', () => {
  it.each([true, false])('keeps finalized message menus open while streaming, pinned=%s', async (pinned) => {
    const session = sessionRegistry.viewed!;
    session.messages = [
      { role: 'user', entryId: 'u1', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', entryId: 'a1', content: [{ type: 'text', text: 'finished answer' }] },
    ];
    session.messageKeys = ['m1', 'm2'];
    session.isStreaming = true;
    session.streamingKey = 'm3';
    session.streamingMessage = { role: 'assistant', content: [{ type: 'text', text: 'live' }] };
    flushSync();
    await settle();
    container.scrollTop = pinned ? geometry.scrollHeight : 0;
    container.dispatchEvent(new Event('scroll'));
    flushSync();

    for (const selector of ['.user-icon', '.assistant-icon']) {
      const icon = target.querySelector<HTMLButtonElement>(`button${selector}`)!;
      const message = icon.closest('.message')!;
      icon.click();
      flushSync();
      expect(message.querySelector('[role="menu"]')).not.toBeNull();
      for (let i = 0; i < 30; i++) {
        session.streamingMessage!.content[0].text += ' delta';
        flushSync();
        await settle();
        expect(message.querySelector('[role="menu"]')).not.toBeNull();
      }
      icon.click();
      flushSync();
    }
  });
});

describe('MessageList reasoning bodies', () => {
  it('keeps an open reasoning body across the streaming handoff', async () => {
    sessionRegistry.handleEvent({ type: 'message_start', sessionId: 's1', cursor: 1, role: 'assistant' });
    sessionRegistry.handleEvent({ type: 'message_update', sessionId: 's1', cursor: 2, subtype: 'start', contentIndex: 0, content: { type: 'thinking', text: '' } });
    sessionRegistry.handleEvent({ type: 'message_update', sessionId: 's1', cursor: 3, subtype: 'delta', contentIndex: 0, content: { type: 'text', text: 'weighing the options' } });
    flushSync();
    await tick();

    expect(target.querySelector('.thinking-content')).not.toBeNull();

    sessionRegistry.handleEvent({
      type: 'message_end',
      sessionId: 's1',
      cursor: 4,
      message: { role: 'assistant', content: [{ type: 'thinking', text: 'weighing the options' }] },
    });
    flushSync();
    await tick();

    expect(target.querySelector('.thinking-content')).not.toBeNull();
  });
});

describe('MessageList transcript preservation', () => {
  it('keeps the previous answer visible after a projected row and the next user echo', () => {
    sessionRegistry.addSession('s1', '/workspace/project', 'project');
    sessionRegistry.handleEvent({ type: 'message_start', sessionId: 's1', cursor: 1, role: 'user' });
    sessionRegistry.handleEvent({ type: 'message_end', sessionId: 's1', cursor: 2, message: { role: 'user', content: [{ type: 'text', text: 'Initial question.' }] } });
    sessionRegistry.handleEvent({
      type: 'subagent_content_start',
      sessionId: 's1',
      cursor: 3,
      parentMessageId: 'message-1',
      contentIndex: 0,
      operationId: 'send-call',
      kind: 'send',
      placement: { toolCallId: 'send-call', contentIndex: 0 },
      content: {
        type: 'subagent',
        operationId: 'send-call',
        subagentKind: 'send',
        subagentState: 'active',
        data: { operation: 'send', parameters: { to: ['worker'], message: 'Check the result.' }, result: { response: '', phase: 'sending' } },
      },
    });
    const answer = 'The previous answer must remain readable.';
    sessionRegistry.handleEvent({ type: 'message_start', sessionId: 's1', cursor: 4, role: 'assistant' });
    sessionRegistry.handleEvent({ type: 'message_end', sessionId: 's1', cursor: 5, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
    flushSync();
    expect(inner.textContent).toContain(answer);

    const prompt = 'The next question.';
    sessionRegistry.addOptimisticUserMessage('s1', prompt, 'prompt-1');
    flushSync();
    expect(inner.textContent).toContain(answer);
    sessionRegistry.handleEvent({ type: 'message_start', sessionId: 's1', cursor: 6, role: 'user', clientMessageId: 'prompt-1' });
    sessionRegistry.handleEvent({
      type: 'message_end',
      sessionId: 's1',
      cursor: 7,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      clientMessageId: 'prompt-1',
    });
    flushSync();

    expect(inner.textContent).toContain(answer);
    expect([...inner.querySelectorAll('.user-message')].filter((row) => row.textContent?.includes(prompt))).toHaveLength(1);
  });
});

describe('MessageList scroll pin', () => {
  it('keeps following streamed output when a scroll event arrives before the next frame', async () => {
    const session = sessionRegistry.viewed!;
    session.isStreaming = true;
    session.streamingKey = 'stream';
    session.streamingMessage = { role: 'assistant', content: [{ type: 'thinking', text: 'Reasoning' }] };
    flushSync();
    await settle();
    paintFrame();

    container.scrollTop = geometry.scrollHeight;
    container.dispatchEvent(new Event('scroll'));
    geometry.scrollHeight = 1400;
    session.streamingMessage.content[0].text += ' continues';
    flushSync();
    await settle();
    fireResize(inner);

    // A native scroll notification can arrive before the scheduled follow-up frame.
    container.dispatchEvent(new Event('scroll'));
    paintFrame();

    expect(container.scrollTop).toBe(999);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('does not unpin from a programmatic scroll event', async () => {
    const session = sessionRegistry.viewed!;
    session.isStreaming = true;
    session.streamingKey = 'stream';
    session.streamingMessage = { role: 'assistant', content: [{ type: 'thinking', text: 'Reasoning' }] };
    geometry.scrollHeight = 1400;
    flushSync();
    await settle();
    paintFrame();

    container.dispatchEvent(new Event('scroll'));
    container.scrollTop = 900;
    container.dispatchEvent(new Event('scroll'));
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();

    geometry.scrollHeight = 1500;
    session.streamingMessage.content[0].text += ' continues';
    flushSync();
    await settle();
    fireResize(inner);
    paintFrame();

    expect(container.scrollTop).toBe(1099);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('unpins after a manual upward wheel scroll and stays unpinned', async () => {
    const session = sessionRegistry.viewed!;
    session.isStreaming = true;
    session.streamingKey = 'stream';
    session.streamingMessage = { role: 'assistant', content: [{ type: 'thinking', text: 'Reasoning' }] };
    geometry.scrollHeight = 1400;
    flushSync();
    await settle();
    paintFrame();

    container.dispatchEvent(new Event('scroll'));
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    container.scrollTop = 900;
    container.dispatchEvent(new Event('scroll'));
    flushSync();
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();

    geometry.scrollHeight = 1500;
    session.streamingMessage.content[0].text += ' continues';
    flushSync();
    await settle();
    fireResize(inner);
    paintFrame();

    expect(container.scrollTop).toBe(900);
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();
  });

  it('stays glued to the bottom when the viewport shrinks while pinned', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();
    expect(container.scrollTop).toBe(600); // pinned: real bottom of 1000/400

    // A question panel appears below the list and steals 260px of height.
    geometry.clientHeight = 140;
    fireResize(container);
    paintFrame();

    expect(container.scrollTop).toBe(859); // glued to the new bottom, not offset
  });

  it('re-glues to the bottom in the frame of a viewport shrink', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();
    expect(container.scrollTop).toBe(600);

    // A question panel appears below the list and steals 260px of height.
    geometry.clientHeight = 140;
    fireResize(container);

    // No frame may pass between the resize and the realignment.
    expect(container.scrollTop).toBe(859);
  });

  it('stays glued to the bottom when the viewport grows while pinned', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();
    expect(container.scrollTop).toBe(600);

    // The on-screen keyboard closes and the list gains 300px; the browser
    // clamps the scroll position down to the new maximum.
    geometry.clientHeight = 700;
    container.scrollTop = geometry.scrollHeight;
    container.dispatchEvent(new Event('scroll'));
    fireResize(container);
    await settle();

    expect(container.scrollTop).toBe(299);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('ignores a clamp scroll event that arrives after the viewport growth', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();
    expect(container.scrollTop).toBe(600);

    geometry.clientHeight = 700;
    container.scrollTop = geometry.scrollHeight;
    fireResize(container);
    // The scroll notification for the clamped position lands after the resize.
    container.dispatchEvent(new Event('scroll'));
    await settle();

    expect(container.scrollTop).toBe(299);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('keeps a detached reader in place when the viewport grows', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    container.scrollTop = 200;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();

    geometry.clientHeight = 700;
    fireResize(container);
    await settle();

    expect(container.scrollTop).toBe(200);
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();
  });

  it('keeps following output after a question panel appears', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();

    geometry.clientHeight = 140;
    fireResize(container);
    // The browser dispatches the pending programmatic scroll after layout settled.
    container.dispatchEvent(new Event('scroll'));

    // The agent resumes; the list must still follow the bottom.
    geometry.scrollHeight = 1400;
    const session = sessionRegistry.viewed!;
    session.messages = [...session.messages, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }];
    session.messageKeys = [...session.messageKeys, 'm2'];
    flushSync();
    await settle();
    fireResize(inner);
    paintFrame();

    expect(container.scrollTop).toBe(1259); // followed to the new bottom
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('stays glued to the bottom on a viewport shrink after re-pinning with the scroll-to-bottom button', async () => {
    container.scrollTop = geometry.scrollHeight;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    paintFrame();

    // Detach manually, then re-pin via the button.
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    container.scrollTop = 200;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    flushSync();

    const button = target.querySelector<HTMLButtonElement>('.scroll-to-bottom')!;
    expect(button).not.toBeNull();
    // Advance clock per frame so the spring animation reaches the bottom deterministically.
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    button.click();
    for (let i = 0; i < 120 && container.scrollTop < 599; i++) {
      now += 16;
      paintFrame();
      container.dispatchEvent(new Event('scroll'));
      await settle();
    }
    expect(container.scrollTop).toBeGreaterThanOrEqual(598);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();

    // A question panel or queued-message pill now shrinks the viewport.
    geometry.clientHeight = 140;
    fireResize(container);

    expect(container.scrollTop).toBe(859);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('keeps a detached reader in place on viewport resize even after scrolling down partway', async () => {
    container.scrollTop = geometry.scrollHeight;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    paintFrame();

    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    container.scrollTop = 100;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    // Reader scrolls down partway while still reading history far above the bottom.
    container.scrollTop = 250;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    flushSync();
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();

    geometry.clientHeight = 200;
    fireResize(container);
    await settle();
    flushSync();

    expect(container.scrollTop).toBe(250);
    expect(target.querySelector('.scroll-to-bottom')).not.toBeNull();
  });

  it('stays pinned when a viewport growth clamp lands subpixel-short of maxScrollTop', async () => {
    container.scrollTop = geometry.scrollHeight;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    paintFrame();

    // Viewport grows (e.g. ask_user panel closes), and fractional DPR/zoom
    // clamps scrollTop slightly below the integer scrollHeight - clientHeight.
    geometry.clientHeight = 700;
    geometry.top = 299.4;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    flushSync();

    geometry.scrollHeight = 1200;
    fireResize(inner);
    paintFrame();
    flushSync();
    expect(container.scrollTop).toBe(499);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('stays pinned when queued messages clear and a new message renders before the clamp settles', async () => {
    // Short transcript that only overflows while the panel/pill is visible.
    geometry.scrollHeight = 500;
    geometry.clientHeight = 400;
    container.scrollTop = 99;
    container.dispatchEvent(new Event('scroll'));
    await settle();
    paintFrame();

    // Panel/pill clears -> viewport grows past scrollHeight -> browser clamps to 0.
    geometry.clientHeight = 660;
    container.scrollTop = 0;
    fireResize(container);
    container.dispatchEvent(new Event('scroll'));

    // Consumed message arrives immediately, pushing scrollHeight back above clientHeight
    // before the scroll handler's deferred escape check runs.
    geometry.scrollHeight = 800;
    await settle();
    fireResize(inner);
    paintFrame();
    flushSync();

    expect(container.scrollTop).toBe(139);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('follows new bottom content when an offscreen shrink produces a net negative content resize', async () => {
    // Seed initial content height observation at 1000 and let the initial scroll finish.
    for (const observer of RecordingResizeObserver.instances) {
      if (observer.observed.has(inner)) {
        observer.callback([{ contentRect: { height: 1000 } } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    }
    paintFrame();
    paintFrame();
    expect(container.scrollTop).toBe(599);

    // An offscreen block collapses (-270px, scroll anchoring shifts scrollTop down)
    // while 100px of new output appends at the bottom (net -170px).
    geometry.scrollHeight = 830;
    geometry.top = 329; // anchored 100px above the new bottom (429)
    for (const observer of RecordingResizeObserver.instances) {
      if (observer.observed.has(inner)) {
        observer.callback([{ contentRect: { height: 830 } } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    }
    paintFrame();
    flushSync();

    expect(container.scrollTop).toBe(429);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });

  it('does not stall or detach when a collapsed selection exists and a pointer interaction starts elsewhere', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    paintFrame();

    // Clicking inside the transcript leaves a collapsed selection caret.
    const range = document.createRange();
    range.selectNodeContents(inner);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // User presses mouse down (e.g. clicking an inline option or starting a drag).
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    geometry.scrollHeight = 1200;
    fireResize(inner);
    paintFrame();

    expect(container.scrollTop).toBe(799);
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
});

describe('MessageList hidden messages', () => {
  it('renders no row for a display:false message, saved or streaming', async () => {
    const session = sessionRegistry.viewed!;
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'custom', customType: 'session-resumed', display: false, content: [{ type: 'text', text: '[session resumed]' }] } as never,
    ];
    session.messageKeys = ['m1', 'm2'];
    session.isStreaming = true;
    session.streamingKey = 'm3';
    session.streamingMessage = {
      role: 'custom',
      customType: 'session-resumed',
      display: false,
      content: [{ type: 'text', text: '[session resumed]' }],
    } as never;
    flushSync();
    await settle();

    const text = target.textContent ?? '';
    expect(text).not.toContain('[session resumed]');
    expect(text).not.toContain('session-resumed');
  });

  it('keeps the streaming indicator while the in-flight message is hidden', async () => {
    const session = sessionRegistry.viewed!;
    session.isStreaming = true;
    session.streamingKey = 'm2';
    session.streamingMessage = {
      role: 'custom',
      customType: 'session-resumed',
      display: false,
      content: [{ type: 'text', text: '[session resumed]' }],
    } as never;
    flushSync();
    await settle();

    expect(target.querySelector('.streaming-indicator-row')).not.toBeNull();
    expect(target.textContent).not.toContain('[session resumed]');
  });

  it('still renders a custom message whose display is true', async () => {
    const session = sessionRegistry.viewed!;
    session.messages = [{ role: 'custom', customType: 'agent-complete', display: true, content: [{ type: 'text', text: 'worker finished' }] } as never];
    session.messageKeys = ['m1'];
    flushSync();
    await settle();

    expect(target.textContent).toContain('worker finished');
  });
});
