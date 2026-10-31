// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ConversationFindBar from './ConversationFindBar.svelte';
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});
describe('find bar match navigation', () => {
  it('cycles next and previous through matches and displays their count', async () => {
    const matches = [0, 1].map((offset) => ({ messageKey: 'user', blockIndex: 0, offset, length: 1 }));
    const onMatch = vi.fn();
    component = mount(ConversationFindBar, { target: document.body, props: { matches, onMatch, onClose: vi.fn() } });
    await tick();
    expect(document.body.textContent).toContain('2');
    const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    const previous = document.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!;
    next.click();
    await tick();
    const first = onMatch.mock.lastCall![0];
    next.click();
    await tick();
    expect(onMatch.mock.lastCall![0]).not.toEqual(first);
    next.click();
    await tick();
    expect(onMatch.mock.lastCall![0]).toEqual(first);
    previous.click();
    await tick();
    expect(onMatch.mock.lastCall![0]).not.toEqual(first);
  });
  it('does not navigate an empty result set', async () => {
    const onMatch = vi.fn();
    component = mount(ConversationFindBar, { target: document.body, props: { matches: [], onMatch, onClose: vi.fn() } });
    await tick();
    document.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click();
    await tick();
    expect(onMatch).not.toHaveBeenCalled();
  });
});
