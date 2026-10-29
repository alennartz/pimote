// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

let destroy: (() => void) | undefined;

function customMessage(text: string): PimoteAgentMessage {
  return {
    role: 'custom',
    customType: 'note',
    content: [{ type: 'text', text }],
  };
}

afterEach(() => {
  destroy?.();
  destroy = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('custom messages', () => {
  it('lets the header hide and restore a short body', async () => {
    const target = document.createElement('div');
    const component = mount(Message, {
      target,
      props: { message: customMessage('short body') },
    });
    destroy = () => unmount(component);

    await tick();

    const header = target.querySelector<HTMLButtonElement>('.custom-header');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(target.querySelector('.custom-content')).not.toBeNull();

    header?.click();
    await tick();

    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(target.querySelector('.custom-content')).toBeNull();

    header?.click();
    await tick();

    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(target.querySelector('.custom-content')).not.toBeNull();
  });

  it('keeps header collapse separate from the long-body show-more toggle', async () => {
    const target = document.createElement('div');
    const text = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join('\n');
    const component = mount(Message, {
      target,
      props: { message: customMessage(text) },
    });
    destroy = () => unmount(component);

    await tick();

    const header = target.querySelector<HTMLButtonElement>('.custom-header');
    const showMore = Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.includes('Show more'));
    expect(showMore).toBeDefined();
    expect(target.querySelector('.custom-text-collapsed')).not.toBeNull();

    header?.click();
    await tick();

    expect(target.querySelector('.custom-content')).toBeNull();

    header?.click();
    await tick();

    expect(target.querySelector('.custom-text-collapsed')).not.toBeNull();
    const restoredShowMore = Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.includes('Show more'));
    restoredShowMore?.click();
    await tick();

    expect(target.querySelector('.custom-text-expanded')).not.toBeNull();
    header?.click();
    await tick();

    expect(target.querySelector('.custom-content')).toBeNull();
  });

  it('auto-collapses after the body scrolls fully out of view', async () => {
    let emit: ((entries: readonly IntersectionObserverEntry[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: readonly IntersectionObserverEntry[]) => void) {
          emit = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const target = document.createElement('div');
    const component = mount(Message, {
      target,
      props: { message: customMessage('visible until it scrolls away') },
    });
    destroy = () => unmount(component);

    await tick();
    expect(target.querySelector('.custom-content')).not.toBeNull();

    emit?.([{ isIntersecting: false } as IntersectionObserverEntry]);
    await tick();

    expect(target.querySelector('.custom-content')).toBeNull();
    expect(target.querySelector('.custom-header')?.getAttribute('aria-expanded')).toBe('false');
  });
});
