import { describe, expect, it } from 'vitest';
import { createSubagentPresentationProvider, type BorrowedAgentSession, type SubagentPresentationProvider, type SubagentProviderEvent } from './index.js';

const manifest = Object.freeze({
  hiddenToolNames: Object.freeze(['subagent', 'send', 'respond']),
  hiddenCustomTypes: Object.freeze(['subagents']),
});

function provider(): SubagentPresentationProvider {
  return createSubagentPresentationProvider({ manifest });
}

function childSession(): BorrowedAgentSession {
  return {
    sessionId: 'child-session',
    sessionFile: '/sessions/child.jsonl',
    messages: [],
    state: { streamingMessage: undefined, pendingToolCalls: new Set(), errorMessage: undefined },
  } as unknown as BorrowedAgentSession;
}

describe('subagent presentation provider', () => {
  it('exposes one immutable suppression manifest with active operation state', () => {
    const snapshot = provider().snapshot();

    expect(snapshot.manifest).toEqual(manifest);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
    expect(snapshot.activeOperations).toEqual(expect.any(Array));
    expect(snapshot.cursor).toEqual({ epoch: expect.any(String), sequence: expect.any(Number) });
  });

  it('keeps final hydration events in the same ordered feed as topology events', async () => {
    const current = provider();
    await current.rehydrate({ session: childSession(), path: ['worker'] });

    const replay = current.replay();
    expect(replay.kind).toBe('events');
    if (replay.kind !== 'events') return;
    expect(replay.events.map((event) => event.cursor.sequence)).toEqual([...replay.events].map((event) => event.cursor.sequence).sort((left, right) => left - right));
    expect(replay.events.some((event) => event.type === 'subagent_snapshot_event')).toBe(true);
  });

  it('replays a snapshot when a provider epoch or retained history cannot satisfy a cursor', () => {
    const replay = provider().replay({ epoch: 'old-epoch', sequence: 12 });

    expect(replay).toEqual({ kind: 'snapshot_required', reason: expect.any(String) });
  });

  it('rehydrates persisted native entries idempotently and publishes complete final payloads', async () => {
    const current = provider();
    await current.rehydrate({ session: childSession(), path: ['worker'] });
    await current.rehydrate({ session: childSession(), path: ['worker'] });

    const replay = current.replay();
    expect(replay.kind).toBe('events');
    if (replay.kind !== 'events') return;

    const finalEvents = replay.events.filter((event) => event.type === 'subagent_snapshot_event');
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toMatchObject({
      target: { operationId: expect.any(String) },
      data: { operation: expect.any(String) },
    });
    expect(finalEvents[0]).not.toHaveProperty('correlationId');
  });

  it('retains complete teardown result data instead of an untyped lifecycle extension', () => {
    provider();
    const teardown: SubagentProviderEvent = {
      type: 'subagent_snapshot_event',
      eventId: 'teardown-1',
      cursor: { epoch: 'epoch-1', sequence: 1 },
      target: { operationId: 'teardown-1', kind: 'teardown', path: ['worker'] },
      state: 'complete',
      data: {
        operation: 'teardown',
        result: {
          status: 'removed',
          affectedAgents: [
            {
              path: ['worker'],
              sessionId: 'worker-session',
              incarnation: 'worker-incarnation',
              state: 'idle',
              usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, turns: 1 },
              output: 'done',
            },
          ],
        },
      },
    };

    expect(teardown.data).toMatchObject({
      operation: 'teardown',
      result: {
        affectedAgents: [expect.objectContaining({ path: ['worker'], sessionId: 'worker-session', usage: expect.any(Object) })],
      },
    });
  });
});
