// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

const fakeQueue = {
  all: [] as Array<Record<string, unknown>>,
  sendResponse: vi.fn(),
};

vi.mock('$lib/stores/extension-ui-queue.svelte.js', () => ({
  INLINE_METHODS: new Set(['select', 'confirm']),
  getExtensionUiQueue: () => fakeQueue,
}));

const { default: InlineSelect } = await import('./InlineSelect.svelte');

const selectRequest = {
  requestId: 'r1',
  sessionId: 's1',
  method: 'select',
  title: 'Pick one',
  options: [
    { label: 'Option A', value: 'a' },
    { label: 'Option B', value: 'b' },
  ],
};

function setupSession() {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
}

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(InlineSelect, { target });
  return { target, destroy: () => unmount(component) };
}

afterEach(() => {
  fakeQueue.all = [];
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.innerHTML = '';
});

describe('InlineSelect focus behavior', () => {
  it('does not steal focus from the composer when a question arrives while typing', async () => {
    setupSession();
    // Simulate the composer textarea focused with the mobile keyboard open.
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    fakeQueue.all = [selectRequest];
    const view = render();
    try {
      await tick();
      const panel = view.target.querySelector<HTMLElement>('.inline-select-panel');
      expect(panel).toBeTruthy();
      // Focus must stay on the composer — blurring it collapses the mobile keyboard.
      expect(document.activeElement).toBe(composer);
    } finally {
      view.destroy();
    }
  });

  it('still focuses the panel when nothing was focused (desktop keyboard shortcuts)', async () => {
    setupSession();
    fakeQueue.all = [selectRequest];
    const view = render();
    try {
      await tick();
      const panel = view.target.querySelector<HTMLElement>('.inline-select-panel');
      expect(panel).toBeTruthy();
      expect(document.activeElement).toBe(panel);
    } finally {
      view.destroy();
    }
  });
});
