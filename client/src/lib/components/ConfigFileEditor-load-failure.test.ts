// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';

// The lazy editor chunk fails to load (stale PWA chunk after a deploy, offline).
const mockState = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('$lib/components/ExtensionCodeEditor.svelte', () => {
  mockState.attempts += 1;
  throw new Error('chunk load failed');
});

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

vi.mock('$lib/stores/connection.svelte.js', () => {
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

beforeEach(() => {
  fileEditorStore.close();
  mockState.attempts = 0;
  vi.mocked(connection.send).mockImplementation(async (command: PimoteCommand): Promise<PimoteResponse> => {
    if (command.type === 'file_get') {
      return { id: '1', success: true, data: { path: '/p/AGENTS.md', exists: true, content: '# Hello\n' } };
    }
    return { id: '1', success: true, data: { path: '/p/AGENTS.md' } };
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.mocked(connection.send).mockReset();
});

describe('ConfigFileEditor editor chunk failure', () => {
  it('surfaces an error instead of being stuck on the loading placeholder', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(ConfigFileEditor, { target });
    await tick();
    void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('The editor failed to load');
    });
    expect(document.body.textContent).not.toContain('Loading editor…');
  });

  it('clears the error on close and retries the import on reopen', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(ConfigFileEditor, { target });
    await tick();
    void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    await vi.waitFor(() => expect(mockState.attempts).toBe(1));

    fileEditorStore.close();
    await tick();
    void fileEditorStore.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');

    // Reopening must attempt the import again instead of staying in the
    // error state forever.
    await vi.waitFor(() => expect(mockState.attempts).toBe(2));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('The editor failed to load');
    });
  });
});
