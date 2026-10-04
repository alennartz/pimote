// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { EditorView } from '@codemirror/view';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

vi.mock('$lib/stores/connection.svelte.js', () => {
  // Module-scope stores register listeners (onEvent/onDisconnect/…) at import
  // time; answer any such call with a no-op spy.
  const base: Record<string, unknown> = { status: 'connected', send: vi.fn(async () => ({ success: true, data: {} })) };
  const connection = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      const fn = vi.fn();
      target[prop] = fn;
      return fn;
    },
  });
  return { connection };
});

const { connection } = await import('$lib/stores/connection.svelte.js');
const { fileEditorStore } = await import('$lib/stores/file-editor.svelte.js');
const { default: ConfigFileEditor } = await import('./ConfigFileEditor.svelte');

let component: ReturnType<typeof mount> | undefined;

function respond(impl: (command: PimoteCommand) => PimoteResponse | Promise<PimoteResponse>): void {
  vi.mocked(connection.send).mockImplementation(async (command) => impl(command));
}

/** Renders the dialog, opens it on an AGENTS.md with `content`, and returns the live editor view. */
async function openEditor(content: string, opts: { exists?: boolean; snippets?: string[] } = {}): Promise<EditorView> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ConfigFileEditor, { target });
  // Let the first render flush before driving the store externally.
  await tick();
  respond((command) => {
    if (command.type === 'file_get' && command.path === '~/.config/pimote/config.json') {
      return { id: '1', success: true, data: { path: '/c', exists: true, content: JSON.stringify({ tagSnippets: opts.snippets ?? ['note', 'tip'] }) } };
    }
    if (command.type === 'file_get') {
      return { id: '1', success: true, data: { path: '/p/AGENTS.md', exists: opts.exists ?? true, content } };
    }
    return { id: '1', success: true, data: { path: '/p/AGENTS.md' } };
  });
  void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
  return editor();
}

/** Waits for the lazily-loaded CodeMirror editor and returns its view. */
async function editor(): Promise<EditorView> {
  await vi.waitFor(() => {
    if (!document.querySelector('.cm-editor')) throw new Error('editor not mounted');
  });
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('editor view not found');
  return view;
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

function tagInput(): HTMLInputElement | null {
  return document.querySelector('input[aria-label="Tag name"]');
}

function confirmDialog(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.textContent?.includes('Discard unsaved changes?')) ?? null;
}

/** The main editor dialog element (as opposed to the confirmation dialog). */
function editorDialog(): HTMLElement | null {
  return document.querySelector('.cm-editor')?.closest('[role="dialog"]') ?? null;
}

async function typeTag(tag: string): Promise<HTMLInputElement> {
  button('Wrap selection with a tag').click();
  await tick();
  const input = tagInput();
  if (!input) throw new Error('tag input not shown');
  input.value = tag;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  return input;
}

beforeEach(() => {
  fileEditorStore.close();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.mocked(connection.send).mockReset();
});

describe('ConfigFileEditor', () => {
  it('opens the editor with content, title, and snippet buttons', async () => {
    await openEditor('# Hello\n');

    expect(fileEditorStore.open).toBe(true);
    expect(document.body.textContent).toContain('Agent instructions');
    expect(fileEditorStore.content).toBe('# Hello\n');
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(button('note')).toBeTruthy();
    expect(button('tip')).toBeTruthy();
  });

  it('tag button toggles the one-line input', async () => {
    await openEditor('text');
    expect(tagInput()).toBeNull();

    button('Wrap selection with a tag').click();
    await tick();
    expect(tagInput()).not.toBeNull();

    button('Wrap selection with a tag').click();
    await tick();
    expect(tagInput()).toBeNull();
  });

  it('Wrap applies wrapWithTag to the live selection', async () => {
    const view = await openEditor('# Hello world\n');
    view.dispatch({ selection: { anchor: 2, head: 7 } });

    await typeTag('note');
    button('Wrap').click();
    await tick();

    expect(view.state.doc.toString()).toBe('# <note>Hello</note> world\n');
    // Selection restores to the wrapped inner range.
    expect(view.state.selection.main.from).toBe(8);
    expect(view.state.selection.main.to).toBe(13);
    expect(fileEditorStore.dirty).toBe(true);
  });

  it('Enter in the tag input applies the wrap', async () => {
    const view = await openEditor('# Hello world\n');
    view.dispatch({ selection: { anchor: 2, head: 7 } });

    const input = await typeTag('note');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();

    expect(view.state.doc.toString()).toBe('# <note>Hello</note> world\n');
    // Enter wraps only — it must not submit the form and save.
    expect(vi.mocked(connection.send)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'file_put' }));
  });

  it('an invalid tag disables Wrap and inserts nothing', async () => {
    const view = await openEditor('# Hello\n');
    await typeTag('1bad');
    expect(button('Wrap').disabled).toBe(true);
    expect(view.state.doc.toString()).toBe('# Hello\n');
  });

  it('snippet buttons wrap with their tag directly', async () => {
    const view = await openEditor('# Hello\n');
    view.dispatch({ selection: { anchor: 2, head: 7 } });

    button('tip').click();
    await tick();

    expect(view.state.doc.toString()).toBe('# <tip>Hello</tip>\n');
  });

  it('save writes the whole content and closes the dialog', async () => {
    const view = await openEditor('# Hello\n');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();
    expect(fileEditorStore.dirty).toBe(true);

    button('Save').click();
    await vi.waitFor(() => expect(fileEditorStore.open).toBe(false));

    expect(vi.mocked(connection.send)).toHaveBeenCalledWith({
      type: 'file_put',
      path: '~/.pi/agent/AGENTS.md',
      content: 'edited',
    });
    expect(fileEditorStore.dirty).toBe(false);
  });

  it('cancel with unsaved changes asks for confirmation', async () => {
    const view = await openEditor('# Hello\n');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    button('Cancel').click();
    await tick();
    await tick();
    expect(confirmDialog()).not.toBeNull();
    expect(fileEditorStore.open).toBe(true);

    button('Keep editing').click();
    await tick();
    await tick();
    expect(confirmDialog()).toBeNull();
    expect(fileEditorStore.open).toBe(true);

    button('Cancel').click();
    await tick();
    await tick();
    expect(confirmDialog()).not.toBeNull();
    button('Discard').click();
    await tick();
    await tick();
    expect(fileEditorStore.open).toBe(false);
  });

  it('cancel without unsaved changes closes immediately', async () => {
    await openEditor('# Hello\n');

    button('Cancel').click();
    await tick();

    expect([...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent?.includes('Discard unsaved changes?'))).toBe(false);
    expect(fileEditorStore.open).toBe(false);
  });

  it('ctrl+shift+g reveals and focuses the tag input', async () => {
    await openEditor('# Hello\n');
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('dialog not found');

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));

    // Reveal is synchronous; focus lands after the input renders.
    await vi.waitFor(() => {
      const input = tagInput();
      if (!input) throw new Error('tag input not shown');
      expect(document.activeElement).toBe(input);
    });
  });

  it('ctrl+shift+g with the editor focused does not also trigger find-previous', async () => {
    const view = await openEditor('# Hello\n');

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await tick();

    // CodeMirror's Mod-Shift-g (find previous) must not open the search panel.
    expect(document.querySelector('.cm-panel')).toBeNull();
    expect(tagInput()).not.toBeNull();
  });

  it('escape with unsaved edits keeps the dialog open and asks for confirmation', async () => {
    const view = await openEditor('# Hello\n');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
    await tick();

    // Esc goes through bits-ui's own close path (unlike Cancel).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await tick();

    // The editor dialog must stay open — not close and merely linger in the DOM.
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(confirmDialog()).not.toBeNull();
    expect(fileEditorStore.open).toBe(true);

    button('Keep editing').click();
    await vi.waitFor(() => expect(confirmDialog()).toBeNull());

    // The editor is still there with the unsaved edits intact.
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(editorDialog()?.getAttribute('data-state')).toBe('open');
    expect(fileEditorStore.open).toBe(true);
    expect(fileEditorStore.content).toBe('edited');
  });

  it('escape without unsaved changes closes the dialog', async () => {
    await openEditor('# Hello\n');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();

    expect(confirmDialog()).toBeNull();
    expect(fileEditorStore.open).toBe(false);
  });

  it('keeps the editor unmounted and save disabled until the load completes', async () => {
    let resolveGet: (r: PimoteResponse) => void = () => {};
    const pendingGet = new Promise<PimoteResponse>((resolve) => (resolveGet = resolve));
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(ConfigFileEditor, { target });
    await tick();
    respond((command) => {
      if (command.type === 'file_get' && command.path === '~/.config/pimote/config.json') {
        return { id: '1', success: true, data: { path: '/c', exists: false, content: '' } };
      }
      if (command.type === 'file_get') return pendingGet;
      return { id: '1', success: true, data: { path: '/p/AGENTS.md' } };
    });
    void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    await tick();
    await tick();

    // While the load is in flight nothing can be typed or saved.
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(button('Save').disabled).toBe(true);

    resolveGet({ id: '1', success: true, data: { path: '/p/AGENTS.md', exists: true, content: '# Hello\n' } });
    await editor();
    expect(button('Save').disabled).toBe(false);
  });

  it('disables save and hides the will-create hint after a failed load', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(ConfigFileEditor, { target });
    await tick();
    respond((command) => {
      if (command.type === 'file_get' && command.path === '~/.config/pimote/config.json') {
        return { id: '1', success: true, data: { path: '/c', exists: false, content: '' } };
      }
      return { id: '1', success: false, error: 'EACCES' };
    });
    void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    await vi.waitFor(() => expect(fileEditorStore.error).toBe('EACCES'));
    await tick();

    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(button('Save').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('New file — it will be created on save.');
  });
});
