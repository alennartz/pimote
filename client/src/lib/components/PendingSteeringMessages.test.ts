// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import PendingSteeringMessages from './PendingSteeringMessages.svelte';
import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

function setupSession(sessionId = 's1') {
  sessionRegistry.addSession(sessionId, `/workspace/${sessionId}`, sessionId);
  sessionRegistry.switchTo(sessionId);
  return sessionRegistry.sessions[sessionId];
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionRegistry.clearSubagentRoot('s1');
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
});

describe('PendingSteeringMessages draft restoration', () => {
  it('shows the selected child queue from view events, not the root queue', async () => {
    const session = setupSession();
    session.pendingSteeringMessages = ['root message'];
    sessionRegistry.handleEvent({
      type: 'subagent_view_snapshot',
      sessionId: 's1',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc-1',
      viewCursor: 1,
      state: {
        sessionId: 'child',
        sessionFile: undefined,
        model: null,
        thinkingLevel: 'off',
        availableThinkingLevels: [],
        isStreaming: true,
        isCompacting: false,
        autoCompactionEnabled: false,
        messageCount: 0,
      },
      messages: [],
      pendingSteeringMessages: ['queued before opening'],
    });
    sessionRegistry.selectSubagentView('s1', ['worker']);
    const target = document.createElement('div');
    const component = mount(PendingSteeringMessages, { target });
    await tick();
    expect(target.textContent).toContain('queued before opening');
    expect(target.querySelector('button')).toBeNull();
    sessionRegistry.handleEvent({
      type: 'subagent_view_event',
      sessionId: 's1',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc-1',
      viewCursor: 2,
      event: { type: 'queue_update', sessionId: 'child', cursor: 2, steering: ['child message'], followUp: [] },
    });
    await tick();
    expect(target.textContent).toContain('child message');
    expect(target.textContent).not.toContain('root message');
    sessionRegistry.handleEvent({
      type: 'subagent_view_event',
      sessionId: 's1',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc-1',
      viewCursor: 3,
      event: { type: 'queue_update', sessionId: 'child', cursor: 3, steering: [], followUp: [] },
    });
    await tick();
    expect(target.textContent).not.toContain('child message');
    await unmount(component);
  });

  it('prefixes the latest target draft when the response arrives after switching away', async () => {
    const session = setupSession();
    session.pendingSteeringMessages = ['queued one', 'queued two'];
    session.draftText = 'original draft';
    let resolve!: (response: unknown) => void;
    const response = new Promise((complete) => {
      resolve = complete;
    });
    vi.spyOn(connection, 'send').mockReturnValue(response as never);

    const target = document.createElement('div');
    const component = mount(PendingSteeringMessages, { target });
    await tick();
    target.querySelector('button')!.click();
    await tick();

    const other = setupSession('s2');
    other.draftText = 'other draft';
    sessionRegistry.sessions.s1 = { ...session, draftText: 'latest draft' };
    resolve({
      id: 'dequeue-1',
      success: true,
      data: { steering: ['queued one', 'queued two'], followUp: [] },
    });
    await response;
    await tick();

    expect(sessionRegistry.sessions.s1.draftText).toBe('queued one\nqueued two\nlatest draft');
    expect(sessionRegistry.sessions.s2.draftText).toBe('other draft');
    await unmount(component);
  });
});
