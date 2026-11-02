// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
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
let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('bounds streaming transcript geometry work to one refresh per display frame', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const paint = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(16);
    flushSync();
  };
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>();
      constructor(public callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  const session = sessionRegistry.viewed!;
  session.messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 10 === 0 ? ('user' as const) : ('assistant' as const),
    entryId: `entry-${index}`,
    content: [{ type: 'text' as const, text: `message ${index}` }],
  }));
  session.messageKeys = session.messages.map((_, index) => `m${index}`);
  session.isStreaming = true;
  session.streamingKey = 'stream';
  session.streamingMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] };
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(MessageList, { target });
  flushSync();
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await settle();
  paint();
  const rows = [...target.querySelectorAll<HTMLElement>('.transcript-row')];
  let measurements = 0;
  let firstVisibleRow = 50;
  for (const [index, row] of rows.entries()) {
    row.getBoundingClientRect = () => {
      measurements++;
      return { bottom: index < firstVisibleRow ? -100 : 100 } as DOMRect;
    };
  }
  const container = target.querySelector<HTMLElement>('.message-list')!;
  for (let delta = 0; delta < 20; delta++) {
    session.streamingMessage.content[0].text += '.';
    flushSync();
    for (const observer of observers) {
      if (observer.targets.has(rows.at(-1)!)) observer.callback([], observer as unknown as ResizeObserver);
    }
    container.dispatchEvent(new Event('scroll'));
    await settle();
  }
  paint();
  // Sticky navigation only needs user-row geometry, even after many layout notifications.
  const userRows = session.messages.filter((message) => message.role === 'user').length;
  expect(measurements).toBeLessThanOrEqual(userRows);
  expect(target.querySelector('.sticky-preview')?.textContent).toContain('message 40');
  firstVisibleRow = 30;
  container.dispatchEvent(new Event('scroll'));
  paint();
  expect(target.querySelector('.sticky-preview')?.textContent).toContain('message 20');
});
