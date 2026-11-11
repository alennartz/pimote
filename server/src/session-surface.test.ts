import { describe, expect, it, vi } from 'vitest';
import type { BorrowedAgentSession } from '@pimote/sdk/subagents';
import { createSessionSurface } from './session-surface.js';

function makeNativeSession(order: string[] = []): BorrowedAgentSession {
  const session = {
    sessionId: 'child-session',
    sessionFile: undefined,
    subscribe: vi.fn(() => {
      order.push('subscribe');
      return () => undefined;
    }),
  } as unknown as BorrowedAgentSession;
  Object.defineProperty(session, 'messages', {
    get() {
      order.push('snapshot');
      return [];
    },
  });
  return session;
}

function makeSurface(session = makeNativeSession()) {
  return createSessionSurface({
    sessionId: 'child-session',
    session,
    kind: 'child',
    parentCursor: 17,
  });
}

describe('SessionSurface', () => {
  it('subscribes to the native session before returning a full child snapshot', async () => {
    const order: string[] = [];
    const surface = makeSurface(makeNativeSession(order));

    await expect(surface.initialize()).resolves.toMatchObject({
      cursor: expect.any(Number),
      state: expect.objectContaining({ sessionId: 'child-session' }),
      messages: expect.any(Array),
    });
    expect(order.indexOf('subscribe')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('snapshot')).toBeGreaterThan(order.indexOf('subscribe'));
  });

  it('keeps view replay cursors independent from the parent cursor', () => {
    const surface = makeSurface();

    const replay = surface.replay(0);

    expect(replay).toMatchObject({ kind: 'events', cursor: expect.any(Number) });
  });

  it('attaches an observer with its own cursor and an explicit release operation', async () => {
    const surface = makeSurface();

    const attachment = await surface.attachObserver('connection-1', 4);

    expect(attachment.observerId).toBe('connection-1');
    expect(attachment.cursor).toBeGreaterThanOrEqual(4);
    expect(attachment.release).toEqual(expect.any(Function));
  });

  it('dispatches identity-preserving child commands and reports prompt outcomes', async () => {
    const surface = makeSurface();

    await expect(
      surface.dispatch({
        type: 'prompt',
        id: 'client-message-1',
        message: 'Inspect the callback ownership.',
        clientMessageId: 'client-message-1',
      }),
    ).resolves.toMatchObject({ outcome: 'started' });
  });

  it('keeps state, transcript, completion, and tree reads on the surface boundary', async () => {
    const surface = makeSurface();

    await expect(surface.getState()).resolves.toMatchObject({ sessionId: 'child-session' });
    await expect(surface.getMessages()).resolves.toEqual(expect.any(Array));
    await expect(surface.getCommands()).resolves.toEqual(expect.any(Array));
    await expect(surface.completeArgs('review', '')).resolves.toEqual(expect.any(Array));
    await expect(surface.completeFileRefs('@src/')).resolves.toEqual(expect.any(Array));
    await expect(surface.getMeta()).resolves.toMatchObject({ lifetimeCostUsd: expect.any(Number) });
  });
});
