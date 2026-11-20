/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { Card } from '@pimote/shared';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('$lib/mobile-viewport.svelte.js', () => ({ isMobileViewport: () => viewport.mobile }));

const { default: CardList } = await import('./CardList.svelte');

let destroy: (() => void) | undefined;

function renderCard(href: string): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const card: Card = { id: 'link-card', header: { title: 'Linked page' }, href };
  const component = mount(CardList, { target, props: { cards: [card], openInNewTab: true } });
  destroy = () => unmount(component);
  return target;
}

afterEach(async () => {
  await destroy?.();
  destroy = undefined;
  viewport.mobile = false;
  document.body.replaceChildren();
});

describe('session panel card links', () => {
  it('opens static report cards in the current tab on mobile', async () => {
    viewport.mobile = true;
    const target = renderCard('/s/report/');
    await tick();

    const link = target.querySelector('a');
    expect(link?.getAttribute('target')).toBeNull();
    expect(link?.getAttribute('rel')).toBeNull();
    expect(link?.textContent).not.toContain('opens in a new tab');
  });

  it('keeps external card links in a new tab on mobile', async () => {
    viewport.mobile = true;
    const target = renderCard('https://example.com/report');
    await tick();

    const link = target.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toContain('opens in a new tab');
  });

  it('opens static report cards in a new tab on desktop', async () => {
    const target = renderCard('/s/report/');
    await tick();

    expect(target.querySelector('a')?.getAttribute('target')).toBe('_blank');
  });
});
