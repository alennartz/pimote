import { describe, expect, it } from 'vitest';
import type {
  AgentPath,
  BorrowedAgentSession,
  SubagentCapabilities,
  SubagentEvent,
  SubagentLease,
  SubagentLeaseEvent,
  SubagentNodeSnapshot,
  SubagentProvider,
  SubagentProviderEvent,
  SubagentStopRequest,
} from '@pimote/sdk/subagents';
import type { PimoteSessionEvent, SessionState } from '../../shared/dist/index.js';
import { createSubagentHost, type SubagentViewChange } from './subagent-host.js';
import type { SessionSurface, SessionSurfaceOptions } from './session-surface.js';

const worker = ['worker'] as const;
const scout = ['worker', 'scout'] as const;
const reviewer = ['worker', 'reviewer'] as const;
const other = ['other'] as const;
const key = (path: AgentPath) => JSON.stringify(path);

function session(id: string): BorrowedAgentSession {
  return {
    sessionId: id,
    state: {
      streamingMessage: undefined,
      pendingToolCalls: new Set<string>(),
      errorMessage: undefined,
    },
  } as unknown as BorrowedAgentSession;
}

function node(path: AgentPath, sessionId: string, state: SubagentNodeSnapshot['state'] = 'idle'): SubagentNodeSnapshot {
  return {
    path,
    incarnation: `${sessionId}-incarnation`,
    sessionId,
    task: `Task for ${path.join('/')}`,
    state,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    channels: ['parent'],
    waitingFor: [],
    hasSubgroup: path.length === 1,
  };
}

function state(id: string): SessionState {
  return {
    sessionId: id,
    sessionFile: undefined,
    model: null,
    thinkingLevel: 'off',
    availableThinkingLevels: [],
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    messageCount: 0,
  };
}

function semanticEvent(sequence: number): SubagentEvent {
  return {
    eventId: `event-${sequence}`,
    cursor: { epoch: 'epoch-1', sequence },
    path: scout,
    kind: 'node_updated',
    relatedPiEvents: [],
    data: node(scout, 'scout-1', 'waiting'),
  };
}

function fixture(retainedEvents: readonly SubagentEvent[] = []) {
  const providerCursor = { epoch: 'epoch-1', sequence: retainedEvents.at(-1)?.cursor.sequence ?? 0 };
  const sessions = new Map<string, BorrowedAgentSession>([
    [key(worker), session('worker-1')],
    [key(scout), session('scout-1')],
    [key(reviewer), session('reviewer-1')],
    [key(other), session('other-1')],
  ]);
  const leases = new Set<{
    path: AgentPath;
    current: BorrowedAgentSession;
    capabilities: SubagentCapabilities;
    notify: (event: SubagentLeaseEvent) => void;
  }>();
  const listeners = new Set<(event: SubagentProviderEvent) => void>();
  type ViewNotification = { clientId: string; change: SubagentViewChange; path: readonly string[]; incarnation: string; viewCursor: number };
  const viewChanges: ViewNotification[] = [];
  const waiters = new Set<(notification: ViewNotification) => void>();
  const parentEvents: SubagentEvent[] = [];
  const stopRequests: SubagentStopRequest[] = [];
  const projected = new Map<string, SubagentProviderEvent[]>();
  const accept = (id: string, event: SubagentProviderEvent) => projected.set(id, [...(projected.get(id) ?? []), event]);
  const surfaces = new Map<string, { emit: (event: PimoteSessionEvent) => void }>();
  const pending: {
    idleAnswer: string;
    delivered: string[];
    snapshotEvent: SubagentEvent | undefined;
    parentCursor: number;
    acquireCalls: number;
    blockAcquire: boolean;
    releaseAcquire?: () => void;
  } = {
    idleAnswer: 'latest answer',
    delivered: [] as string[],
    snapshotEvent: undefined as SubagentEvent | undefined,
    parentCursor: 41,
    acquireCalls: 0,
    blockAcquire: false,
  };
  const publish = (event: SubagentProviderEvent) => {
    for (const listener of listeners) listener(event);
  };

  const provider: SubagentProvider = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      if (pending.snapshotEvent) publish(pending.snapshotEvent);
      const nodes = [...sessions.entries()].map(([storedPath, current]) => node(JSON.parse(storedPath) as AgentPath, current.sessionId));
      return { nodes, cursor: providerCursor };
    },
    replay: (after) => ({
      kind: 'events',
      cursor: providerCursor,
      events: retainedEvents.filter((event) => after === undefined || event.cursor.sequence > after.sequence),
    }),
    async acquire(path) {
      pending.acquireCalls++;
      if (pending.blockAcquire) await new Promise<void>((resolve) => (pending.releaseAcquire = resolve));
      const current = sessions.get(key(path));
      if (!current) throw new Error('unavailable');
      const subscriptions = new Set<(event: SubagentLeaseEvent) => void>();
      const capabilities: SubagentCapabilities = {
        operations: [
          'prompt',
          'steer',
          'follow_up',
          'stop',
          'bash',
          'abort_bash',
          'set_model',
          'cycle_model',
          'set_thinking_level',
          'cycle_thinking_level',
          'set_auto_compaction',
          'compact',
          'tree',
          'completion',
          'state',
          'meta',
        ],
        renderer: { visible: true },
        resolveModel: async () => undefined,
        getSettings: () => ({ availableThinkingLevels: [], autoCompactionEnabled: true }),
        nativeBash: { admitted: true, execute: async () => undefined, abort: async () => undefined },
        executeBash: async () => undefined,
        getCommands: async () => [],
        completeArgs: async () => [],
        completeFileRefs: async () => [],
      };
      const record = {
        path,
        current,
        capabilities,
        notify: (event: SubagentLeaseEvent) => {
          for (const listener of subscriptions) listener(event);
        },
      };
      leases.add(record);
      return {
        path,
        capabilities: record.capabilities,
        get session() {
          if (!leases.has(record)) throw new Error('closed');
          return record.current;
        },
        subscribe(listener: (event: SubagentLeaseEvent) => void) {
          subscriptions.add(listener);
          return () => {
            subscriptions.delete(listener);
          };
        },
        async release() {
          if (!leases.delete(record)) return;
          // The provider delivers the held idle answer when the last view of
          // the child detaches.
          if (key(path) === key(scout) && ![...leases].some((lease) => key(lease.path) === key(scout))) {
            pending.delivered.push(pending.idleAnswer);
          }
        },
      } as SubagentLease;
    },
    async teardown(path, _incarnation) {
      const previous = sessions.get(key(path));
      for (const [stored] of sessions) {
        const parts = JSON.parse(stored) as string[];
        if (path.every((part, index) => parts[index] === part)) sessions.delete(stored);
      }
      for (const lease of leases) {
        if (path.every((part, index) => lease.path[index] === part)) {
          leases.delete(lease);
          lease.notify({ kind: 'closed', reason: 'removed' });
        }
      }
      return {
        path,
        removed: true,
        sessionId: previous?.sessionId ?? 'scout-1',
        incarnation: `${previous?.sessionId ?? 'scout-1'}-incarnation`,
        reason: 'removed',
      };
    },
    async stop(request) {
      const current = sessions.get(key(request.path));
      if (!current || current.sessionId !== request.expectedSessionId) throw new Error('stale child');
      stopRequests.push({ ...request, path: [...request.path] });
    },
    async resurrect(request) {
      const path = [...request.parentPath, request.localId];
      const sessionId = `resurrected-${request.sessionId}`;
      sessions.set(key(path), session(sessionId));
      return { path, sessionId, incarnation: `${sessionId}-incarnation`, node: node(path, sessionId) };
    },
  };

  /** Child surface double with the real cursor rules: a base above zero and a
   *  replay floor that turns an old cursor into a snapshot. */
  function makeSurface(options: SessionSurfaceOptions): SessionSurface {
    const observers = new Map<string, (event: PimoteSessionEvent) => void>();
    const events: PimoteSessionEvent[] = [];
    const base = options.baseCursor ?? 0;
    const id = options.session.sessionId;
    const stop = (options as SessionSurfaceOptions & { stop?: (...args: readonly unknown[]) => Promise<void> | void }).stop;
    const cursor = () => base + events.length;
    const snapshot = () => ({ cursor: cursor(), state: state(id), messages: [] });
    surfaces.set(id, {
      emit: (event) => {
        events.push(event);
        for (const observer of observers.values()) observer(event);
      },
    });
    return {
      sessionId: id,
      kind: 'child',
      get currentCursor() {
        return cursor();
      },
      acceptProviderEvent: (event) => {
        accept(id, event);
      },
      initialize: async () => snapshot(),
      refreshSnapshot: () => snapshot(),
      subscribe: (listener) => {
        observers.set(`anonymous-${observers.size}`, listener);
        return () => {
          for (const [observerId, candidate] of observers) if (candidate === listener) observers.delete(observerId);
        };
      },
      close: () => {
        observers.clear();
      },
      attachObserver: async (observerId, after) => {
        observers.set(observerId, () => undefined);
        const replayable = after !== undefined && after >= base && after <= cursor();
        const replayed = replayable ? events.slice(after - base) : undefined;
        return {
          observerId,
          cursor: cursor(),
          ...(replayed ? { events: replayed } : { snapshot: snapshot() }),
          release: () => {
            observers.delete(observerId);
          },
        };
      },
      replay: (after = base) =>
        after < base || after > cursor() ? { kind: 'snapshot_required', reason: 'history_unavailable' } : { kind: 'events', cursor: cursor(), events: events.slice(after - base) },
      dispatch: async (command) => {
        if (command.type === 'abort') await stop?.(command);
        return `${id}:${command.type}`;
      },
      getState: async () => state(id),
      getMeta: async () => ({ gitBranch: null, contextUsage: null, lifetimeCostUsd: 0 }),
      getMessages: async () => [],
      getCommands: async () => [],
      completeArgs: async () => [],
      completeFileRefs: async () => [],
    };
  }

  const host = createSubagentHost({
    rootSessionId: 'root-session',
    provider,
    parentSurface: {
      acceptProviderEvent: (event: SubagentProviderEvent) => {
        accept('root-session', event);
      },
    } as SessionSurface,
    parentCursor: () => pending.parentCursor,
    emitParentEvent: (event) => {
      parentEvents.push(event);
      pending.parentCursor++;
    },
    emitViewChange: (clientId, change, path, incarnation, viewCursor) => {
      const notification = { clientId, change, path, incarnation, viewCursor };
      viewChanges.push(notification);
      for (const waiter of waiters) waiter(notification);
    },
    childCapabilities: () => ({
      resolveModel: async () => undefined,
      getSettings: () => ({ availableThinkingLevels: [], autoCompactionEnabled: true }),
      getCommands: async () => [],
      completeArgs: async () => [],
      completeFileRefs: async () => [],
      executeBash: async () => undefined,
      getGitBranch: () => null,
    }),
    createChildSurface: makeSurface,
  });

  return {
    host,
    pending,
    parentEvents,
    projected,
    stopRequests,
    viewChanges,
    surfaces,
    publish,
    nextViewChange(predicate: (notification: ViewNotification) => boolean): Promise<ViewNotification> {
      return new Promise((resolve) => {
        const waiter = (notification: ViewNotification) => {
          if (!predicate(notification)) return;
          waiters.delete(waiter);
          resolve(notification);
        };
        waiters.add(waiter);
      });
    },
    active: (path: AgentPath) => [...leases].filter((lease) => key(lease.path) === key(path)).length,
    replace(path: AgentPath, id: string) {
      const replacement = session(id);
      sessions.set(key(path), replacement);
      for (const lease of leases)
        if (key(lease.path) === key(path)) {
          lease.current = replacement;
          lease.capabilities = {
            ...lease.capabilities,
            renderer: { visible: true },
          };
          lease.notify({ kind: 'rebound', session: replacement, capabilities: lease.capabilities });
        }
    },
    unavailable(path: AgentPath) {
      sessions.delete(key(path));
      for (const lease of leases)
        if (key(lease.path) === key(path)) {
          leases.delete(lease);
          lease.notify({ kind: 'closed', reason: 'unavailable' });
        }
    },
    restore(path: AgentPath, id: string) {
      sessions.set(key(path), session(id));
    },
  };
}

describe('SubagentHost', () => {
  it('drops legacy lifecycle facts instead of projecting them as topology', async () => {
    const legacy = {
      eventId: 'legacy-completion',
      cursor: { epoch: 'epoch-1', sequence: 1 },
      path: scout,
      kind: 'completion',
      relatedPiEvents: [],
      data: { status: 'idle' },
    } as unknown as SubagentProviderEvent;
    const f = fixture([legacy as unknown as SubagentEvent]);
    await f.host.start();
    expect(f.parentEvents).toEqual([]);
  });

  it('routes presentation operations only to their root or child session surface', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    const base = {
      type: 'subagent_start',
      cursor: { epoch: 'epoch-1', sequence: 1 },
      data: { operation: 'send', parameters: { to: ['worker'], message: 'hello' }, result: { response: '', phase: 'sending' } },
    } as const;
    const root: SubagentProviderEvent = {
      ...base,
      eventId: 'root-operation',
      target: { operationId: 'root-call', kind: 'send', path: [], placement: { toolCallId: 'root-call', contentIndex: 0 } },
    };
    const child: SubagentProviderEvent = {
      ...base,
      eventId: 'child-operation',
      cursor: { epoch: 'epoch-1', sequence: 2 },
      target: { operationId: 'child-call', kind: 'send', path: scout, placement: { toolCallId: 'child-call', contentIndex: 0 } },
    };
    f.publish(root);
    f.publish(child);
    expect(f.projected.get('root-session')).toEqual([root]);
    expect(f.projected.get('scout-1')).toEqual([child]);
  });

  it('does not lose provider events emitted at the snapshot boundary or afterwards', async () => {
    const f = fixture();
    f.pending.snapshotEvent = semanticEvent(1);
    const started = await f.host.start();
    f.publish(semanticEvent(2));

    expect(started.snapshot.cursor).toEqual({ epoch: 'epoch-1', sequence: 0 });
    expect(f.parentEvents.map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
  });

  it('shares one surface and one lease across clients and holds the answer until the last detaches', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('client-1', scout);
    const second = await f.host.openView('client-2', scout);
    expect(f.active(scout)).toBe(1);
    expect(first.incarnation).toBe(second.incarnation);
    expect(f.pending.acquireCalls).toBe(1);

    await f.host.closeView('client-1', scout);
    expect(f.active(scout)).toBe(1);
    expect(f.pending.delivered).toEqual([]);

    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const delivered = f.nextViewChange(({ clientId, change }) => clientId === 'client-2' && change.type === 'event');
    f.surfaces.get('scout-1')!.emit(event);
    await delivered;
    expect(f.viewChanges.filter(({ clientId }) => clientId === 'client-1').some(({ change }) => change.type === 'event')).toBe(false);

    await f.host.closeView('client-2', scout);
    expect(f.active(scout)).toBe(0);
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('replays a delta to the attaching client only and reports the mode', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('client-1', scout);
    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    f.surfaces.get('scout-1')!.emit(event);

    const second = await f.host.openView('client-2', scout, first.viewCursor);
    expect(second.mode).toBe('events');
    expect(f.viewChanges.filter(({ clientId }) => clientId === 'client-2').map(({ change }) => change)).toEqual([{ type: 'event', event }]);
    expect(f.viewChanges.filter(({ clientId }) => clientId === 'client-1').some(({ change }) => change.type === 'event' && change.event === event)).toBe(true);
  });

  it('answers with a snapshot when history cannot reach the supplied cursor', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('client-1', scout);
    expect(first.mode).toBe('snapshot');
    await f.host.closeView('client-1', scout);
    // The dropped surface is gone, so its cursor cannot be replayed from.
    const reopened = await f.host.openView('client-1', scout, first.viewCursor);
    expect(reopened.mode).toBe('snapshot');
    expect(f.viewChanges.filter(({ clientId, change }) => clientId === 'client-1' && change.type === 'snapshot')).toHaveLength(2);
  });

  it('deduplicates concurrent opens for one path', async () => {
    const f = fixture();
    await f.host.start();
    f.pending.blockAcquire = true;
    const first = f.host.openView('client-1', scout);
    const second = f.host.openView('client-2', scout);
    await Promise.resolve();
    expect(f.pending.acquireCalls).toBe(1);
    f.pending.blockAcquire = false;
    f.pending.releaseAcquire?.();
    await Promise.all([first, second]);
    expect(f.active(scout)).toBe(1);
  });

  it('refreshes every observing client after shared tree navigation', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    await f.host.openView('client-2', scout);
    const firstRefresh = f.nextViewChange(({ clientId, change }) => clientId === 'client-1' && change.type === 'snapshot');
    const secondRefresh = f.nextViewChange(({ clientId, change }) => clientId === 'client-2' && change.type === 'snapshot');
    await f.host.dispatch('client-1', { path: scout }, { type: 'navigate_tree', targetId: 'entry-1' });
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      expect.objectContaining({ clientId: 'client-1', change: expect.objectContaining({ type: 'snapshot' }) }),
      expect.objectContaining({ clientId: 'client-2', change: expect.objectContaining({ type: 'snapshot' }) }),
    ]);
  });

  it('detaches one client without closing the view another client holds', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    await f.host.openView('client-2', scout);
    await f.host.openView('client-1', reviewer);

    await f.host.detachClient('client-1');

    expect(f.active(scout)).toBe(1);
    expect(f.active(reviewer)).toBe(0);
    expect(f.pending.delivered).toEqual([]);
    await expect(f.host.dispatch('client-1', { path: scout }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-2', { path: scout }, { type: 'get_state' })).resolves.toBe('scout-1:get_state');

    await f.host.detachClient('client-2');
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('reports an unavailable path instead of opening an empty view', async () => {
    const f = fixture();
    await f.host.start();
    f.unavailable(scout);
    await expect(f.host.openView('client-1', scout)).rejects.toThrow('unavailable');
    expect(f.active(scout)).toBe(0);
  });

  it('rebinds a live view to a replacement and sends a fresh snapshot', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('client-1', scout);
    const rebound = f.nextViewChange(({ clientId, change }) => clientId === 'client-1' && change.type === 'snapshot');
    f.replace(scout, 'scout-2');
    const refresh = await rebound;
    expect(refresh).toEqual(
      expect.objectContaining({
        clientId: 'client-1',
        change: expect.objectContaining({
          type: 'snapshot',
          snapshot: expect.objectContaining({ state: expect.objectContaining({ sessionId: 'scout-2' }) }),
        }),
      }),
    );
    // A rebuilt surface starts above the cursor of the surface it replaced, so
    // the next delta cannot skip the events the old surface already issued.
    expect(refresh.viewCursor).toBeGreaterThan(view.viewCursor);
    await expect(f.host.dispatch('client-1', { path: scout }, { type: 'get_state' })).resolves.toBe('scout-2:get_state');
    const oldEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const newEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-2', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event' && change.event.sessionId === 'scout-2');
    f.surfaces.get('scout-1')!.emit(oldEvent);
    f.surfaces.get('scout-2')!.emit(newEvent);
    await delivered;
    expect(f.viewChanges.some(({ change }) => change.type === 'event' && change.event === oldEvent)).toBe(false);
    expect(f.viewChanges).toContainEqual(expect.objectContaining({ clientId: 'client-1', change: { type: 'event', event: newEvent } }));
  });

  it('rejects commands from a client that does not observe the view and from a stale incarnation', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('client-1', scout);
    await expect(f.host.dispatch('client-2', { path: scout }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-1', { path: reviewer }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'stale' }, { type: 'get_state' })).rejects.toThrow('stale child incarnation');
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: view.incarnation }, { type: 'get_state' })).resolves.toBe('scout-1:get_state');
  });

  it('closes a view whose runtime disappears and notifies its observer', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    const closed = f.nextViewChange(({ clientId, change }) => clientId === 'client-1' && change.type === 'closed');
    f.unavailable(scout);
    expect(await closed).toEqual(expect.objectContaining({ clientId: 'client-1', change: { type: 'closed', reason: 'unavailable' } }));
    await expect(f.host.dispatch('client-1', { path: scout }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
  });

  it('stops a hierarchy node without requiring a view and guards its runtime identity', async () => {
    const f = fixture();
    await f.host.start();
    const request = { path: worker, incarnation: 'worker-1-incarnation', expectedSessionId: 'worker-1' };

    await f.host.stop(request);

    expect(f.stopRequests).toContainEqual(request);
    expect(f.active(worker)).toBe(0);
    await expect(f.host.stop({ ...request, expectedSessionId: 'replacement' })).rejects.toThrow('stale child runtime');
    expect(f.stopRequests).not.toContainEqual(expect.objectContaining({ expectedSessionId: 'replacement' }));
  });

  it('closes views in a torn-down subtree and leaves other views usable', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    await f.host.openView('client-2', reviewer);
    await f.host.openView('client-1', other);
    const firstClosed = f.nextViewChange(({ clientId, change }) => clientId === 'client-1' && change.type === 'closed');
    const secondClosed = f.nextViewChange(({ clientId, change }) => clientId === 'client-2' && change.type === 'closed');
    await expect(f.host.teardown(['worker'])).resolves.toMatchObject({ path: ['worker'], removed: true });
    expect(await Promise.all([firstClosed, secondClosed])).toEqual([
      expect.objectContaining({ clientId: 'client-1', change: { type: 'closed', reason: 'teardown' } }),
      expect.objectContaining({ clientId: 'client-2', change: { type: 'closed', reason: 'teardown' } }),
    ]);
    await expect(f.host.dispatch('client-1', { path: scout }, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('client-2', { path: reviewer }, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('client-1', { path: other }, { type: 'get_state' })).resolves.toBe('other-1:get_state');
  });

  it('routes child events on their view cursor without advancing the parent cursor', async () => {
    const f = fixture();
    const started = await f.host.start();
    const view = await f.host.openView('client-1', scout);
    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event');
    f.surfaces.get('scout-1')!.emit(event);
    await delivered;
    expect(f.viewChanges).toContainEqual(expect.objectContaining({ clientId: 'client-1', change: { type: 'event', event }, path: scout }));
    expect(started.parentCursor).toBe(41);
    expect(f.pending.parentCursor).toBe(41);
    f.publish(semanticEvent(1));
    expect(f.pending.parentCursor).toBe(42);
    expect(view.viewCursor).toBeTypeOf('number');
  });
});
