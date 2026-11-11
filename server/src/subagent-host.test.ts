import { describe, expect, it, vi } from 'vitest';
import type { BorrowedAgentSession, SubagentLease, SubagentProvider, SubagentSnapshot } from '@pimote/sdk/subagents';
import { createSubagentHost } from './subagent-host.js';
import type { SessionSurface } from './session-surface.js';

const path = ['worker', 'scout'] as const;
const nativeSession = {} as BorrowedAgentSession;

function makeLease(): SubagentLease {
  return {
    path,
    session: nativeSession,
    release: vi.fn(async () => undefined),
  };
}

function makeProvider(lease = makeLease()): SubagentProvider {
  const snapshot: SubagentSnapshot = {
    nodes: [],
    cursor: { epoch: 'epoch-1', sequence: 3 },
  };
  return {
    subscribe: vi.fn(() => () => undefined),
    snapshot: vi.fn(() => snapshot),
    replay: vi.fn(() => ({ kind: 'events', cursor: snapshot.cursor, events: [] })),
    acquire: vi.fn(async () => lease),
    teardown: vi.fn(async (requestedPath) => ({ path: requestedPath, removed: true })),
  };
}

function makeHost(provider: SubagentProvider) {
  return createSubagentHost({
    rootSessionId: 'root-session',
    provider,
    parentSurface: {} as SessionSurface,
    parentCursor: () => 41,
    emitParentEvent: vi.fn(),
  });
}

describe('SubagentHost', () => {
  it('subscribes to the provider before requesting the hierarchy snapshot', async () => {
    const calls: string[] = [];
    const provider = makeProvider();
    provider.subscribe = vi.fn(() => {
      calls.push('subscribe');
      return () => undefined;
    });
    provider.snapshot = vi.fn(() => {
      calls.push('snapshot');
      return { nodes: [], cursor: { epoch: 'epoch-1', sequence: 0 } };
    });

    const host = makeHost(provider);

    await expect(host.start()).resolves.toMatchObject({
      snapshot: expect.objectContaining({ cursor: { epoch: 'epoch-1', sequence: 0 } }),
    });
    expect(calls.indexOf('subscribe')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('snapshot')).toBeGreaterThan(calls.indexOf('subscribe'));
  });

  it('acquires one borrowed lease and creates a child surface for an opened path', async () => {
    const lease = makeLease();
    const provider = makeProvider(lease);
    const host = makeHost(provider);

    const attachment = await host.openView(path);

    expect(provider.acquire).toHaveBeenCalledWith(path);
    expect(attachment.path).toEqual(path);
    expect(attachment.attachmentGeneration).toEqual(expect.any(String));
    expect(attachment.snapshot).toEqual(expect.objectContaining({ cursor: expect.any(Number) }));
  });

  it('releases the connection lease when a child view closes', async () => {
    const lease = makeLease();
    const host = makeHost(makeProvider(lease));

    const attachment = await host.openView(path);
    await host.closeView(attachment);

    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('delegates teardown to the provider and returns the saved-session result', async () => {
    const provider = makeProvider();
    const host = makeHost(provider);

    await expect(host.teardown(path)).resolves.toMatchObject({ path, removed: true });
    expect(provider.teardown).toHaveBeenCalledWith(path);
  });

  it('keeps parent semantic cursors separate from child transcript cursors', async () => {
    const host = makeHost(makeProvider());

    const started = await host.start();
    const attachment = await host.openView(path);

    expect(started.parentCursor).toBe(41);
    expect(started.snapshot.cursor).toEqual(expect.objectContaining({ epoch: expect.any(String), sequence: expect.any(Number) }));
    expect(attachment.snapshot).toHaveProperty('cursor');
  });
});
