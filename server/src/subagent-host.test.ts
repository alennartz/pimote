import { describe, expect, it, vi } from 'vitest';
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
  type ViewNotification = { connectionId: string; change: SubagentViewChange };
  const viewChanges: ViewNotification[] = [];
  const waiters = new Set<(notification: ViewNotification) => void>();
  const parentEvents: SubagentEvent[] = [];
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
    },
    async resurrect(request) {
      const path = [...request.parentPath, request.localId];
      const sessionId = `resurrected-${request.sessionId}`;
      sessions.set(key(path), session(sessionId));
      return { path, sessionId, incarnation: `${sessionId}-incarnation`, node: node(path, sessionId) };
    },
  };

  function makeSurface(options: SessionSurfaceOptions): SessionSurface {
    const observers = new Set<(event: PimoteSessionEvent) => void>();
    const events: PimoteSessionEvent[] = [];
    const id = options.session.sessionId;
    const stop = (options as SessionSurfaceOptions & { stop?: (...args: readonly unknown[]) => Promise<void> | void }).stop;
    const snapshot = () => ({ cursor: events.length, state: state(id), messages: [] });
    surfaces.set(id, {
      emit: (event) => {
        events.push(event);
        for (const observer of observers) observer(event);
      },
    });
    return {
      sessionId: id,
      kind: 'child',
      get currentCursor() {
        return events.length;
      },
      acceptProviderEvent: (event) => {
        accept(id, event);
      },
      initialize: async () => snapshot(),
      refreshSnapshot: () => ({ ...snapshot(), cursor: events.length + 1 }),
      subscribe: (listener) => {
        observers.add(listener);
        return () => {
          observers.delete(listener);
        };
      },
      close: () => {
        observers.clear();
      },
      attachObserver: async (observerId, after) => ({
        observerId,
        cursor: events.length,
        ...(after === undefined ? { snapshot: snapshot() } : { events: events.slice(after) }),
        release() {},
      }),
      replay: (after = 0) => ({ kind: 'events', cursor: events.length, events: events.slice(after) }),
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
    emitViewChange: (connectionId, change) => {
      const notification = { connectionId, change };
      viewChanges.push(notification);
      for (const waiter of waiters) waiter(notification);
    },
    reconnectGraceMs: 1000,
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
    await f.host.openView('connection-1', scout);
    const base = {
      type: 'subagent_start',
      cursor: { epoch: 'epoch-1', sequence: 1 },
      data: { operation: 'send', to: ['worker'], request: 'hello', response: '', phase: 'sending' },
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

  it('keeps multiple paths per connection and holds the answer until the last viewer detaches', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('connection-1', scout);
    const secondPath = await f.host.openView('connection-1', reviewer);
    const secondViewer = await f.host.openView('connection-2', scout);
    expect(f.active(scout)).toBe(2);
    expect(f.active(reviewer)).toBe(1);

    await f.host.closeView('connection-1', first);
    expect(f.active(scout)).toBe(1);
    expect(f.pending.delivered).toEqual([]);
    await expect(f.host.dispatch('connection-1', secondPath, { type: 'get_state' })).resolves.toBe('reviewer-1:get_state');
    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const delivered = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-2' && change.type === 'event');
    f.surfaces.get('scout-1')!.emit(event);
    await delivered;
    expect(f.viewChanges).not.toContainEqual({
      connectionId: 'connection-1',
      change: {
        type: 'event',
        path: scout,
        attachmentGeneration: first.attachmentGeneration,
        event,
      },
    });
    expect(f.viewChanges).toContainEqual({
      connectionId: 'connection-2',
      change: {
        type: 'event',
        path: scout,
        attachmentGeneration: secondViewer.attachmentGeneration,
        event,
      },
    });

    await f.host.closeView('connection-2', secondViewer);
    expect(f.active(scout)).toBe(0);
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('deduplicates concurrent opens for one connection and path', async () => {
    const f = fixture();
    await f.host.start();
    f.pending.blockAcquire = true;
    const first = f.host.openView('connection-1', scout);
    const second = f.host.openView('connection-1', scout);
    await Promise.resolve();
    expect(f.pending.acquireCalls).toBe(1);
    f.pending.blockAcquire = false;
    f.pending.releaseAcquire?.();
    const [one, two] = await Promise.all([first, second]);
    expect(one.attachmentGeneration).toBe(two.attachmentGeneration);
    expect(f.active(scout)).toBe(1);
  });

  it('refreshes every live attachment after shared tree navigation', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('connection-1', scout);
    const second = await f.host.openView('connection-2', scout);
    const firstRefresh = f.nextViewChange(
      ({ connectionId, change }) => connectionId === 'connection-1' && change.type === 'snapshot' && change.snapshot.cursor > first.snapshot.cursor,
    );
    const secondRefresh = f.nextViewChange(
      ({ connectionId, change }) => connectionId === 'connection-2' && change.type === 'snapshot' && change.snapshot.cursor > second.snapshot.cursor,
    );
    await f.host.dispatch('connection-1', first, { type: 'navigate_tree', targetId: 'entry-1' });
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: 'connection-1', change: expect.objectContaining({ type: 'snapshot' }) }),
        expect.objectContaining({ connectionId: 'connection-2', change: expect.objectContaining({ type: 'snapshot' }) }),
      ]),
    );
  });

  it('releases a lease that finishes after the connection token is invalidated', async () => {
    const f = fixture();
    await f.host.start();
    f.pending.blockAcquire = true;
    const opening = f.host.openView('connection-1', scout);
    await Promise.resolve();
    const token = f.host.connectionToken?.('connection-1');
    expect(token).toBeTypeOf('number');
    f.host.disconnect('connection-1', token);
    f.pending.blockAcquire = false;
    f.pending.releaseAcquire?.();
    await expect(opening).rejects.toThrow('stale connection token');
    expect(f.active(scout)).toBe(0);
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('retains all connection attachments during reconnect grace and releases them after expiry', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.host.start();
      const first = await f.host.openView('connection-1', scout);
      await f.host.openView('connection-1', reviewer);
      f.host.disconnect('connection-1');
      await vi.advanceTimersByTimeAsync(999);
      expect(f.active(scout)).toBe(1);
      expect(f.pending.delivered).toEqual([]);
      const reattached = await f.host.reconnect('connection-1');
      expect(reattached.map((view) => view.path)).toEqual(expect.arrayContaining([scout, reviewer]));
      await vi.advanceTimersByTimeAsync(1000);
      await expect(f.host.dispatch('connection-1', first, { type: 'get_state' })).resolves.toBe('scout-1:get_state');

      f.host.disconnect('connection-1');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.active(scout)).toBe(0);
      expect(f.active(reviewer)).toBe(0);
      expect(f.pending.delivered).toEqual(['latest answer']);
      expect(await f.host.reconnect('connection-1')).toEqual([]);
      await expect(f.host.dispatch('connection-1', first, { type: 'get_state' })).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resyncs a child transcript after tree navigation', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('connection-1', scout);
    const refreshed = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-1' && change.type === 'snapshot');
    await f.host.dispatch('connection-1', view, { type: 'navigate_tree', targetId: 'entry-1' });
    expect(await refreshed).toEqual(
      expect.objectContaining({
        connectionId: 'connection-1',
        change: expect.objectContaining({
          type: 'snapshot',
          path: scout,
          attachmentGeneration: view.attachmentGeneration,
          snapshot: expect.objectContaining({ cursor: 1 }),
        }),
      }),
    );
  });

  it('rejects stale connection tokens after a reconnect', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('connection-1', scout);
    const firstToken = f.host.connectionToken?.('connection-1');
    expect(firstToken).toBeTypeOf('number');
    f.host.disconnect('connection-1', firstToken);
    await expect(f.host.reconnect('connection-1', firstToken)).rejects.toThrow('stale connection token');
    const reconnectToken = f.host.connectionToken?.('connection-1');
    expect(reconnectToken).not.toBe(firstToken);
    await f.host.reconnect('connection-1', reconnectToken);
    await expect(f.host.dispatch('connection-1', view, { type: 'get_state' }, firstToken)).rejects.toThrow('stale connection token');
  });

  it('rebinds a live view to a replacement and sends a fresh snapshot', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('connection-1', scout);
    const rebound = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-1' && change.type === 'snapshot');
    f.replace(scout, 'scout-2');
    expect(await rebound).toEqual({
      connectionId: 'connection-1',
      change: expect.objectContaining({
        type: 'snapshot',
        path: scout,
        attachmentGeneration: view.attachmentGeneration,
        snapshot: expect.objectContaining({ state: expect.objectContaining({ sessionId: 'scout-2' }) }),
      }),
    });
    await expect(f.host.dispatch('connection-1', view, { type: 'get_state' })).resolves.toBe('scout-2:get_state');
    const oldEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const newEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-2', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event' && change.event.sessionId === 'scout-2');
    f.surfaces.get('scout-1')!.emit(oldEvent);
    f.surfaces.get('scout-2')!.emit(newEvent);
    await delivered;
    expect(f.viewChanges).not.toContainEqual(expect.objectContaining({ change: expect.objectContaining({ type: 'event', event: oldEvent }) }));
    expect(f.viewChanges).toContainEqual({
      connectionId: 'connection-1',
      change: {
        type: 'event',
        path: scout,
        attachmentGeneration: view.attachmentGeneration,
        event: newEvent,
      },
    });
  });

  it('rejects foreign, wrong-path, and stale generations even when a path is reused', async () => {
    const f = fixture();
    await f.host.start();
    const old = await f.host.openView('connection-1', scout);
    await expect(f.host.dispatch('connection-2', old, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('connection-1', { ...old, path: reviewer }, { type: 'get_state' })).rejects.toThrow();
    await f.host.closeView('connection-2', old).catch(() => undefined);
    await expect(f.host.dispatch('connection-1', old, { type: 'get_state' })).resolves.toBe('scout-1:get_state');
    const closed = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-1' && change.type === 'closed');
    f.unavailable(scout);
    expect(await closed).toEqual({
      connectionId: 'connection-1',
      change: {
        type: 'closed',
        path: scout,
        attachmentGeneration: old.attachmentGeneration,
        reason: 'unavailable',
      },
    });
    f.restore(scout, 'scout-3');
    const fresh = await f.host.openView('connection-1', scout);
    expect(fresh.attachmentGeneration).not.toBe(old.attachmentGeneration);
    await expect(f.host.dispatch('connection-1', old, { type: 'get_state' })).rejects.toThrow();
    await f.host.closeView('connection-1', old).catch(() => undefined);
    await expect(f.host.dispatch('connection-1', fresh, { type: 'get_state' })).resolves.toBe('scout-3:get_state');
  });

  it('closes views in a torn-down subtree and leaves other views usable', async () => {
    const f = fixture();
    await f.host.start();
    const one = await f.host.openView('connection-1', scout);
    const two = await f.host.openView('connection-2', reviewer);
    const outside = await f.host.openView('connection-1', other);
    const firstClosed = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-1' && change.type === 'closed');
    const secondClosed = f.nextViewChange(({ connectionId, change }) => connectionId === 'connection-2' && change.type === 'closed');
    await expect(f.host.teardown(['worker'])).resolves.toMatchObject({ path: ['worker'], removed: true });
    expect(await Promise.all([firstClosed, secondClosed])).toEqual([
      { connectionId: 'connection-1', change: { type: 'closed', path: scout, attachmentGeneration: one.attachmentGeneration, reason: 'teardown' } },
      { connectionId: 'connection-2', change: { type: 'closed', path: reviewer, attachmentGeneration: two.attachmentGeneration, reason: 'teardown' } },
    ]);
    await expect(f.host.dispatch('connection-1', one, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('connection-2', two, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('connection-1', outside, { type: 'get_state' })).resolves.toBe('other-1:get_state');
  });

  it('routes child events on their view cursor without advancing the parent cursor', async () => {
    const f = fixture();
    const started = await f.host.start();
    const view = await f.host.openView('connection-1', scout);
    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event');
    f.surfaces.get('scout-1')!.emit(event);
    await delivered;
    expect(f.viewChanges).toContainEqual({
      connectionId: 'connection-1',
      change: {
        type: 'event',
        path: scout,
        attachmentGeneration: view.attachmentGeneration,
        event,
      },
    });
    expect(started.parentCursor).toBe(41);
    expect(f.pending.parentCursor).toBe(41);
    f.publish(semanticEvent(1));
    expect(f.pending.parentCursor).toBe(42);
    expect(view.snapshot.cursor).toBe(0);
  });
});
