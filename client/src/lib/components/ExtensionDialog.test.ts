// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { StateEffect } from '@codemirror/state';
import { autocompletion, completeFromList, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import type { PimoteEvent } from '@pimote/shared';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const state = vi.hoisted(() => ({
  listeners: new Set<(event: PimoteEvent) => void>(),
  send: vi.fn(async () => ({ success: true })),
}));

vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: {
    onEvent: (listener: (event: PimoteEvent) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    send: state.send,
  },
}));

vi.mock('$lib/stores/session-registry.svelte.js', () => ({ sessionRegistry: { viewedSessionId: 's1' } }));

const { default: ExtensionDialog } = await import('./ExtensionDialog.svelte');
await import('./ExtensionCodeEditor.svelte');

let component: ReturnType<typeof mount> | undefined;
let requestId = 0;

function emit(event: PimoteEvent): void {
  for (const listener of state.listeners) listener(event);
}

function request(prefill = '# Hello\n'): string {
  const id = `editor-${++requestId}`;
  emit({ type: 'extension_ui_request', sessionId: 's1', requestId: id, method: 'editor', title: 'Edit text', prefill });
  return id;
}

function replayRequest(requestId: string, prefill = '# Hello\n'): void {
  emit({ type: 'extension_ui_request', sessionId: 's1', requestId, method: 'editor', title: 'Edit text', prefill });
}

async function openEditor(prefill = '# Hello\n'): Promise<EditorView> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ExtensionDialog, { target });
  await tick();
  request(prefill);
  await vi.waitFor(() => {
    const element = document.querySelector('.cm-editor');
    if (!element) throw new Error('editor not mounted');
  });
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('editor view not found');
  return view;
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name);
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

function confirmation(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => dialog.textContent?.includes('Discard unsaved changes?')) ?? null;
}

function editorDialog(): HTMLElement | null {
  return document.querySelector('.cm-editor')?.closest('[role="dialog"]') ?? null;
}

async function clickOutside(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, clientY: 500 }));
}

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  state.send.mockClear();
  emit({ type: 'extension_ui_resolved', sessionId: 's1', requestId: `editor-${requestId}` });
});

describe('ExtensionDialog editor close policy', () => {
  it('saves the current editor text', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    button('Save').click();
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', value: 'edited' })));
  });

  it('preserves an edited value across restore replay and saves the draft', async () => {
    const original = '# Hello\n';
    const view = await openEditor(original);
    const id = `editor-${requestId}`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    emit({ type: 'session_restore', sessionId: 's1', mode: 'incremental_replay', status: 'started' });
    await tick();
    replayRequest(id, original);
    await vi.waitFor(() => {
      const element = document.querySelector('.cm-editor');
      if (!element) throw new Error('replayed editor not mounted');
      const replayed = EditorView.findFromDOM(element as HTMLElement);
      if (replayed?.state.doc.toString() !== 'edited') throw new Error('draft not restored');
    });

    emit({ type: 'session_restore', sessionId: 's1', mode: 'incremental_replay', status: 'completed' });
    await tick();
    button('Save').click();
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', requestId: id, value: 'edited' })));
  });

  it('does not let a delayed old response erase edits after restore replay', async () => {
    const original = '# Hello\n';
    const view = await openEditor(original);
    const id = `editor-${requestId}`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited before' } });
    await tick();

    let resolveSend!: (value: { success: boolean }) => void;
    state.send.mockImplementationOnce(() => new Promise((resolve) => (resolveSend = resolve)));
    button('Save').click();
    await tick();

    emit({ type: 'session_restore', sessionId: 's1', mode: 'incremental_replay', status: 'started' });
    await tick();
    replayRequest(id, original);
    await vi.waitFor(() => {
      if (!document.querySelector('.cm-editor')) throw new Error('replayed editor not mounted');
    });
    const replayed = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
    if (!replayed) throw new Error('replayed editor view not found');
    replayed.dispatch({ changes: { from: 0, to: replayed.state.doc.length, insert: 'edited after' } });
    await tick();
    emit({ type: 'session_restore', sessionId: 's1', mode: 'incremental_replay', status: 'completed' });
    resolveSend({ success: true });
    await tick();
    expect(EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)?.state.doc.toString()).toBe('edited after');
  });

  it('renders the discard confirmation above the editor modal', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    button('Cancel').click();
    await vi.waitFor(() => expect(confirmation()).not.toBeNull());

    expect(confirmation()?.classList.contains('z-[60]')).toBe(true);
    expect([...document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]')].some((overlay) => overlay.classList.contains('z-[60]'))).toBe(true);
  });

  it('does not cancel dirty edits until Discard is confirmed', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    button('Cancel').click();
    await tick();
    expect(confirmation()).not.toBeNull();
    expect(state.send).not.toHaveBeenCalled();

    button('Keep editing').click();
    await vi.waitFor(() => expect(confirmation()).toBeNull());
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(state.send).not.toHaveBeenCalled();

    button('Cancel').click();
    await tick();
    expect(confirmation()).not.toBeNull();
    button('Discard').click();
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('ignores outside interaction while dirty', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    await clickOutside();
    await tick();
    expect(confirmation()).toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(state.send).not.toHaveBeenCalled();
  });

  it('cancels on outside interaction while clean', async () => {
    await openEditor();
    await clickOutside();

    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
  });

  it('lets CodeMirror close its search panel without dismissing the editor', async () => {
    const view = await openEditor();
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector('.cm-panel')).not.toBeNull();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await tick();

    expect(document.querySelector('.cm-panel')).toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(confirmation()).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('lets CodeMirror close search from its focused input before dialog Escape handling', async () => {
    const view = await openEditor();
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('.cm-search input')).not.toBeNull());
    const searchInput = document.querySelector('.cm-search input');
    if (!(searchInput instanceof HTMLInputElement)) throw new Error('search input not mounted');
    searchInput.focus();

    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await tick();

    expect(document.querySelector('.cm-panel')).toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(state.send).not.toHaveBeenCalled();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
  });

  it('lets CodeMirror close an active completion before dialog Escape handling', async () => {
    const view = await openEditor();
    view.dispatch({
      effects: StateEffect.appendConfig.of(autocompletion({ override: [completeFromList([{ label: 'completion', type: 'keyword' }])] })),
    });
    startCompletion(view);
    await vi.waitFor(() => expect(document.querySelector('.cm-tooltip-autocomplete')).not.toBeNull());

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await tick();

    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(state.send).not.toHaveBeenCalled();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
  });

  it('treats undoing edits back to the prefill as clean', async () => {
    const original = '# Hello\n';
    const view = await openEditor(original);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
    await tick();

    button('Cancel').click();
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
    expect(confirmation()).toBeNull();
  });

  it('asks before closing from the mobile Close button when dirty', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    button('Close editor').click();
    await tick();

    expect(confirmation()).not.toBeNull();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('cancels on unhandled Escape when clean', async () => {
    const view = await openEditor();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_ui_response', cancelled: true })));
    expect(confirmation()).toBeNull();
  });

  it('prompts on unhandled Escape when dirty', async () => {
    const view = await openEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await tick();

    expect(confirmation()).not.toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(state.send).not.toHaveBeenCalled();
  });
});
