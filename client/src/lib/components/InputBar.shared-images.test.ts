// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteResponse } from '@pimote/shared';
import InputBar from './InputBar.svelte';
import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { pushSharedImages, sharedImagesRequest } from '$lib/stores/input-bar.svelte.js';

const mounted: ReturnType<typeof mount>[] = [];

function setupSession(sessionId = 's1') {
  sessionRegistry.addSession(sessionId, `/workspace/${sessionId}`, sessionId);
  sessionRegistry.switchTo(sessionId);
  connection.ready = true;
  return sessionRegistry.sessions[sessionId]!;
}

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InputBar, { target }));
  return target;
}

async function settle() {
  for (let i = 0; i < 3; i++) await tick();
}

function stagedImages(target: HTMLElement) {
  return target.querySelectorAll('img[alt="Staged"]');
}

async function remount() {
  const target = render();
  await settle();
  return target;
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
  sharedImagesRequest.images = [];
  sharedImagesRequest.seq = 0;
});

describe('InputBar Web Share images', () => {
  it('keeps images pending without a session or with a pending session, then transfers them to a real session', async () => {
    pushSharedImages(['data:image/png;base64,before-mount']);
    const target = render();
    await settle();

    expect(stagedImages(target)).toHaveLength(0);
    expect(sharedImagesRequest.images).toEqual(['data:image/png;base64,before-mount']);

    sessionRegistry.addSession('pending-1', '/workspace/new', 'new');
    sessionRegistry.switchTo('pending-1');
    await settle();

    expect(stagedImages(target)).toHaveLength(0);
    expect(sharedImagesRequest.images).toEqual(['data:image/png;base64,before-mount']);

    sessionRegistry.replaceSession('pending-1', 's1', '/workspace/s1', 's1');
    await settle();

    expect(stagedImages(target)).toHaveLength(1);
    expect(sharedImagesRequest.images).toEqual([]);
  });

  it('appends a new share once without replaying an earlier consumed share', async () => {
    setupSession();
    const target = render();
    await settle();

    pushSharedImages(['data:image/png;base64,first-share']);
    await settle();
    pushSharedImages(['data:image/png;base64,second-share']);
    await settle();

    expect([...target.querySelectorAll<HTMLImageElement>('img[alt="Staged"]')].map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,first-share',
      'data:image/png;base64,second-share',
    ]);
    expect(sharedImagesRequest.images).toEqual([]);
  });

  it('does not replay consumed images after send and remount', async () => {
    setupSession();
    const target = render();
    await settle();
    pushSharedImages(['data:image/png;base64,after-send']);
    await settle();

    const textarea = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    textarea.value = 'send this';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'r', success: true, data: { outcome: 'started' } } as PimoteResponse);
    target.querySelector<HTMLButtonElement>('button[title="Send"]')!.click();
    await settle();

    expect(stagedImages(target)).toHaveLength(0);
    expect(sharedImagesRequest.images).toEqual([]);

    await unmount(mounted.pop()!);
    const remounted = await remount();
    expect(stagedImages(remounted)).toHaveLength(0);
  });

  it('does not replay consumed images after removal and remount', async () => {
    setupSession();
    const target = render();
    await settle();
    pushSharedImages(['data:image/png;base64,after-removal']);
    await settle();

    target.querySelector<HTMLButtonElement>('button[title="Remove image"]')!.click();
    await tick();
    expect(stagedImages(target)).toHaveLength(0);
    expect(sharedImagesRequest.images).toEqual([]);

    await unmount(mounted.pop()!);
    const remounted = await remount();
    expect(stagedImages(remounted)).toHaveLength(0);
  });

  it('does not replay consumed images after switching sessions or remounting the session view', async () => {
    setupSession('s1');
    sessionRegistry.addSession('s2', '/workspace/s2', 's2');
    const target = render();
    await settle();
    pushSharedImages(['data:image/png;base64,session-switch']);
    await settle();
    expect(stagedImages(target)).toHaveLength(1);

    sessionRegistry.switchTo('s2');
    await settle();
    expect(stagedImages(target)).toHaveLength(0);
    sessionRegistry.switchTo('s1');
    await settle();
    expect(stagedImages(target)).toHaveLength(0);

    await unmount(mounted.pop()!);
    const remounted = await remount();
    expect(stagedImages(remounted)).toHaveLength(0);
  });

  it('does not replay consumed images after a calling-mode remount', async () => {
    setupSession();
    pushSharedImages(['data:image/png;base64,calling-remount']);
    const first = render();
    await settle();
    expect(stagedImages(first)).toHaveLength(1);

    // CallingMode replaces InputBar in the session route. Returning to the
    // session mounts a fresh composer, which must not replay the payload.
    await unmount(mounted.pop()!);
    const remounted = await remount();
    expect(stagedImages(remounted)).toHaveLength(0);
    expect(sharedImagesRequest.images).toEqual([]);
  });
});
