// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
import { commandStore } from '$lib/stores/command-store.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

// The composer owns `/new`: it starts a fresh session in the viewed session's
// folder, then detaches the old id at user level. The text never dispatches
// to pi as a prompt, and pi's command stays out of the composer's list.

type ChangeListener = (event: { matches: boolean }) => void;
const changeListeners = new Set<ChangeListener>();
vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    get matches() {
      return false;
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

function setupSession(streaming = false) {
  sessionRegistry.addSession('s1', '/workspace/s1', 's1');
  sessionRegistry.switchTo('s1');
  const session = sessionRegistry.sessions['s1']!;
  session.isStreaming = streaming;
  session.status = streaming ? 'working' : 'idle';
  connection.ready = true;
}

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InputBar, { target }));
  for (let i = 0; i < 3; i++) await tick();
  return target;
}

async function submit(text: string) {
  const target = await render();
  const textarea = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  target.querySelector<HTMLButtonElement>('button[title="Send"], button[title="Steer"]')!.click();
  for (let i = 0; i < 6; i++) await tick();
  return textarea;
}

function sendSpy(openResponse?: PimoteResponse) {
  const sent: PimoteCommand[] = [];
  vi.spyOn(connection, 'send').mockImplementation(async (command) => {
    sent.push(command);
    if (command.type === 'open_session') {
      return openResponse ?? { id: 'open', success: true, data: { sessionId: 's2', folderPath: '/workspace/s1' } };
    }
    return { id: 'ack', success: true, data: {} };
  });
  return sent;
}

function flowVerbs(sent: PimoteCommand[]) {
  return sent.filter((command) => ['open_session', 'view_session', 'detach_session'].includes(command.type)).map((command) => command.type);
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  commandStore.clear();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
});

afterAll(() => vi.unstubAllGlobals());

describe('composer-owned /new', () => {
  it('opens a fresh session in the folder, then detaches the old id, in order', async () => {
    setupSession();
    const sent = sendSpy();
    await submit('/new');

    expect(flowVerbs(sent)).toEqual(['open_session', 'view_session', 'detach_session']);
    const open = sent.find((command) => command.type === 'open_session');
    expect(open).toMatchObject({ type: 'open_session', folderPath: '/workspace/s1' });
    expect(open).not.toHaveProperty('sessionId');
    expect(sent.find((command) => command.type === 'detach_session')).toMatchObject({ type: 'detach_session', sessionId: 's1' });
  });

  it('never sends /new to pi as a prompt, even while streaming', async () => {
    setupSession(true);
    const sent = sendSpy();
    await submit('/new');

    expect(sent.some((command) => command.type === 'prompt' || command.type === 'steer')).toBe(false);
    expect(flowVerbs(sent)).toEqual(['open_session', 'view_session', 'detach_session']);
  });

  it('keeps the old session when the open fails', async () => {
    setupSession();
    const sent = sendSpy({ id: 'open', success: false, error: 'folder missing' });
    await submit('/new');

    expect(flowVerbs(sent)).toEqual(['open_session']);
    expect(sessionRegistry.sessions['s1']).toBeDefined();
  });

  it('intercepts /new with trailing text the same way', async () => {
    setupSession();
    const sent = sendSpy();
    await submit('/new scratch that');

    expect(flowVerbs(sent)).toEqual(['open_session', 'view_session', 'detach_session']);
    expect(sent.some((command) => command.type === 'prompt')).toBe(false);
  });

  it('keeps pi’s /new out of the composer command list', async () => {
    setupSession();
    commandStore.setCommands('s1', [
      { name: 'new', description: 'Start a new conversation', hasArgCompletions: false },
      { name: 'compact', description: 'Compact context', hasArgCompletions: false },
    ]);
    const target = await render();
    const textarea = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    textarea.value = '/';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 3; i++) await tick();

    const listed = [...target.querySelectorAll('button span.font-medium')].map((span) => span.textContent);
    expect(listed).toContain('compact');
    expect(listed).not.toContain('new');
  });
});
