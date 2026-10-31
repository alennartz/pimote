// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
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
let geometry: ReturnType<typeof stubGeometry>;

beforeEach(async () => {
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
  geometry = stubGeometry(container);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
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

describe('MessageList scroll pin', () => {
  it('stays glued to the bottom when the viewport shrinks while pinned', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();
    expect(container.scrollTop).toBe(600); // pinned: real bottom of 1000/400

    // A question panel appears below the list and steals 260px of height.
    geometry.clientHeight = 140;
    fireResize(container);

    expect(container.scrollTop).toBe(860); // glued to the new bottom, not offset
  });

  it('keeps following output after a question panel appears', async () => {
    container.scrollTop = geometry.scrollHeight;
    await settle();

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

    expect(container.scrollTop).toBe(1260); // followed to the new bottom
    expect(target.querySelector('.scroll-to-bottom')).toBeNull();
  });
});
