// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

interface Request {
  requestId: string;
  sessionId: string;
  method: 'select' | 'confirm';
  title: string;
  options?: { label: string; value: string }[];
}

const requestKey = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`;
const requests = new SvelteMap<string, Request>();
const fakeQueue = {
  get all() {
    return [...requests.values()];
  },
  sendResponse: vi.fn((requestId: string, sessionId: string, _data: unknown) => {
    requests.delete(requestKey(sessionId, requestId));
  }),
};
let mobile = false;

vi.mock('$lib/stores/extension-ui-queue.svelte.js', () => ({
  INLINE_METHODS: new Set(['select', 'confirm']),
  getExtensionUiQueue: () => fakeQueue,
}));
vi.mock('$lib/mobile-viewport.svelte.js', () => ({ isMobileViewport: () => mobile }));

const { default: InlineSelect } = await import('./InlineSelect.svelte');

const selectRequest: Request = {
  requestId: 'r1',
  sessionId: 's1',
  method: 'select',
  title: 'Pick one',
  options: [
    { label: 'Option A', value: 'a' },
    { label: 'Option B', value: 'b' },
  ],
};

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let composer: HTMLTextAreaElement;

function enqueue(request: Request): void {
  requests.set(requestKey(request.sessionId, request.requestId), request);
}

function resolve(request: Request): void {
  requests.delete(requestKey(request.sessionId, request.requestId));
}

function button(label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

async function waitForFocus(element: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(document.activeElement).toBe(element));
}

async function waitForFocusedButton(label: string): Promise<HTMLButtonElement> {
  await vi.waitFor(() => expect(document.activeElement).toBe(button(label)));
  return button(label);
}

function pressEnter(element: HTMLButtonElement): void {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  if (element.dispatchEvent(event)) element.click(); // jsdom does not synthesize native button activation.
}

beforeEach(async () => {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  target = document.createElement('div');
  composer = document.createElement('textarea');
  composer.id = 'session-composer';
  document.body.append(target, composer);
  component = mount(InlineSelect, { target });
  await tick();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  requests.clear();
  mobile = false;
  fakeQueue.sendResponse.mockClear();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
});

describe('InlineSelect keyboard focus', () => {
  it('focuses the first answer when a desktop question arrives while typing', async () => {
    composer.focus();
    enqueue(selectRequest);
    await waitForFocusedButton('Option A');
  });

  it('focuses the first answer of a confirmation', async () => {
    composer.focus();
    enqueue({ requestId: 'confirm', sessionId: 's1', method: 'confirm', title: 'Confirm' });
    await waitForFocusedButton('No');
  });

  it('does not take focus from an open modal', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    modal.appendChild(input);
    document.body.appendChild(modal);
    input.focus();
    enqueue(selectRequest);
    await tick();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  it('moves between answers with arrows and selects the focused answer', async () => {
    enqueue(selectRequest);
    const first = await waitForFocusedButton('Option A');
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const second = button('Option B');
    expect(document.activeElement).toBe(second);
    pressEnter(second);
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('r1', 's1', { value: 'b' });
    await waitForFocus(composer);
  });

  it('activates the focused answer rather than a different highlighted answer', async () => {
    enqueue(selectRequest);
    const first = await waitForFocusedButton('Option A');
    const second = button('Option B');
    second.focus();
    first.dispatchEvent(new MouseEvent('mouseenter'));
    pressEnter(second);
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('r1', 's1', { value: 'b' });
    await waitForFocus(composer);
  });

  it('lets Enter activate Cancel even when an answer is highlighted', async () => {
    enqueue(selectRequest);
    await waitForFocusedButton('Option A');
    const cancel = button('cancel');
    cancel.focus();
    pressEnter(cancel);
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('r1', 's1', { cancelled: true });
    await waitForFocus(composer);
  });

  it('does not intercept modified browser shortcuts', async () => {
    enqueue(selectRequest);
    const first = await waitForFocusedButton('Option A');
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true, ...modifiers });
      first.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(fakeQueue.sendResponse).not.toHaveBeenCalled();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('r1', 's1', { value: 'a' });
  });

  it('returns to the composer when Escape dismisses the question', async () => {
    enqueue(selectRequest);
    const first = await waitForFocusedButton('Option A');
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('r1', 's1', { cancelled: true });
    await waitForFocus(composer);
  });

  it('focuses the next queued question before returning to the composer', async () => {
    enqueue(selectRequest);
    enqueue({ ...selectRequest, requestId: 'r2', options: [{ label: 'Next answer', value: 'next' }] });
    const first = await waitForFocusedButton('Option A');
    pressEnter(first);
    const next = await waitForFocusedButton('Next answer');
    pressEnter(next);
    await waitForFocus(composer);
  });

  it('focuses a queued confirmation after a selection', async () => {
    enqueue(selectRequest);
    enqueue({ requestId: 'confirm', sessionId: 's1', method: 'confirm', title: 'Confirm' });
    const first = await waitForFocusedButton('Option A');
    pressEnter(first);
    const no = await waitForFocusedButton('No');
    pressEnter(no);
    expect(fakeQueue.sendResponse).toHaveBeenCalledWith('confirm', 's1', { confirmed: false });
    await waitForFocus(composer);
  });

  it('returns to the composer when a remote resolution removes the focused question', async () => {
    enqueue(selectRequest);
    await waitForFocusedButton('Option A');
    resolve(selectRequest);
    await waitForFocus(composer);
  });

  it('does not steal focus after a remote resolution if the user left the question', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    enqueue(selectRequest);
    await waitForFocusedButton('Option A');
    outside.focus();
    resolve(selectRequest);
    await tick();
    await tick();
    expect(document.activeElement).toBe(outside);
  });

  it('does not restore focus into a different session', async () => {
    sessionRegistry.addSession('s2', '/workspace/other', 'other');
    enqueue(selectRequest);
    const first = await waitForFocusedButton('Option A');
    pressEnter(first);
    sessionRegistry.switchTo('s2');
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(composer);
  });

  it('preserves focus on the mobile composer when a question arrives', async () => {
    mobile = true;
    composer.focus();
    enqueue(selectRequest);
    await tick();
    await tick();
    expect(document.activeElement).toBe(composer);
  });

  it('does not focus the mobile composer when a question is answered', async () => {
    mobile = true;
    enqueue(selectRequest);
    await tick();
    button('Option A').click();
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(composer);
  });

  it('keeps an explicit focus change made while the question opens', async () => {
    enqueue(selectRequest);
    await tick();
    const collapse = target.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')!;
    collapse.focus();
    collapse.click();
    await tick();
    expect(document.activeElement).toBe(collapse);
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
  });
});
