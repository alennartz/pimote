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
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
});

describe('PendingSteeringMessages draft restoration', () => {
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
