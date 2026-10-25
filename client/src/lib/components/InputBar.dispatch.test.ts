// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
import InputBar from './InputBar.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';
import { treeDialogStore } from '$lib/stores/tree-dialog.svelte.js';
import { pushSharedImages, sharedImagesRequest } from '$lib/stores/input-bar.svelte.js';

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

async function submit(text: string, images: string[] = []) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InputBar, { target }));
  await tick();
  if (images.length > 0) {
    pushSharedImages(images);
    await tick();
  }
  const textarea = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  const button = target.querySelector<HTMLButtonElement>('button[title="Steer"], button[title="Send"]')!;
  button.click();
  for (let i = 0; i < 4; i++) await tick();
  return textarea;
}

async function typeInto(textarea: HTMLTextAreaElement, text: string) {
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
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
  sharedImagesRequest.images = [];
  sharedImagesRequest.seq = 0;
});

describe('prompt dispatch outcome', () => {
  it('clears the composer when the optimistic entry is added, before the dispatch response', async () => {
    setupSession(false);
    let release!: (response: PimoteResponse) => void;
    const sent = vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('hello');

    expect(textarea.value).toBe('');
    expect(texts()).toEqual(['hello']);
    expect(sent).toHaveBeenCalledTimes(1);

    release({ id: 'r', success: true, data: { outcome: 'started' } });
    await tick();
  });

  it('does not clear a newer draft when the dispatch response arrives', async () => {
    setupSession(false);
    let release!: (response: PimoteResponse) => void;
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('hello');

    textarea.value = 'next draft';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    release({ id: 'r', success: true, data: { outcome: 'started' } });
    for (let i = 0; i < 4; i++) await tick();

    expect(textarea.value).toBe('next draft');
  });

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

describe('compact dispatch outcome', () => {
  it('clears an unchanged draft on success and captures the originating session and instructions', async () => {
    const session = setupSession(false);
    let release!: (response: PimoteResponse) => void;
    const send = vi.spyOn(connection, 'send').mockImplementation((command) => {
      expect(command).toEqual({
        type: 'compact',
        sessionId: 's1',
        customInstructions: 'focus on file diffs',
      });
      return new Promise<PimoteResponse>((resolve) => {
        release = resolve;
      });
    });
    const textarea = await submit('  /compact focus on file diffs  ');

    expect(session.draftText).toBe('  /compact focus on file diffs  ');
    expect(send).toHaveBeenCalledTimes(1);
    release({ id: 'r', success: true });
    for (let i = 0; i < 4; i++) await tick();

    expect(textarea.value).toBe('');
    expect(session.draftText).toBe('');
  });

  it('keeps a newer draft typed in the originating session', async () => {
    const session = setupSession(false);
    let release!: (response: PimoteResponse) => void;
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('/compact old instructions');
    await typeInto(textarea, '/compact newer instructions');

    release({ id: 'r', success: true });
    for (let i = 0; i < 4; i++) await tick();

    expect(textarea.value).toBe('/compact newer instructions');
    expect(session.draftText).toBe('/compact newer instructions');
  });

  it('clears the unchanged originating draft without touching another viewed session', async () => {
    const session = setupSession(false);
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const other = sessionRegistry.sessions['s2']!;
    other.draftText = 's2 draft';
    let release!: (response: PimoteResponse) => void;
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('/compact old instructions');

    sessionRegistry.switchTo('s2');
    await tick();
    expect(textarea.value).toBe('s2 draft');
    release({ id: 'r', success: true });
    for (let i = 0; i < 4; i++) await tick();

    expect(session.draftText).toBe('');
    expect(other.draftText).toBe('s2 draft');
    expect(textarea.value).toBe('s2 draft');

    sessionRegistry.switchTo('s1');
    await tick();
    expect(textarea.value).toBe('');
  });

  it('keeps the draft when the compact response is rejected', async () => {
    const session = setupSession(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'r', success: false, error: 'rejected' });
    const textarea = await submit('/compact old instructions');

    expect(textarea.value).toBe('/compact old instructions');
    expect(session.draftText).toBe('/compact old instructions');
    expect(error).toHaveBeenCalledWith('Compact rejected:', 'rejected');
  });

  it('keeps the draft when compact dispatch throws', async () => {
    const session = setupSession(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(connection, 'send').mockRejectedValue(new Error('offline'));
    const textarea = await submit('/compact old instructions');

    expect(textarea.value).toBe('/compact old instructions');
    expect(session.draftText).toBe('/compact old instructions');
  });

  it('keeps both drafts when a compact response fails after switching sessions', async () => {
    const session = setupSession(false);
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const other = sessionRegistry.sessions['s2']!;
    other.draftText = 's2 draft';
    let release!: (response: PimoteResponse) => void;
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('/compact old instructions');

    sessionRegistry.switchTo('s2');
    await tick();
    release({ id: 'r', success: false, error: 'rejected' });
    for (let i = 0; i < 4; i++) await tick();

    expect(session.draftText).toBe('/compact old instructions');
    expect(other.draftText).toBe('s2 draft');
    expect(textarea.value).toBe('s2 draft');
  });
});

describe('steer dispatch outcome', () => {
  it('clears the composer when the pending steer is shown, before the dispatch response', async () => {
    const session = setupSession(true);
    let release!: (response: PimoteResponse) => void;
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise<PimoteResponse>((resolve) => {
          release = resolve;
        }),
    );
    const textarea = await submit('turn left');

    expect(textarea.value).toBe('');
    expect(session.pendingSteeringMessages).toEqual(['turn left']);

    release({ id: 'r', success: true, data: { outcome: 'queued' } });
    await tick();
  });

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

  it('sends staged images with a text steer and clears them after dispatch', async () => {
    const session = setupSession(true);
    const image = 'data:image/png;base64,AAA';
    const sent = respond({ outcome: 'queued' });
    const textarea = await submit('turn left', [image]);
    expect(sent[0]).toMatchObject({ type: 'steer', sessionId: 's1', message: 'turn left', images: [image] });
    expect(textarea.value).toBe('');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(0);
    expect(session.pendingSteeringMessages).toEqual(['turn left']);
  });

  it('keeps image-only steering disabled', async () => {
    setupSession(true);
    const image = 'data:image/png;base64,AAA';
    const send = vi.spyOn(connection, 'send');
    const textarea = await submit('', [image]);
    const button = document.querySelector<HTMLButtonElement>('button[title="Steer"]')!;
    expect(button.disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(1);
  });

  it('restores staged images when a steer is rejected', async () => {
    setupSession(true);
    const image = 'data:image/png;base64,AAA';
    respond(undefined, false);
    const textarea = await submit('turn left', [image]);
    expect(textarea.value).toBe('turn left');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(1);
  });

  it('restores staged images when steer dispatch loses the connection', async () => {
    setupSession(true);
    const image = 'data:image/png;base64,AAA';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(connection, 'send').mockRejectedValue(new Error('offline'));
    const textarea = await submit('turn left', [image]);
    expect(textarea.value).toBe('turn left');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(1);
  });

  it('keeps staged images when a streaming slash command is handled', async () => {
    setupSession(true);
    const image = 'data:image/png;base64,AAA';
    const sent = respond(undefined);
    const textarea = await submit('/tree', [image]);
    expect(sent[0]).toMatchObject({ type: 'prompt', sessionId: 's1', message: '/tree' });
    expect(sent[0]).not.toHaveProperty('images');
    expect(textarea.value).toBe('');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(1);
  });

  it('restores slash text without duplicating retained images after failure', async () => {
    setupSession(true);
    const image = 'data:image/png;base64,AAA';
    respond(undefined, false);
    const textarea = await submit('/tree', [image]);
    expect(textarea.value).toBe('/tree');
    expect(document.querySelectorAll('img[alt="Staged"]')).toHaveLength(1);
  });
});
