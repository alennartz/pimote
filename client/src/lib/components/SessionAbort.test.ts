// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteResponse } from '@pimote/shared';
import InputBar from './InputBar.svelte';
import MessageList from './MessageList.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { editorTextRequest } from '$lib/stores/input-bar.svelte.js';

const mounted: ReturnType<typeof mount>[] = [];

function setupSession(sessionId = 's1') {
  sessionRegistry.addSession(sessionId, `/workspace/${sessionId}`, sessionId);
  sessionRegistry.switchTo(sessionId);
  const session = sessionRegistry.sessions[sessionId];
  session.isStreaming = true;
  session.status = 'working';
  connection.ready = true;
  return session;
}

function render(withMessageList = false) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  if (withMessageList) mounted.push(mount(MessageList, { target }));
  const inputTarget = document.createElement('div');
  target.appendChild(inputTarget);
  mounted.push(mount(InputBar, { target: inputTarget }));
  return { target, inputTarget };
}

function messageTextarea(target: HTMLElement) {
  return target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
}

async function enterDraft(target: HTMLElement, text: string) {
  const textarea = messageTextarea(target);
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

function deferredResponse() {
  let resolve!: (response: PimoteResponse) => void;
  const promise = new Promise<PimoteResponse>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function receiveResponse(response: ReturnType<typeof deferredResponse>, value: PimoteResponse) {
  response.resolve(value);
  await response.promise;
  await tick();
  await tick();
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  editorTextRequest.sessionId = '';
  editorTextRequest.text = '';
  editorTextRequest.seq = 0;
});

describe('explicit session abort restoration', () => {
  it.each(['desktop', 'escape', 'mobile'] as const)('%s abort restores the response queues only after notification, preserving the latest draft', async (entryPoint) => {
    const session = setupSession();
    session.draftText = 'initial draft';
    session.pendingSteeringMessages = ['queued first', 'queued second'];
    const response = deferredResponse();
    const send = vi.spyOn(connection, 'send').mockReturnValue(response.promise);
    const view = render(entryPoint === 'mobile');
    await tick();

    if (entryPoint === 'escape') {
      messageTextarea(view.target).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      const abortTarget = entryPoint === 'mobile' ? view.target : view.inputTarget;
      abortTarget.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    }
    await tick();

    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'abort', sessionId: 's1' });
    expect(messageTextarea(view.target).value).toBe('initial draft');
    expect(session.draftText).toBe('initial draft');
    expect(session.pendingSteeringMessages).toEqual(['queued first', 'queued second']);

    await enterDraft(view.target, 'latest draft\nwith whitespace  ');
    // Settled can precede the command response. It does not own queue recovery.
    sessionRegistry.handleEvent({ type: 'agent_settled', sessionId: 's1', cursor: 1 });
    await tick();
    expect(messageTextarea(view.target).value).toBe('latest draft\nwith whitespace  ');
    expect(session.pendingSteeringMessages).toEqual(['queued first', 'queued second']);
    sessionRegistry.handleEvent({ type: 'queue_update', sessionId: 's1', cursor: 2, steering: [], followUp: [] });

    await receiveResponse(response, {
      id: 'abort-1',
      success: true,
      data: { steering: ['queued first', 'queued second'], followUp: ['follow first', 'follow second'] },
    });

    const restored = 'queued first\nqueued second\nfollow first\nfollow second\nlatest draft\nwith whitespace  ';
    expect(messageTextarea(view.target).value).toBe(restored);
    expect(session.draftText).toBe(restored);
    expect(session.pendingSteeringMessages).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('restores follow-ups without relying on the local steering list and keeps the draft across remounts', async () => {
    const session = setupSession();
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'abort-1', success: true, data: { steering: [], followUp: ['first follow-up', 'second follow-up'] } });
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await Promise.resolve();
    await tick();

    expect(session.draftText).toBe('first follow-up\nsecond follow-up');
    expect(messageTextarea(view.target).value).toBe(session.draftText);
    expect(send).toHaveBeenCalledTimes(1);

    for (const component of mounted.splice(0)) await unmount(component);
    const remounted = render();
    await tick();
    expect(messageTextarea(remounted.target).value).toBe('first follow-up\nsecond follow-up');
  });

  it('restores cleared queues from a failed abort response without falsely marking the session idle', async () => {
    const session = setupSession();
    session.draftText = 'keep draft';
    session.pendingSteeringMessages = ['queued'];
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'abort-1', success: false, error: 'abort_timeout', data: { steering: ['queued'], followUp: ['follow-up'] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    sessionRegistry.handleEvent({ type: 'queue_update', sessionId: 's1', cursor: 1, steering: [], followUp: [] });
    await Promise.resolve();
    await tick();

    expect(messageTextarea(view.target).value).toBe('queued\nfollow-up\nkeep draft');
    expect(session.draftText).toBe('queued\nfollow-up\nkeep draft');
    expect(session.pendingSteeringMessages).toEqual([]);
    expect(session.isStreaming).toBe(true);
    expect(session.status).toBe('working');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected response', 'connection loss'] as const)('does not clear pending messages or send again on %s without queue data', async (failure) => {
    const session = setupSession();
    session.draftText = 'keep draft';
    session.pendingSteeringMessages = ['queued'];
    const send = vi.spyOn(connection, 'send');
    if (failure === 'connection loss') send.mockRejectedValue(new Error('WebSocket closed'));
    else send.mockResolvedValue({ id: 'abort-1', success: false, error: 'session_owned' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await Promise.resolve();
    await tick();

    expect(messageTextarea(view.target).value).toBe('keep draft');
    expect(session.draftText).toBe('keep draft');
    expect(session.pendingSteeringMessages).toEqual(['queued']);
    expect(session.isStreaming).toBe(true);
    expect(session.status).toBe('working');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([null, { steering: ['queued'] }, { steering: ['queued'], followUp: [42] }])('does not change the draft or pending list for invalid queue data %j', async (data) => {
    const session = setupSession();
    session.draftText = 'keep draft';
    session.pendingSteeringMessages = ['queued'];
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'abort-1', success: true, data });
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await Promise.resolve();
    await tick();

    expect(messageTextarea(view.target).value).toBe('keep draft');
    expect(session.draftText).toBe('keep draft');
    expect(session.pendingSteeringMessages).toEqual(['queued']);
    expect(session.isStreaming).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('restores to the originating session after switching away, using its current registry snapshot', async () => {
    const before = setupSession();
    before.draftText = 'original draft';
    const response = deferredResponse();
    const send = vi.spyOn(connection, 'send').mockReturnValue(response.promise);
    const view = render();
    await tick();
    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await tick();

    const other = setupSession('s2');
    other.draftText = 'other draft';
    // A full resync replaces the per-session object while abort is in flight.
    sessionRegistry.sessions.s1 = { ...before, draftText: 'latest original draft' };
    await tick();
    expect(messageTextarea(view.target).value).toBe('other draft');

    await receiveResponse(response, { id: 'abort-1', success: true, data: { steering: ['returned'], followUp: ['follow-up'] } });

    expect(messageTextarea(view.target).value).toBe('other draft');
    expect(other.draftText).toBe('other draft');
    expect(sessionRegistry.sessions.s1.draftText).toBe('returned\nfollow-up\nlatest original draft');
    sessionRegistry.switchTo('s1');
    await tick();
    expect(messageTextarea(view.target).value).toBe('returned\nfollow-up\nlatest original draft');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['new steering', 'queued steering'])('preserves %s submitted while abort is awaiting its response', async (newText) => {
    const session = setupSession();
    session.pendingSteeringMessages = ['queued steering'];
    const response = deferredResponse();
    const send = vi.spyOn(connection, 'send').mockImplementation((command) => {
      if (command.type === 'abort') return response.promise;
      return Promise.resolve({ id: 'steer-1', success: true });
    });
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    // clearQueue broadcasts the empty snapshot before the abort response.
    sessionRegistry.handleEvent({ type: 'queue_update', sessionId: 's1', cursor: 1, steering: [], followUp: [] });
    await tick();
    expect(session.pendingSteeringMessages).toEqual([]);
    await enterDraft(view.target, newText);
    view.target.querySelector<HTMLButtonElement>('button[title="Steer"]')!.click();
    await tick();
    await tick();
    expect(session.pendingSteeringMessages).toEqual([newText]);
    sessionRegistry.handleEvent({ type: 'queue_update', sessionId: 's1', cursor: 2, steering: [newText], followUp: [] });
    expect(session.draftText).toBe('');

    await receiveResponse(response, { id: 'abort-1', success: true, data: { steering: ['queued steering'], followUp: [] } });

    expect(session.pendingSteeringMessages).toEqual([newText]);
    expect(messageTextarea(view.target).value).toBe('queued steering');
    expect(session.draftText).toBe('queued steering');
    expect(send.mock.calls.map(([command]) => command.type)).toEqual(['abort', 'steer']);
  });

  it('preserves the existing draft and unacknowledged pending messages when the returned queue is empty', async () => {
    const session = setupSession();
    session.draftText = '  untouched draft\n';
    session.pendingSteeringMessages = ['unacknowledged steering'];
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'abort-1', success: true, data: { steering: [], followUp: [] } });
    const view = render();
    await tick();

    view.target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await Promise.resolve();
    await tick();

    expect(messageTextarea(view.target).value).toBe('  untouched draft\n');
    expect(session.draftText).toBe('  untouched draft\n');
    expect(session.pendingSteeringMessages).toEqual(['unacknowledged steering']);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
