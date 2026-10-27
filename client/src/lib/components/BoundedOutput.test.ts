// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import BoundedOutput from './BoundedOutput.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('BoundedOutput', () => {
  it('keeps a bounded single-line result in a scrollable max-height view', async () => {
    const target = document.createElement('div');
    const component = mount(BoundedOutput, {
      target,
      props: { text: 'A'.repeat(10_000), bounded: true },
    });
    destroy = () => unmount(component);

    await tick();

    expect(target.querySelector('pre')?.classList.contains('scrollable')).toBe(true);
  });

  it('offers expansion when a single line exceeds the bounded height', async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLPreElement.prototype, 'scrollHeight');
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLPreElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', { configurable: true, get: () => 1_000 });
    Object.defineProperty(HTMLPreElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });

    try {
      const target = document.createElement('div');
      const component = mount(BoundedOutput, {
        target,
        props: { text: 'A single long line', bounded: true },
      });
      destroy = () => unmount(component);

      await tick();

      expect(Array.from(target.querySelectorAll('button')).some((button) => button.textContent?.startsWith('Show more'))).toBe(true);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', scrollHeight);
      else delete (HTMLPreElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (clientHeight) Object.defineProperty(HTMLPreElement.prototype, 'clientHeight', clientHeight);
      else delete (HTMLPreElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it('clamps collapsed output and keeps the expanded view scrollable', async () => {
    const target = document.createElement('div');
    const text = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join('\n');
    const component = mount(BoundedOutput, {
      target,
      props: { text, bounded: true },
    });
    destroy = () => unmount(component);

    await tick();

    const pre = target.querySelector('pre');
    const toggle = Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.startsWith('Show more'));
    expect(pre?.classList.contains('clamped')).toBe(true);
    expect(toggle).toBeDefined();

    toggle!.click();
    await tick();

    expect(pre?.classList.contains('scrollable')).toBe(true);
    expect(target.textContent).toContain('Show less');
  });
});
