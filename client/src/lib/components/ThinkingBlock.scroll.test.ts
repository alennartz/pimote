// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ThinkingBlock from './ThinkingBlock.svelte';

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
  const geometry = { scrollHeight: 1000, clientHeight: 200, top: 0 };
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
let pre: HTMLElement;
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
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ThinkingBlock, { target, props: { streaming: true, text: 'start' } });
  flushSync();
  pre = target.querySelector<HTMLElement>('.thinking-text')!;
  geometry = stubGeometry(pre);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('ThinkingBlock scroll pin', () => {
  it('follows streamed reasoning while pinned', () => {
    pre.scrollTop = geometry.scrollHeight;
    pre.dispatchEvent(new Event('scroll'));
    paintFrame();

    geometry.scrollHeight = 1400;
    fireResize(pre);
    paintFrame();

    expect(pre.scrollTop).toBe(1199); // stayed glued to the bottom of the reasoning
  });

  it('stops following after the reader scrolls up', () => {
    pre.scrollTop = geometry.scrollHeight;
    pre.dispatchEvent(new Event('scroll'));
    paintFrame();

    pre.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    pre.scrollTop = 300;
    pre.dispatchEvent(new Event('scroll'));
    flushSync();

    geometry.scrollHeight = 1400;
    fireResize(pre);
    paintFrame();

    expect(pre.scrollTop).toBe(300); // left where the reader put it
  });
});
