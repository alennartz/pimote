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
