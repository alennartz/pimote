// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import MessageActionMenu from './MessageActionMenu.svelte';
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});
async function render(extra: { abandonedBranchCount?: number; manager?: boolean; readOnly?: boolean } = {}) {
  const store = { navigate: vi.fn().mockResolvedValue(undefined), openFocused: vi.fn().mockResolvedValue(undefined) };
  component = mount(MessageActionMenu, { target: document.body, props: { entryId: 'chosen', sessionId: 'session', abandonedBranchCount: 0, store, ...extra } });
  await tick();
  return store;
}
const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.textContent?.includes(label));
describe('message navigation actions', () => {
  it.each([0, 2])('offers redo and conditionally offers existing branches (%i)', async (count) => {
    await render({ abandonedBranchCount: count });
    expect(button('Redo from here')).toBeDefined();
    expect(button('Redo with compaction')).toBeDefined();
    expect(Boolean(button('View existing branches'))).toBe(count > 0);
  });
  it.each([{ manager: true }, { readOnly: true }])('suppresses navigation for restricted sources %j', async (restriction) => {
    await render({ abandonedBranchCount: 2, ...restriction });
    expect(button('Redo from here')).toBeUndefined();
    expect(button('Redo with compaction')).toBeUndefined();
    expect(button('View existing branches')).toBeUndefined();
  });
  it('dispatches one-click redo for the chosen message without compaction', async () => {
    const store = await render();
    button('Redo from here')!.click();
    await tick();
    expect(store.navigate).toHaveBeenCalledWith('chosen');
  });
  it('dispatches the compaction prompt for the chosen message', async () => {
    const store = await render();
    button('Redo with compaction')!.click();
    await tick();
    const input = document.querySelector('textarea')!;
    input.value = 'Keep diagnosis';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button('OK')!.click();
    await tick();
    expect(store.navigate).toHaveBeenCalledWith('chosen', { compactionPrompt: 'Keep diagnosis' });
  });
});
