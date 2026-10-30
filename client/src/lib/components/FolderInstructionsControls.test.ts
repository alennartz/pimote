// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import StatusBar from './StatusBar.svelte';
import SessionDetailsDialog from './SessionDetailsDialog.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { fileEditorStore } from '$lib/stores/file-editor.svelte.js';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  sessionRegistry.addSession('s1', '/workspace/ada', 'ada');
  sessionRegistry.switchTo('s1');
  connection.ready = true;
  connection.status = 'connected';
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  connection.status = 'disconnected';
});

async function renderControl(surface: string): Promise<HTMLButtonElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = surface === 'desktop' ? mount(StatusBar, { target }) : mount(SessionDetailsDialog, { target });
  await tick();
  if (surface === 'mobile') {
    document.querySelector<HTMLButtonElement>('button[title="Session details"]')!.click();
    await tick();
  }
  const button =
    surface === 'desktop'
      ? document.querySelector<HTMLButtonElement>('button[aria-label="Edit folder AGENTS.md"]')
      : [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Edit AGENTS.md');
  if (!(button instanceof HTMLButtonElement)) throw new Error('folder instructions control not found');
  return button;
}

describe.each(['desktop', 'mobile'])('%s folder instructions control', (surface) => {
  it('opens instructions for the viewed session folder', async () => {
    const open = vi.spyOn(fileEditorStore, 'openFolderInstructions').mockResolvedValue();
    const button = await renderControl(surface);
    button.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('/workspace/ada'));
    if (surface === 'mobile') expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(['disconnected', 'no folder', 'restoring', 'pending'])('blocks editing while %s', async (state) => {
    const open = vi.spyOn(fileEditorStore, 'openFolderInstructions').mockResolvedValue();
    const session = sessionRegistry.viewed!;
    if (state === 'disconnected') connection.status = 'disconnected';
    if (state === 'no folder') session.folderPath = '';
    if (state === 'restoring') session.isRestoring = true;
    if (state === 'pending') session.sessionId = 'pending-1';
    const button = await renderControl(surface);
    expect(button.disabled).toBe(true);
    button.click();
    await tick();
    expect(open).not.toHaveBeenCalled();
  });
});
