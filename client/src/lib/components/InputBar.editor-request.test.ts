// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { editorTextRequest, setEditorText } from '$lib/stores/input-bar.svelte.js';

// mobile-viewport.svelte.ts seeds its state from matchMedia at module load,
// and InputBar imports it statically — so the stub must be installed before
// the component module (and its imports) are first evaluated below.
type ChangeListener = (event: { matches: boolean }) => void;
const changeListeners = new Set<ChangeListener>();
const mobileMatches = false;

vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    get matches() {
      return mobileMatches;
    },
    addEventListener: (_type: 'change', listener: ChangeListener) => {
      changeListeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: ChangeListener) => {
      changeListeners.delete(listener);
    },
  })),
);

let InputBar: typeof import('./InputBar.svelte').default;

beforeAll(async () => {
  ({ default: InputBar } = await import('./InputBar.svelte'));
});

function setupSession(sessionId = 's1') {
  sessionRegistry.addSession(sessionId, `/workspace/${sessionId}`, sessionId);
  sessionRegistry.switchTo(sessionId);
  connection.ready = true;
  return sessionRegistry.sessions[sessionId];
}

function render() {
  const target = document.createElement('div');
  const component = mount(InputBar, { target });
  return { target, destroy: () => unmount(component) };
}

function messageTextarea(target: HTMLElement): HTMLTextAreaElement {
  return target.querySelector('textarea[aria-label="Message"]')!;
}

function goHome() {
  sessionRegistry.viewedSessionId = null;
}

afterEach(() => {
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  editorTextRequest.sessionId = '';
  editorTextRequest.text = '';
  editorTextRequest.seq = 0;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('InputBar editor text request replay', () => {
  it('does not replay a stale editor text request when remounting the same session', async () => {
    const session = setupSession();
    const first = render();
    await tick();
    first.destroy();

    // Simulate a past setEditorText for this session (tree navigation,
    // dequeue-steering, fork, extension) delivered while previously mounted.
    setEditorText('s1', 'old message from history');

    // Navigate home, then reopen the same session (fresh InputBar mount).
    goHome();
    sessionRegistry.switchTo('s1');
    const second = render();
    await tick();

    expect(messageTextarea(second.target).value).toBe('');
    expect(session.draftText).toBe('');
    second.destroy();
  });

  it('restores the persisted draft, not a stale request, on remount', async () => {
    const session = setupSession();
    const first = render();
    await tick();
    first.destroy();

    setEditorText('s1', 'old message from history');
    session.draftText = 'saved draft';

    goHome();
    sessionRegistry.switchTo('s1');
    const second = render();
    await tick();

    expect(messageTextarea(second.target).value).toBe('saved draft');
    second.destroy();
  });

  it('still applies a request that arrives while the session is mounted', async () => {
    setupSession();
    const { target, destroy } = render();
    await tick();

    setEditorText('s1', 'live text');
    await tick();

    expect(messageTextarea(target).value).toBe('live text');
    destroy();
  });

  it('persists ordinary typing in the viewed session draft', async () => {
    const session = setupSession();
    const { target, destroy } = render();
    await tick();

    const textarea = messageTextarea(target);
    textarea.value = 'typed text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    expect(session.draftText).toBe('typed text');
    destroy();
  });

  it('restores each session draft when switching views', async () => {
    const first = setupSession('s1');
    first.draftText = 'first draft';
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    sessionRegistry.sessions.s2.draftText = 'second draft';
    const { target, destroy } = render();
    await tick();

    expect(messageTextarea(target).value).toBe('first draft');
    sessionRegistry.switchTo('s2');
    await tick();
    expect(messageTextarea(target).value).toBe('second draft');
    sessionRegistry.switchTo('s1');
    await tick();
    expect(messageTextarea(target).value).toBe('first draft');
    destroy();
  });

  it('keeps injected text in the target draft while switching away and back', async () => {
    const session = setupSession('s1');
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const { target, destroy } = render();
    await tick();

    sessionRegistry.setDraftText('s1', 'injected text');
    await tick();
    expect(messageTextarea(target).value).toBe('injected text');

    sessionRegistry.switchTo('s2');
    await tick();
    sessionRegistry.switchTo('s1');
    await tick();

    expect(session.draftText).toBe('injected text');
    expect(messageTextarea(target).value).toBe('injected text');
    destroy();
  });

  it('restores injected text when the composer mounts after the injection', async () => {
    const session = setupSession('s1');
    sessionRegistry.setDraftText('s1', 'injected while unmounted');

    const { target, destroy } = render();
    await tick();

    expect(session.draftText).toBe('injected while unmounted');
    expect(messageTextarea(target).value).toBe('injected while unmounted');
    destroy();
  });
});
