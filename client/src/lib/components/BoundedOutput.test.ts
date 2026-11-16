// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import BoundedOutput from './BoundedOutput.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function bodyState(target: HTMLElement): string | null | undefined {
  return target.querySelector('[data-state]')?.getAttribute('data-state');
}

function showMoreButton(target: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.startsWith('Show more'));
}

describe('BoundedOutput', () => {
  it('keeps a bounded single-line result capped and scrollable', async () => {
    const target = document.createElement('div');
    const component = mount(BoundedOutput, {
      target,
      props: { text: 'A'.repeat(10_000), bounded: true },
    });
    destroy = () => unmount(component);

    await tick();

    expect(bodyState(target)).toBe('capped');
  });

  it('renders ANSI styles and escapes text when enabled', async () => {
    const target = document.createElement('div');
    const text = '\u001b[31mred\u001b[0m <img src=x onerror=alert(1)>';
    const component = mount(BoundedOutput, {
      target,
      props: { text, renderAnsi: true },
    });
    destroy = () => unmount(component);
    await tick();

    const pre = target.querySelector('pre');
    expect(pre?.innerHTML).toContain('<span style="color:#A00">red</span>');
    expect(pre?.innerHTML).toContain('&lt;img src=x');
    expect(pre?.textContent).toBe('red <img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });

  it('offers expansion when a single line exceeds the bounded height', async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 1_000 });

    try {
      const target = document.createElement('div');
      const component = mount(BoundedOutput, {
        target,
        props: { text: 'A single long line', bounded: true },
      });
      destroy = () => unmount(component);

      await tick();

      expect(showMoreButton(target)).toBeDefined();
    } finally {
      if (scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeight);
      else delete (Element.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('clamps collapsed output and expands to the rest of it', async () => {
    const target = document.createElement('div');
    const text = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join('\n');
    const component = mount(BoundedOutput, {
      target,
      props: { text, bounded: true },
    });
    destroy = () => unmount(component);

    await tick();

    expect(bodyState(target)).toBe('clamped');
    expect(target.textContent).not.toContain('line 11');

    showMoreButton(target)!.click();
    await tick();

    expect(bodyState(target)).toBe('expanded');
    expect(target.textContent).toContain('line 11');
    expect(target.textContent).toContain('Show less');
  });
});
