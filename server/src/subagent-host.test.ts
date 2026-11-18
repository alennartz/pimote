import { describe, expect, it } from 'vitest';
import type {
  AgentPath,
  BorrowedAgentSession,
  SubagentEvent,
  SubagentLease,
  SubagentLeaseEvent,
  SubagentNodeSnapshot,
  SubagentPresentationProvider,
  SubagentProviderEvent,
  SubagentStopRequest,
} from '@pimote/sdk/subagents';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { IncomingSdkEvent } from './event-buffer.js';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import { createSubagentHost, type SubagentViewChange } from './subagent-host.js';
import { createSessionSurface } from './session-surface.js';

const worker = ['worker'] as const;
const scout = ['worker', 'scout'] as const;
const reviewer = ['worker', 'reviewer'] as const;
const other = ['other'] as const;
const key = (path: AgentPath) => JSON.stringify(path);

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

function semanticEvent(sequence: number): SubagentEvent {
  return { eventId: `event-${sequence}`, cursor: { epoch: 'epoch-1', sequence }, path: scout, kind: 'node_updated', relatedPiEvents: [], data: node(scout, 'scout-1', 'waiting') };
}

function nativeSession(id: string) {
  const listeners = new Set<(event: IncomingSdkEvent) => void>();
  const messages: AgentMessage[] = [];
  let steering: string[] = [];
  let followUp: string[] = [];
  let streaming = false;
  let leaf: string | null = null;
  const entries = () =>
    messages.map((message, index) => ({ type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp: '2026-01-01T00:00:00.000Z', message }));
  const emit = (event: IncomingSdkEvent) => {
    if (event.type === 'agent_start') streaming = true;
    if (event.type === 'agent_settled') streaming = false;
    if (event.type === 'message_end') messages.push(event.message);
    for (const listener of listeners) listener(event);
  };
  const session = {
    sessionId: id,
    sessionFile: undefined,
    messages,
    model: null,
    thinkingLevel: 'off',
    get isStreaming() {
      return streaming;
    },
    get isIdle() {
      return !streaming;
    },
    isCompacting: false,
    isBashRunning: false,
    state: { streamingMessage: undefined, pendingToolCalls: new Set<string>(), errorMessage: undefined },
    sessionManager: { getEntries: entries, getBranch: entries, buildContextEntries: entries, getTree: () => [], getLeafId: () => leaf, getCwd: () => '/workspace' },
    subscribe(listener: (event: IncomingSdkEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string, options: { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (outcome: 'started' | 'queued') => void }) {
      if (streaming) {
        (options.streamingBehavior === 'followUp' ? followUp : steering).push(text);
        emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] });
        options.preflightResult?.('queued');
      } else {
        streaming = true;
        options.preflightResult?.('started');
      }
    },
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    clearQueue() {
      const result = { steering, followUp };
      steering = [];
      followUp = [];
      emit({ type: 'queue_update', steering, followUp });
      return result;
    },
    async abort() {
      streaming = false;
      emit({ type: 'agent_settled', aborted: true });
    },
    async navigateTree(targetId: string) {
      leaf = targetId;
      return { cancelled: false };
    },
    getContextUsage: () => null,
    getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
  } as unknown as BorrowedAgentSession;
  return { session, emit };
}

function fixture(retainedEvents: readonly SubagentProviderEvent[] = []) {
  const sessions = new Map<string, BorrowedAgentSession>();
  const surfaces = new Map<string, { emit: (event: PimoteSessionEvent) => void }>();
  const incarnations = new Map<string, string>();
  const add = (path: AgentPath, id: string) => {
    const native = nativeSession(id);
    sessions.set(key(path), native.session);
    surfaces.set(id, { emit: (event) => native.emit(event as IncomingSdkEvent) });
    if (!incarnations.has(key(path))) incarnations.set(key(path), `${id}-incarnation`);
    return native.session;
  };
  add(worker, 'worker-1');
  add(scout, 'scout-1');
  add(reviewer, 'reviewer-1');
  add(other, 'other-1');
  const leases = new Set<{ path: AgentPath; current: BorrowedAgentSession; notify: (event: SubagentLeaseEvent) => void }>();
  const listeners = new Set<(event: SubagentProviderEvent) => void>();
  type ViewNotification = { clientId: string; change: SubagentViewChange; path: readonly string[]; incarnation: string; viewCursor: number };
  const viewChanges: ViewNotification[] = [];
  const waiters = new Set<(notification: ViewNotification) => void>();
  const parentEvents: SubagentEvent[] = [];
  const stopRequests: SubagentStopRequest[] = [];
  const pending: {
    idleAnswer: string;
    delivered: string[];
    snapshotEvent?: SubagentEvent;
    parentCursor: number;
    acquireCalls: number;
    blockAcquire: boolean;
    releaseAcquire?: () => void;
    sequence: number;
  } = {
    idleAnswer: 'latest answer',
    delivered: [],
    parentCursor: 41,
    acquireCalls: 0,
    blockAcquire: false,
    sequence: retainedEvents.at(-1)?.cursor.sequence ?? 0,
  };
  const publish = (event: SubagentProviderEvent) => {
    pending.sequence = Math.max(pending.sequence, event.cursor.sequence);
    for (const listener of listeners) listener(event);
  };
  const capabilities = {
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
    ] as const,
    renderer: { visible: true },
    getSettings: () => ({ availableThinkingLevels: [], autoCompactionEnabled: false }),
    getCommands: async () => [],
    completeArgs: async () => [],
    completeFileRefs: async () => [],
  };
  const provider: SubagentPresentationProvider = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      if (pending.snapshotEvent) for (const listener of listeners) listener(pending.snapshotEvent);
      return {
        manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] },
        activeOperations: [],
        cursor: { epoch: 'epoch-1', sequence: pending.sequence },
        nodes: [...sessions].map(([path, session]) => ({ ...node(JSON.parse(path), session.sessionId), incarnation: incarnations.get(path)! })),
      };
    },
    replay: (after) => ({
      kind: 'events',
      cursor: { epoch: 'epoch-1', sequence: pending.sequence },
      events: retainedEvents.filter((event) => !after || event.cursor.sequence > after.sequence),
    }),
    async acquire(path) {
      pending.acquireCalls++;
      if (pending.blockAcquire)
        await new Promise<void>((resolve) => {
          pending.releaseAcquire = resolve;
        });
      const current = sessions.get(key(path));
      if (!current) throw new Error('unavailable');
      const subscriptions = new Set<(event: SubagentLeaseEvent) => void>();
      const record = {
        path,
        current,
        notify: (event: SubagentLeaseEvent) => {
          for (const listener of subscriptions) listener(event);
        },
      };
      leases.add(record);
      return {
        path,
        capabilities,
        get session() {
          if (!leases.has(record)) throw new Error('closed');
          return record.current;
        },
        subscribe(listener) {
          subscriptions.add(listener);
          return () => subscriptions.delete(listener);
        },
        async release() {
          if (!leases.delete(record)) return;
          if (key(path) === key(scout) && ![...leases].some((lease) => key(lease.path) === key(scout))) pending.delivered.push(pending.idleAnswer);
        },
      } satisfies SubagentLease;
    },
    async teardown(path) {
      for (const [stored] of sessions) if (path.every((part, index) => JSON.parse(stored)[index] === part)) sessions.delete(stored);
      for (const lease of [...leases])
        if (path.every((part, index) => lease.path[index] === part)) {
          leases.delete(lease);
          lease.notify({ kind: 'closed', reason: 'removed' });
        }
      return { path, removed: true };
    },
    async stop(request) {
      const current = sessions.get(key(request.path));
      if (!current || current.sessionId !== request.expectedSessionId || incarnations.get(key(request.path)) !== request.incarnation) throw new Error('stale child');
      stopRequests.push(request);
      await current.abort();
    },
    async resurrect(request) {
      const path = [...request.parentPath, request.localId];
      const sessionId = `resurrected-${request.sessionId}`;
      add(path, sessionId);
      return { path, sessionId, incarnation: incarnations.get(key(path)), node: node(path, sessionId) };
    },
  };
  const root = nativeSession('root-session');
  const rootSurface = createSessionSurface({ sessionId: root.session.sessionId, session: root.session, kind: 'root', subagentProvider: provider });
  void rootSurface.initialize();
  const host = createSubagentHost({
    rootSessionId: 'root-session',
    provider,
    parentSurface: rootSurface,
    parentCursor: () => pending.parentCursor,
    emitParentEvent: (event) => {
      parentEvents.push(event);
      pending.parentCursor++;
    },
    emitViewChange: (clientId, change, path, incarnation, viewCursor) => {
      const normalized = change.type === 'event' && change.event.type === 'full_resync' ? { type: 'snapshot' as const, snapshot: { ...change.event, cursor: viewCursor } } : change;
      const notification = { clientId, change: normalized, path, incarnation, viewCursor };
      viewChanges.push(notification);
      for (const waiter of waiters) waiter(notification);
      return true;
    },
  });
  return {
    host,
    rootSurface,
    rootSession: root.session,
    sessions,
    pending,
    parentEvents,
    stopRequests,
    viewChanges,
    surfaces,
    publish,
    active: (path: AgentPath) => [...leases].filter((lease) => key(lease.path) === key(path)).length,
    nextViewChange: (predicate: (notification: ViewNotification) => boolean) =>
      new Promise<ViewNotification>((resolve) => {
        const waiter = (notification: ViewNotification) => {
          if (predicate(notification)) {
            waiters.delete(waiter);
            resolve(notification);
          }
        };
        waiters.add(waiter);
      }),
    replace(path: AgentPath, id: string) {
      const previous = sessions.get(key(path))!;
      const replacement = add(path, id);
      publish({
        kind: 'runtime_replaced',
        eventId: `replace-${id}`,
        path,
        cursor: { epoch: 'epoch-1', sequence: pending.sequence + 1 },
        relatedPiEvents: [],
        data: { oldSessionId: previous.sessionId, newSessionId: id },
      });
      for (const lease of leases)
        if (key(lease.path) === key(path)) {
          lease.current = replacement;
          lease.notify({ kind: 'rebound', session: replacement, capabilities });
        }
    },
    unavailable(path: AgentPath) {
      sessions.delete(key(path));
      for (const lease of [...leases])
        if (key(lease.path) === key(path)) {
          leases.delete(lease);
          lease.notify({ kind: 'closed', reason: 'unavailable' });
        }
    },
    restore: add,
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
    const toolMessage = (id: string) => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'send', id, arguments: {} }], timestamp: 1 }) as AgentMessage;
    (f.rootSession.messages as AgentMessage[]).push(toolMessage('root-call'));
    (f.sessions.get(key(scout))!.messages as AgentMessage[]).push(toolMessage('child-call'));
    f.rootSurface.refreshSnapshot();
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
    const rootContent = f.rootSurface.snapshot().messages.flatMap((message) => message.content);
    const childMessages = (await f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_messages' })) as {
      messages: { content: { operationId?: string }[] }[];
    };
    expect(rootContent).toContainEqual(expect.objectContaining({ operationId: 'root-call' }));
    expect(rootContent).not.toContainEqual(expect.objectContaining({ operationId: 'child-call' }));
    expect(childMessages.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({ operationId: 'child-call' }));
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
    expect(f.viewChanges.filter(({ clientId }) => clientId === 'client-1').some(({ change }) => change.type === 'event' && change.event.type === 'agent_start')).toBe(false);

    await f.host.closeView('client-2', scout);
    expect(f.active(scout)).toBe(0);
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('replays a delta only to the attaching client', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('client-1', scout);
    const event: PimoteSessionEvent = { type: 'message_end', sessionId: 'scout-1', cursor: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'One' }] } };
    f.surfaces.get('scout-1')!.emit(event);
    const second = await f.host.openView('client-2', scout, first.viewCursor);
    expect(second.mode).toBe('events');
    const replay = f.viewChanges.find(({ clientId, change }) => clientId === 'client-2' && change.type === 'event' && change.event.type === 'buffered_events');
    expect(replay?.change).toMatchObject({
      type: 'event',
      event: { events: [expect.objectContaining({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'One' }] } })] },
    });
    expect(f.viewChanges.some(({ clientId, change }) => clientId === 'client-1' && change.type === 'event' && change.event.type === 'message_end')).toBe(true);
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
    await f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'navigate_tree', targetId: 'entry-1' });
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
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-2', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).resolves.toMatchObject({
      state: { sessionId: 'scout-1' },
    });

    await f.host.detachClient('client-2');
    expect(f.pending.delivered).toEqual(['latest answer']);
  });

  it('retains an offline sender’s draft across the last view closing', async () => {
    const f = fixture();
    await f.host.start();
    const first = await f.host.openView('client-1', scout);
    await f.host.openView('client-2', scout);
    f.surfaces.get('scout-1')!.emit({ type: 'agent_start', sessionId: 'scout-1', cursor: 1 });
    await f.host.dispatch('client-1', { path: scout, incarnation: first.incarnation }, { type: 'steer', message: 'Recover this question.' }, { clientId: 'client-1' });
    await f.host.closeView('client-1', scout);
    await f.host.dispatch('client-2', { path: scout, incarnation: first.incarnation }, { type: 'abort', expectedSessionId: 'scout-1' }, { clientId: 'client-2' });
    await f.host.closeView('client-2', scout);
    f.viewChanges.length = 0;
    await f.host.openView('client-1', scout);
    expect(f.viewChanges).toContainEqual(
      expect.objectContaining({
        clientId: 'client-1',
        change: { type: 'event', event: { type: 'queued_drafts_restored', sessionId: 'scout-1', steering: ['Recover this question.'], followUp: [] } },
      }),
    );
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
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).resolves.toMatchObject({
      state: { sessionId: 'scout-2' },
    });
    const oldEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const newEvent: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-2', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event' && change.event.sessionId === 'scout-2');
    f.surfaces.get('scout-1')!.emit(oldEvent);
    f.surfaces.get('scout-2')!.emit(newEvent);
    await delivered;
    expect(f.viewChanges.some(({ change }) => change.type === 'event' && change.event.type === 'agent_start' && change.event.sessionId === 'scout-1')).toBe(false);
    expect(f.viewChanges).toContainEqual(
      expect.objectContaining({ clientId: 'client-1', change: { type: 'event', event: expect.objectContaining({ type: 'agent_start', sessionId: 'scout-2' }) } }),
    );
  });

  it('rejects commands from a client that does not observe the view and from a stale incarnation', async () => {
    const f = fixture();
    await f.host.start();
    const view = await f.host.openView('client-1', scout);
    await expect(f.host.dispatch('client-2', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-1', { path: reviewer, incarnation: 'reviewer-1-incarnation' }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'stale' }, { type: 'get_state' })).rejects.toThrow('stale child incarnation');
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: view.incarnation }, { type: 'get_state' })).resolves.toMatchObject({ state: { sessionId: 'scout-1' } });
  });

  it('closes a view whose runtime disappears and notifies its observer', async () => {
    const f = fixture();
    await f.host.start();
    await f.host.openView('client-1', scout);
    const closed = f.nextViewChange(({ clientId, change }) => clientId === 'client-1' && change.type === 'closed');
    f.unavailable(scout);
    expect(await closed).toEqual(expect.objectContaining({ clientId: 'client-1', change: { type: 'closed', reason: 'unavailable' } }));
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).rejects.toThrow('subagent view is not open');
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
    await expect(f.host.dispatch('client-1', { path: scout, incarnation: 'scout-1-incarnation' }, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('client-2', { path: reviewer, incarnation: 'reviewer-1-incarnation' }, { type: 'get_state' })).rejects.toThrow();
    await expect(f.host.dispatch('client-1', { path: other, incarnation: 'other-1-incarnation' }, { type: 'get_state' })).resolves.toMatchObject({
      state: { sessionId: 'other-1' },
    });
  });

  it('routes child events on their view cursor without advancing the parent cursor', async () => {
    const f = fixture();
    const started = await f.host.start();
    const view = await f.host.openView('client-1', scout);
    const event: PimoteSessionEvent = { type: 'agent_start', sessionId: 'scout-1', cursor: 1 };
    const delivered = f.nextViewChange(({ change }) => change.type === 'event');
    f.surfaces.get('scout-1')!.emit(event);
    await delivered;
    expect(f.viewChanges).toContainEqual(
      expect.objectContaining({ clientId: 'client-1', change: { type: 'event', event: expect.objectContaining({ type: 'agent_start', sessionId: 'scout-1' }) }, path: scout }),
    );
    expect(started.parentCursor).toBe(41);
    expect(f.pending.parentCursor).toBe(41);
    f.publish(semanticEvent(1));
    expect(f.pending.parentCursor).toBe(42);
    expect(view.viewCursor).toBeTypeOf('number');
  });
});
