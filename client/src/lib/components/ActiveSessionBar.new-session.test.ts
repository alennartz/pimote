// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
});

vi.mock('$lib/stores/connection.svelte.js', () => {
  const base: Record<string, unknown> = { status: 'connected', send: vi.fn(async () => ({ id: 'test', success: true, data: {} })) };
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
const { default: ActiveSessionBar } = await import('./ActiveSessionBar.svelte');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

// The session view's New session control runs the composer's /new flow:
// open a fresh session in this folder, then detach the old id at user level.

const oldId = 's1';

let target: HTMLElement;
let destroy: (() => void) | null = null;

function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ActiveSessionBar, { target });
  destroy = () => unmount(component);
}

function newSessionControl(): HTMLButtonElement {
  const control = [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'New session');
  if (!control) throw new Error('New session control not found');
  return control;
}

function sentCommands(): PimoteCommand[] {
  return vi.mocked(connection.send).mock.calls.map(([command]) => command as PimoteCommand);
}

function flowVerbs() {
  return sentCommands()
    .filter((command) => ['open_session', 'view_session', 'detach_session'].includes(command.type))
    .map((command) => command.type);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connection.send).mockResolvedValue({ id: 'test', success: true, data: {} });
  sessionRegistry.addSession(oldId, '/w/alpha', 'alpha');
  sessionRegistry.switchTo(oldId);
});

afterEach(async () => {
  destroy?.();
  destroy = null;
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.innerHTML = '';
});

describe('session view New session control', () => {
  it('carries the approved label and tooltip', async () => {
    render();
    await tick();
    expect(newSessionControl().getAttribute('title')).toBe(
      'Starts a fresh session in this folder; this one drops from your list on all your devices and keeps living for anyone else who holds it.',
    );
  });

  it('runs the /new flow: open here, view the fresh session, detach the old id', async () => {
    render();
    await tick();
    vi.mocked(connection.send).mockImplementation(async (command) => {
      if ((command as PimoteCommand).type === 'open_session') {
        return { id: 'open', success: true, data: { sessionId: 's2', folderPath: '/w/alpha' } } as PimoteResponse;
      }
      return { id: 'ack', success: true, data: {} } as PimoteResponse;
    });

    newSessionControl().click();
    for (let i = 0; i < 6; i++) await tick();

    expect(flowVerbs()).toEqual(['open_session', 'view_session', 'detach_session']);
    const open = sentCommands().find((command) => command.type === 'open_session');
    expect(open).toMatchObject({ type: 'open_session', folderPath: '/w/alpha' });
    expect(open).not.toHaveProperty('sessionId');
    expect(sentCommands().find((command) => command.type === 'detach_session')).toMatchObject({ type: 'detach_session', sessionId: 's1' });
    expect(sessionRegistry.viewedSessionId).toBe('s2');
    expect(sessionRegistry.sessions['s1']).toBeUndefined();
  });
});
