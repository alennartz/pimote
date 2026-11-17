// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteEvent } from '@pimote/shared';
import SessionDetailsDialog from './SessionDetailsDialog.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  connection.ready = true;
  connection.status = 'connected';
  sessionRegistry.addSession('root', '/workspace/ada', 'ada');
  sessionRegistry.switchTo('root');
  sessionRegistry.sessions['root'].sessionId = 'root-session';
  sessionRegistry.sessions['root'].sessionFile = '/sessions/root-session.jsonl';
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  sessionRegistry.clearSubagentRoot('root');
  sessionRegistry.removeSession('root');
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  connection.status = 'disconnected';
});

function openChildView(): void {
  sessionRegistry.handleEvent({
    type: 'subagent_view_snapshot',
    sessionId: 'root',
    childSessionId: 'child-session',
    path: ['worker'],
    incarnation: 'inc-1',
    viewCursor: 1,
    state: {
      model: null,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      isStreaming: false,
      isCompacting: false,
      sessionFile: '/sessions/child-session.jsonl',
      sessionId: 'child-session',
      autoCompactionEnabled: true,
      messageCount: 0,
    },
    messages: [],
  } as PimoteEvent);
  sessionRegistry.selectSubagentView('root', ['worker']);
}

async function renderDetails(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(SessionDetailsDialog, { target });
  await tick();
  target.querySelector<HTMLButtonElement>('button[title="Session details"]')!.click();
  await tick();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('session details dialog not open');
  return dialog;
}

describe('Session details identity rows', () => {
  it('shows the viewed child session id and file', async () => {
    openChildView();
    const dialog = await renderDetails();

    expect(dialog.textContent).toContain('child-session');
    expect(dialog.textContent).toContain('/sessions/child-session.jsonl');
    expect(dialog.textContent).not.toContain('/sessions/root-session.jsonl');
  });

  it('shows the root session id and file on the root view', async () => {
    const dialog = await renderDetails();

    expect(dialog.textContent).toContain('root-session');
    expect(dialog.textContent).toContain('/sessions/root-session.jsonl');
  });
});
