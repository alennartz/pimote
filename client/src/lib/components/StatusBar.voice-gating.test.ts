// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

// Listeners registered on the (mocked) connection store, so tests can
// dispatch server events into the real stores the component reads.
const { eventListeners } = vi.hoisted(() => ({ eventListeners: new Set<(event: unknown) => void>() }));

vi.mock('$lib/stores/connection.svelte.js', () => {
  // Module-scope stores register listeners (onEvent/…) at import time;
  // capture them so tests can fire server events.
  const base: Record<string, unknown> = {
    status: 'connected',
    phase: 'ready',
    phaseLabel: 'Connected',
    send: vi.fn(async () => ({ success: true, data: {} })),
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

vi.mock('$lib/stores/session-registry.svelte.js', () => ({
  abortSession: vi.fn(async () => undefined),
  sessionRegistry: {
    viewed: null,
    sessions: {},
    goHome: vi.fn(),
    updateMeta: vi.fn(),
  },
}));

const { default: StatusBar } = await import('./StatusBar.svelte');

let destroy: (() => void) | null = null;

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(StatusBar, { target });
  destroy = () => unmount(component);
}

function callButton(): Element | null {
  return document.body.querySelector('button[aria-label="Start voice call"]');
}

function dispatchCapabilities(voice: boolean): void {
  for (const listener of eventListeners) listener({ type: 'server_capabilities', voice });
}

afterEach(() => {
  destroy?.();
  destroy = null;
});

describe('StatusBar voice-call affordance gating', () => {
  it('hides the call button until the server advertises voice', async () => {
    render();
    await tick();
    expect(callButton()).toBeNull();
  });

  it('shows the call button once the server advertises voice', async () => {
    // Advertise before mounting: $state class-field writes do not invalidate
    // template effects in the vitest runtime (see voice-call.svelte.ts), so
    // post-mount reactivity is verified by the browser build, not here.
    dispatchCapabilities(true);
    render();
    await tick();
    expect(callButton()).not.toBeNull();
  });
});
