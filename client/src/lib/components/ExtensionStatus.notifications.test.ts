// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

// Listeners registered on the (mocked) connection store, so tests can
// dispatch server events into the component under test.
const { eventListeners } = vi.hoisted(() => ({ eventListeners: new Set<(event: unknown) => void>() }));

vi.mock('$lib/stores/connection.svelte.js', () => {
  const base: Record<string, unknown> = {
    status: 'connected',
    onEvent: (listener: (event: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
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

const { viewedSessionId } = vi.hoisted(() => ({ viewedSessionId: { value: null as string | null } }));

vi.mock('$lib/stores/session-registry.svelte.js', () => ({
  sessionRegistry: {
    get viewedSessionId() {
      return viewedSessionId.value;
    },
    sessions: {},
    syncViewedPanelStore: vi.fn(),
    setDraftText: vi.fn(),
  },
}));

const { default: ExtensionStatus } = await import('./ExtensionStatus.svelte');

const VIEWED = 'viewed-session';
const BACKGROUND = 'background-session';

let destroy: (() => void) | null = null;

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ExtensionStatus, { target });
  flushSync();
  destroy = () => unmount(component);
}

function dispatch(event: Record<string, unknown>): void {
  for (const listener of eventListeners) listener(event);
}

function notify(sessionId: string, message: string): void {
  dispatch({ type: 'extension_ui_request', sessionId, requestId: `req-${message}`, method: 'notify', message, notifyType: 'info' });
}

afterEach(() => {
  destroy?.();
  destroy = null;
  viewedSessionId.value = null;
});

describe('extension notify banners are scoped to their session', () => {
  it('shows a notification only while its session is viewed', () => {
    viewedSessionId.value = VIEWED;
    render();

    notify(BACKGROUND, 'Background ping');
    flushSync();
    expect(document.body.textContent).not.toContain('Background ping');

    notify(VIEWED, 'Foreground ping');
    flushSync();
    expect(document.body.textContent).toContain('Foreground ping');
  });

  it('shows nothing when no session is viewed', () => {
    viewedSessionId.value = null;
    render();

    notify(BACKGROUND, 'Background ping');
    flushSync();
    expect(document.body.textContent).not.toContain('Background ping');
  });

  it('drops pending notifications when their session closes', () => {
    viewedSessionId.value = VIEWED;
    render();

    notify(VIEWED, 'Foreground ping');
    flushSync();
    expect(document.body.textContent).toContain('Foreground ping');

    dispatch({ type: 'session_closed', sessionId: VIEWED });
    flushSync();
    expect(document.body.textContent).not.toContain('Foreground ping');
  });
});
