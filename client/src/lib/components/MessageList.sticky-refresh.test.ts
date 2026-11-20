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

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();

  constructor(public callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
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
}

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  TestResizeObserver.instances = [];
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('refreshes the sticky target after a pinned stream moves the viewport', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const paint = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(16);
    flushSync();
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  const session = sessionRegistry.viewed!;
  session.messages = Array.from({ length: 100 }, (_, index) => ({
    role: index === 50 || index === 91 ? ('user' as const) : ('assistant' as const),
    entryId: `entry-${index}`,
    content: [{ type: 'text' as const, text: `message ${index}` }],
  }));
  session.messageKeys = session.messages.map((_, index) => `m${index}`);
  session.isStreaming = true;
  session.streamingKey = 'stream';
  session.streamingMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer', streaming: true }] };

  const target = document.createElement('div');
  document.body.append(target);
  component = mount(MessageList, { target });
  flushSync();
  await settle();
  paint();

  const container = target.querySelector<HTMLElement>('.message-list')!;
  const inner = target.querySelector<HTMLElement>('.message-list-inner')!;
  const rows = [...target.querySelectorAll<HTMLElement>('.transcript-row')];
  const geometry = { contentHeight: rows.length * 40, clientHeight: 400, scrollTop: 0 };
  Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => geometry.contentHeight });
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = Math.max(0, Math.min(value, geometry.contentHeight - geometry.clientHeight));
    },
  });
  container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  for (const [index, row] of rows.entries()) {
    row.getBoundingClientRect = () => ({ top: index * 40 - geometry.scrollTop, bottom: (index + 1) * 40 - geometry.scrollTop }) as DOMRect;
  }

  geometry.scrollTop = geometry.contentHeight - geometry.clientHeight - 1;
  container.dispatchEvent(new Event('scroll'));
  paint();
  expect(target.querySelector('.sticky-preview')?.textContent).toContain('message 50');

  const rowObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(rows.at(-1)!))!;
  const contentObserver = TestResizeObserver.instances.find((observer) => observer.targets.has(inner))!;
  const previousHeight = geometry.contentHeight;
  geometry.contentHeight += 800;
  // A pending navigation refresh runs before the follow write. The row resize
  // arrives first, so it cannot queue another refresh behind that pending frame.
  container.dispatchEvent(new Event('scroll'));
  rowObserver.callback([{ target: rows.at(-1)! } as unknown as ResizeObserverEntry], rowObserver as unknown as ResizeObserver);
  contentObserver.callback([{ contentRect: { height: geometry.contentHeight } } as unknown as ResizeObserverEntry], contentObserver as unknown as ResizeObserver);
  paint();
  paint();

  expect(geometry.contentHeight).toBe(previousHeight + 800);
  expect(geometry.scrollTop).toBe(geometry.contentHeight - geometry.clientHeight - 1);
  expect(target.querySelector('.sticky-preview')?.textContent).toContain('message 91');
});
