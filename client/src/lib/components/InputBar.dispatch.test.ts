// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
import InputBar from './InputBar.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { treeDialogStore } from '$lib/stores/tree-dialog.svelte.js';

// The composer settles its optimistic transcript entry and pending-steer pill
// from the dispatch outcome the server reports (started | queued | handled).

const mounted: ReturnType<typeof mount>[] = [];

function setupSession(streaming: boolean) {
  sessionRegistry.addSession('s1', '/workspace/s1', 's1');
  sessionRegistry.switchTo('s1');
  const session = sessionRegistry.sessions['s1'];
  session.isStreaming = streaming;
  session.status = streaming ? 'working' : 'idle';
  connection.ready = true;
  return session;
}

async function submit(text: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InputBar, { target }));
  await tick();
  const textarea = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  const button = target.querySelector<HTMLButtonElement>('button[title="Steer"], button[title="Send"]')!;
  button.click();
  for (let i = 0; i < 4; i++) await tick();
  return textarea;
}

function respond(data: unknown, success = true) {
  const sent: PimoteCommand[] = [];
  vi.spyOn(connection, 'send').mockImplementation(async (command) => {
    sent.push(command);
    return { id: 'r', success, ...(success ? { data } : { error: 'rejected' }) } as PimoteResponse;
  });
  return sent;
}

function texts() {
  return sessionRegistry.sessions['s1']!.messages.map((m) => m.content.find((c) => c.type === 'text')?.text);
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  treeDialogStore.closeDialog();
});

describe('prompt dispatch outcome', () => {
  it('a started prompt keeps its optimistic entry and sends its clientMessageId', async () => {
    setupSession(false);
    const sent = respond({ outcome: 'started' });
    await submit('hello');
    const command = sent[0] as Extract<PimoteCommand, { type: 'prompt' }>;
    expect(command.clientMessageId).toEqual(expect.any(String));
    expect(texts()).toEqual(['hello']);
    expect(sessionRegistry.sessions['s1']!.optimisticEntries).toEqual([expect.objectContaining({ clientMessageId: command.clientMessageId })]);
  });

  it.each(['queued', 'handled'])('a %s prompt drops its optimistic entry', async (outcome) => {
    setupSession(false);
    respond({ outcome });
    const textarea = await submit('hello');
    expect(texts()).toEqual([]);
    expect(sessionRegistry.sessions['s1']!.optimisticEntries).toEqual([]);
    expect(textarea.value).toBe('');
  });

  it('a rejected prompt drops its optimistic entry and keeps the text in the composer', async () => {
    setupSession(false);
    respond(undefined, false);
    const textarea = await submit('hello');
    expect(texts()).toEqual([]);
    expect(textarea.value).toBe('hello');
  });

  it('slash input gets no optimistic entry and no clientMessageId', async () => {
    setupSession(false);
    const sent = respond(undefined);
    await submit('/quota');
    expect(sent[0]).not.toHaveProperty('clientMessageId');
    expect(texts()).toEqual([]);
  });

  it('slash input uses the prompt path while streaming', async () => {
    setupSession(true);
    const sent = respond(undefined);
    await submit('/tree');
    expect(sent[0]).toMatchObject({ type: 'prompt', sessionId: 's1', message: '/tree' });
  });

  it('opens the tree dialog when a streaming slash command returns tree data', async () => {
    setupSession(true);
    respond({ tree: [], currentLeafId: null });
    await submit('/tree');
    expect(treeDialogStore.state).toMatchObject({ open: true, sessionId: 's1', tree: [], currentLeafId: null });
  });
});

describe('steer dispatch outcome', () => {
  it('a queued steer keeps its pending pill', async () => {
    const session = setupSession(true);
    respond({ outcome: 'queued' });
    await submit('turn left');
    expect(session.pendingSteeringMessages).toEqual(['turn left']);
  });

  it('a handled steer drops its pending pill', async () => {
    const session = setupSession(true);
    respond({ outcome: 'handled' });
    const textarea = await submit('turn left');
    expect(session.pendingSteeringMessages).toEqual([]);
    expect(textarea.value).toBe('');
  });

  it('a rejected steer drops its pill and keeps the text in the composer', async () => {
    const session = setupSession(true);
    respond(undefined, false);
    const textarea = await submit('turn left');
    expect(session.pendingSteeringMessages).toEqual([]);
    expect(textarea.value).toBe('turn left');
  });
});
