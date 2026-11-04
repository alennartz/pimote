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

type RenderOptions = {
  abandonedBranchCount?: number;
  manager?: boolean;
  readOnly?: boolean;
  copyText?: string;
  ttsText?: string;
  messageKey?: string;
  onFork?: (entryId: string) => void | Promise<void>;
};

async function render(extra: RenderOptions = {}) {
  const store = { navigate: vi.fn().mockResolvedValue(undefined), openFocused: vi.fn().mockResolvedValue(undefined) };
  const onFork = extra.onFork ?? vi.fn();
  component = mount(MessageActionMenu, {
    target: document.body,
    props: { entryId: 'chosen', sessionId: 'session', abandonedBranchCount: 0, store, onFork, ...extra },
  });
  await tick();
  return { store, onFork };
}

function menu(): HTMLElement {
  return document.querySelector<HTMLElement>('.message-action-menu')!;
}

function menuButton(label: string): HTMLButtonElement | undefined {
  return [...menu().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === label);
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label);
}

describe('message navigation actions', () => {
  it.each([0, 2])('offers icon-only actions and conditionally offers existing branches (%i)', async (count) => {
    await render({ abandonedBranchCount: count });

    const redo = menuButton('Redo from here');
    const compaction = menuButton('Rewind with compaction');
    const branches = menuButton(`View existing branches (${count})`);

    expect(redo).toBeDefined();
    expect(redo?.getAttribute('title')).toBe('Redo from here');
    expect(redo?.textContent?.trim()).toBe('');
    expect(compaction).toBeDefined();
    expect(compaction?.getAttribute('title')).toBe('Rewind with compaction');
    expect(compaction?.textContent?.trim()).toBe('');
    if (count > 0) {
      expect(branches).toBeDefined();
      expect(branches?.getAttribute('title')).toBe('View existing branches');
      expect(branches?.textContent?.trim()).toBe(String(count));
    } else {
      expect(branches).toBeUndefined();
    }
  });

  it.each([{ manager: true }, { readOnly: true }])('suppresses navigation for restricted sources %j', async (restriction) => {
    await render({ abandonedBranchCount: 2, ...restriction });
    expect(menu().querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });

  it('keeps copy and read-aloud actions icon-only with accessible labels', async () => {
    await render({ copyText: 'message', ttsText: 'message', messageKey: 'message-key' });

    const readAloud = menuButton('Read aloud');
    const copy = menuButton('Copy message');

    expect(readAloud).toBeDefined();
    expect(readAloud?.getAttribute('title')).toBe('Read aloud');
    expect(readAloud?.textContent?.trim()).toBe('');
    expect(copy).toBeDefined();
    expect(copy?.getAttribute('title')).toBe('Copy message');
    expect(copy?.textContent?.trim()).toBe('');
  });

  it('dispatches one-click redo for the chosen message without compaction', async () => {
    const { store } = await render();
    menuButton('Redo from here')!.click();
    await tick();
    expect(store.navigate).toHaveBeenCalledWith('chosen');
  });

  it('dispatches the compaction prompt for the chosen message', async () => {
    const { store } = await render();
    menuButton('Rewind with compaction')!.click();
    await tick();
    const input = document.querySelector('textarea')!;
    input.value = 'Keep diagnosis';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialogButton('OK')!.click();
    await tick();
    expect(store.navigate).toHaveBeenCalledWith('chosen', { compactionPrompt: 'Keep diagnosis' });
  });

  it('opens existing branches for the chosen message', async () => {
    const { store } = await render({ abandonedBranchCount: 2 });
    menuButton('View existing branches (2)')!.click();
    await tick();
    expect(store.openFocused).toHaveBeenCalledWith('session', 'chosen');
  });

  it('offers fork from this message only when a fork handler is provided', async () => {
    const withFork = await render({ onFork: vi.fn() });
    const fork = menuButton('Fork from this message');
    expect(fork).toBeDefined();
    fork!.click();
    await tick();
    expect(withFork.onFork).toHaveBeenCalledWith('chosen');

    await unmount(component!);
    component = undefined;
    document.body.replaceChildren();
    await render({ onFork: undefined });
    expect(menuButton('Fork from this message')).toBeUndefined();
  });
});
