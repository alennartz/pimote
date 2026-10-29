// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteResponse } from '@pimote/shared';
import { commandStore } from '$lib/stores/command-store.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { openNewSession, sessionRegistry } from '$lib/stores/session-registry.svelte.js';

const requests = vi.hoisted(() => new Set<string>());
vi.mock('$lib/stores/extension-ui-queue.svelte.js', () => ({
  getExtensionUiQueue: () => ({ hasRequestForSession: (sessionId: string) => requests.has(sessionId) }),
}));

type ChangeListener = (event: { matches: boolean }) => void;
const changeListeners = new Set<ChangeListener>();
let mobileMatches = false;
vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    get matches() {
      return mobileMatches;
    },
    addEventListener: (_type: 'change', listener: ChangeListener) => changeListeners.add(listener),
    removeEventListener: (_type: 'change', listener: ChangeListener) => changeListeners.delete(listener),
  })),
);

let InputBar: typeof import('./InputBar.svelte').default;
const mounted: ReturnType<typeof mount>[] = [];

beforeAll(async () => {
  Element.prototype.scrollIntoView ??= () => {};
  ({ default: InputBar } = await import('./InputBar.svelte'));
});

function setMobile(matches: boolean) {
  mobileMatches = matches;
  for (const listener of changeListeners) listener({ matches });
}

function setupSession(sessionId = 's1') {
  sessionRegistry.addSession(sessionId, `/workspace/${sessionId}`, sessionId);
  sessionRegistry.switchTo(sessionId);
  connection.ready = true;
}

async function settle() {
  for (let i = 0; i < 3; i++) await tick();
}

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InputBar, { target }));
  await settle();
  return target;
}

function composer(target: HTMLElement): HTMLTextAreaElement {
  return target.querySelector<HTMLTextAreaElement>('#session-composer')!;
}

async function enter(target: HTMLElement, text: string) {
  const textarea = composer(target);
  textarea.focus();
  textarea.value = text;
  textarea.setSelectionRange(text.length, text.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  return composer(target);
}

function keydown(element: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  element.dispatchEvent(event);
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMobile(false);
  requests.clear();
  commandStore.clear();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
});

afterAll(() => vi.unstubAllGlobals());

describe('composer autocomplete keyboard behavior', () => {
  it('lets Tab and Shift+Tab pass and submits text when no commands match', async () => {
    setupSession();
    commandStore.setCommands('s1', [{ name: 'alpha', description: 'First', hasArgCompletions: false }]);
    const sent = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'prompt', success: true, data: { outcome: 'handled' } });
    const target = await render();
    const textarea = await enter(target, '/unmatched');

    expect(keydown(textarea, 'Tab').defaultPrevented).toBe(false);
    expect(keydown(textarea, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(keydown(textarea, 'ArrowUp').defaultPrevented).toBe(false);
    expect(keydown(textarea, 'ArrowDown').defaultPrevented).toBe(false);
    expect(keydown(textarea, 'Enter').defaultPrevented).toBe(true);
    await settle();

    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', sessionId: 's1', message: '/unmatched' }));
  });

  it('does not trap Tab or Enter while file suggestions are loading', async () => {
    setupSession();
    vi.useFakeTimers();
    const sent = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'prompt', success: true, data: { outcome: 'started' } });
    const target = await render();
    const textarea = await enter(target, 'inspect @missing');

    expect(keydown(textarea, 'Tab').defaultPrevented).toBe(false);
    expect(keydown(textarea, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(keydown(textarea, 'Enter').defaultPrevented).toBe(true);
    await settle();

    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', sessionId: 's1', message: 'inspect @missing' }));
  });

  it('selects a highlighted completion while leaving Shift+Tab available', async () => {
    setupSession();
    commandStore.setCommands('s1', [
      { name: 'alpha', description: 'First', hasArgCompletions: false },
      { name: 'beta', description: 'Second', hasArgCompletions: false },
    ]);
    const sent = vi.spyOn(connection, 'send');
    const target = await render();
    const textarea = await enter(target, '/');

    expect(keydown(textarea, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(textarea.value).toBe('/');
    expect(keydown(textarea, 'ArrowDown').defaultPrevented).toBe(true);
    await settle();
    expect(keydown(textarea, 'Enter').defaultPrevented).toBe(true);
    await settle();

    expect(textarea.value).toBe('/beta ');
    expect(document.activeElement).toBe(textarea);
    expect(sent).not.toHaveBeenCalled();
  });

  it('accepts a visible completion with Tab', async () => {
    setupSession();
    commandStore.setCommands('s1', [{ name: 'alpha', description: 'First', hasArgCompletions: false }]);
    const target = await render();
    const textarea = await enter(target, '/');

    expect(keydown(textarea, 'Tab').defaultPrevented).toBe(true);
    await settle();
    expect(textarea.value).toBe('/alpha ');
    expect(document.activeElement).toBe(textarea);
  });

  it('clears the previous session autocomplete when switching sessions', async () => {
    setupSession();
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    sessionRegistry.sessions.s2!.draftText = 'next draft';
    commandStore.setCommands('s1', [{ name: 'alpha', description: 'First', hasArgCompletions: false }]);
    const sent = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'prompt', success: true, data: { outcome: 'started' } });
    const target = await render();
    await enter(target, '/');

    sessionRegistry.switchTo('s2');
    await settle();
    const textarea = composer(target);
    expect(textarea.value).toBe('next draft');
    keydown(textarea, 'Enter');
    await settle();
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', sessionId: 's2', message: 'next draft' }));
  });
});

describe('composer focus on session navigation', () => {
  it('focuses the composer when a session view opens', async () => {
    setupSession();
    const target = await render();
    expect(document.activeElement).toBe(composer(target));
  });

  it('focuses the active editor when switching to an open session', async () => {
    setupSession();
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    sessionRegistry.sessions.s2!.draftText = '!git status';
    const target = await render();
    const sessionButton = document.createElement('button');
    document.body.appendChild(sessionButton);
    sessionButton.focus();

    sessionRegistry.switchTo('s2');
    await settle();

    expect(composer(target).getAttribute('aria-label')).toBe('Bash command');
    expect(document.activeElement).toBe(composer(target));
  });

  it('does not focus the composer over an extension question', async () => {
    setupSession();
    requests.add('s1');
    const target = await render();
    expect(document.activeElement).not.toBe(composer(target));
  });

  it('does not take focus from an open modal when switching sessions', async () => {
    setupSession();
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const target = await render();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    modal.appendChild(input);
    document.body.appendChild(modal);
    input.focus();

    sessionRegistry.switchTo('s2');
    await settle();
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(composer(target));
  });

  it('does not steal focus from another control on updates or remote replacement', async () => {
    setupSession();
    const target = await render();
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    sessionRegistry.sessions.s1!.isStreaming = true;
    await settle();
    expect(document.activeElement).toBe(other);

    sessionRegistry.replaceSession('s1', 's2', '/workspace/s2', 's2');
    await settle();
    expect(document.activeElement).toBe(other);
    expect(composer(target).disabled).toBe(false);
  });

  it.each([false, true])('focuses a new session only if the user has not moved focus while it opens (moved=%s)', async (moved) => {
    setupSession();
    const target = await render();
    const start = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(start, other);
    start.focus();
    const response = deferred<PimoteResponse>();
    vi.spyOn(connection, 'send').mockImplementation((request) => {
      if (request.type === 'open_session') return response.promise;
      return Promise.resolve({ id: 'background', success: false });
    });

    const opening = openNewSession('/workspace/new');
    await settle();
    expect(composer(target).disabled).toBe(true);
    if (moved) other.focus();
    response.resolve({ id: 'open', success: true, data: { sessionId: 'new-session' } });
    await opening;
    await settle();

    expect(composer(target).disabled).toBe(false);
    expect(document.activeElement).toBe(moved ? other : composer(target));
  });

  it('focuses an existing session when switching away from a pending session', async () => {
    setupSession();
    const target = await render();
    const response = deferred<PimoteResponse>();
    vi.spyOn(connection, 'send').mockReturnValue(response.promise);
    const opening = openNewSession('/workspace/new');
    await settle();

    const sessionButton = document.createElement('button');
    document.body.appendChild(sessionButton);
    sessionButton.focus();
    sessionRegistry.switchTo('s1');
    await settle();
    expect(document.activeElement).toBe(composer(target));

    response.resolve({ id: 'open', success: false, error: 'failed' });
    await opening;
  });

  it('does not open the mobile keyboard on session open or switch', async () => {
    setMobile(true);
    setupSession();
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const target = await render();
    expect(document.activeElement).not.toBe(composer(target));

    const sessionButton = document.createElement('button');
    document.body.appendChild(sessionButton);
    sessionButton.focus();
    sessionRegistry.switchTo('s2');
    await settle();
    expect(document.activeElement).toBe(sessionButton);
  });
});
