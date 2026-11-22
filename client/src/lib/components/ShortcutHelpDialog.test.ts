// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { formatForDisplay } from '@tanstack/svelte-hotkeys';
import { shortcutHelpStore } from '$lib/stores/shortcut-help-store.svelte.js';
import { drainBodyScrollLockCleanup } from '../../test/bits-ui-cleanup.js';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const { default: ShortcutHelpDialog } = await import('./ShortcutHelpDialog.svelte');

let destroy: (() => void) | null = null;

function render(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ShortcutHelpDialog, { target });
  destroy = () => unmount(component);
}

/** Flush the mount's initial effects before interacting. bits-ui's presence
 *  watcher swallows the first open value it observes, so a dialog opened in
 *  the same synchronous block as its mount would never render. */
async function prime(): Promise<void> {
  await tick();
  flushSync();
}

function pressKey(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** The help dialog specifically, so unrelated role=dialog elements (such as
 *  a foreign dialog planted by a test) never count. */
function helpDialogVisible(): boolean {
  return [...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes('Keyboard shortcuts'));
}

async function settle(): Promise<void> {
  await tick();
  flushSync();
  await tick();
}

beforeEach(() => {
  shortcutHelpStore.close();
});

afterEach(async () => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  await drainBodyScrollLockCleanup();
});

describe('ShortcutHelpDialog', () => {
  it('? opens the cheat sheet and lists every documented shortcut', async () => {
    render();
    await prime();
    expect(helpDialogVisible()).toBe(false);

    pressKey('?');
    await settle();

    expect(helpDialogVisible()).toBe(true);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Keyboard shortcuts');
    expect(text).toContain(formatForDisplay('Mod+K'));
    expect(text).toContain(formatForDisplay('Mod+/'));
    expect(text).toContain(formatForDisplay('Mod+F'));
    expect(text).toContain(formatForDisplay('Mod+End'));
  });

  it('? does not fire while a text field or another dialog owns focus', async () => {
    render();
    await prime();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    pressKey('?', input);
    await settle();
    expect(helpDialogVisible()).toBe(false);

    input.blur();
    const foreignDialog = document.createElement('div');
    foreignDialog.setAttribute('role', 'dialog');
    const dialogInput = document.createElement('input');
    foreignDialog.appendChild(dialogInput);
    document.body.appendChild(foreignDialog);
    dialogInput.focus();
    pressKey('?', dialogInput);
    await settle();
    expect(helpDialogVisible()).toBe(false);
  });

  it('? or Escape closes the open cheat sheet', async () => {
    render();
    await prime();
    shortcutHelpStore.open();
    await settle();
    expect(helpDialogVisible()).toBe(true);

    pressKey('?');
    await settle();
    expect(helpDialogVisible()).toBe(false);

    shortcutHelpStore.open();
    await settle();
    pressKey('Escape');
    await settle();
    expect(helpDialogVisible()).toBe(false);
  });
});
