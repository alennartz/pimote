import type {
  AgentPath,
  BorrowedAgentSession,
  FeedCursor,
  SubagentCapabilities,
  SubagentTopologyEvent,
  SubagentLease,
  SubagentLeaseEvent,
  SubagentNodeSnapshot,
  SubagentPresentationProvider,
  SubagentProviderEvent,
  SubagentProviderSnapshot,
  SubagentStopRequest,
  SubagentTeardownResult,
} from '@pimote/sdk/subagents';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import {
  createSessionSurface,
  type SessionSurface,
  type SessionSurfaceAttachment,
  type SessionSurfaceCapabilities,
  type SessionSurfaceCallerContext,
  type SessionSurfaceCommand,
  type SessionSurfaceOptions,
  type SessionSurfaceSnapshot,
} from './session-surface.js';

/** Semantic events enter the parent surface's replay stream at its cursor. */
export type ParentTopologyEventSink = (event: SubagentTopologyEvent, parentCursor: number) => void;
type ProviderOperationEvent = Exclude<SubagentProviderEvent, SubagentTopologyEvent>;
type ProviderFeedEvent = SubagentTopologyEvent | ProviderOperationEvent;

const TOPOLOGY_KINDS = new Set<SubagentTopologyEvent['kind']>(['node_added', 'node_updated', 'node_removed', 'runtime_replaced']);
const PRESENTATION_TYPES = new Set(['subagent_start', 'subagent_delta', 'subagent_end', 'subagent_snapshot_event']);

function isPresentationEvent(event: ProviderFeedEvent): event is ProviderOperationEvent {
  const candidate = event as unknown as { type?: unknown };
  return typeof candidate.type === 'string' && PRESENTATION_TYPES.has(candidate.type);
}

function isSupportedTopologyEvent(event: ProviderFeedEvent): event is SubagentTopologyEvent {
  return !isPresentationEvent(event) && TOPOLOGY_KINDS.has((event as unknown as { kind?: SubagentTopologyEvent['kind'] }).kind as SubagentTopologyEvent['kind']);
}

function providerEventIdentity(event: ProviderFeedEvent): string {
  if (isPresentationEvent(event)) {
    const candidate = event as unknown as { type: string; eventId: string; cursor: FeedCursor };
    return `${candidate.type}:${candidate.eventId}:${candidate.cursor.epoch}:${candidate.cursor.sequence}`;
  }
  return `${event.kind}:${event.eventId}:${event.cursor.epoch}:${event.cursor.sequence}`;
}

/** What a view command names. The client id is the observer identity. */
export interface SubagentViewReference {
  readonly path: AgentPath;
  /** Optional runtime guard supplied by newer wire clients. */
  readonly incarnation?: string;
}

/** Result of one attach. Payload travels as view frames before the response. */
export interface SubagentViewOpenResult {
  readonly path: AgentPath;
  readonly incarnation: string;
  readonly viewCursor: number;
  readonly mode: 'events' | 'snapshot';
}

export type SubagentViewClosedReason = 'replaced' | 'unavailable' | 'teardown';

export type SubagentViewChange =
  | { type: 'snapshot'; snapshot: SessionSurfaceSnapshot }
  | { type: 'event'; event: PimoteSessionEvent }
  | { type: 'closed'; reason: SubagentViewClosedReason };

export interface SubagentHostStartResult {
  readonly snapshot: SubagentProviderSnapshot;
  readonly providerCursor: FeedCursor;
  /** Parent cursor after the hierarchy snapshot boundary. */
  readonly parentCursor: number;
}

export interface SubagentHostOptions {
  rootSessionId: string;
  provider: SubagentPresentationProvider;
  parentSurface: SessionSurface;
  parentCursor: () => number;
  emitParentEvent: ParentTopologyEventSink;
  /** One view change for one observing client. */
  emitViewChange: (clientId: string, change: SubagentViewChange, path: AgentPath, incarnation: string, viewCursor: number) => void;
  childCapabilities: (session: BorrowedAgentSession) => SessionSurfaceCapabilities;
  createChildSurface?: (options: SessionSurfaceOptions) => SessionSurface;
}

/**
 * Per-root provider host. It is not part of the root session-slot registry.
 *
 * The host owns one child surface per agent path, with observers keyed by
 * client. The surface and the provider lease live while at least one observer
 * is attached, so two clients sharing a child share one transcript, one replay
 * cursor, and one lease. Provider events are projected into the parent
 * surface; child transcript events stay on the child surface's cursor.
 */
export type SubagentSurfaceCommand = SessionSurfaceCommand & { readonly expectedSessionId?: string };

export interface SubagentHost {
  /** Subscribe to provider events before requesting the first hierarchy snapshot. */
  start(): Promise<SubagentHostStartResult>;
  /** Attach one client to a child surface and replay from its cursor. */
  openView(clientId: string, path: AgentPath, after?: number): Promise<SubagentViewOpenResult>;
  /** Detach one client. The last detach closes the surface and releases the lease. */
  closeView(clientId: string, path: AgentPath): Promise<void>;
  /** Detach every view this client observes. */
  detachClient(clientId: string): Promise<void>;
  dispatch(clientId: string, view: SubagentViewReference, command: SubagentSurfaceCommand, caller?: SessionSurfaceCallerContext): Promise<unknown>;
  /** Stop one current child without requiring a borrowed view. */
  stop(request: SubagentStopRequest): Promise<void>;
  /** Return the latest provider hierarchy snapshot at the host boundary. */
  snapshot(): SubagentProviderSnapshot;
  /** Delegate resurrection through the provider's owner-control seam. */
  resurrect(request: import('@pimote/sdk/subagents').SubagentResurrectRequest): Promise<import('@pimote/sdk/subagents').SubagentResurrectResult>;
  /** Teardown a path or subtree through the provider's owner-control seam. */
  teardown(path: AgentPath, incarnation?: string): Promise<SubagentTeardownResult>;
  /** Close all views when the root runtime is replaced or closed. */
  shutdown(reason?: 'replaced' | 'unavailable'): Promise<void>;
}

type ViewRecord = {
  readonly key: string;
  readonly path: AgentPath;
  incarnation: string;
  readonly lease: SubagentLease;
  surface: SessionSurface | undefined;
  snapshot: SessionSurfaceSnapshot | undefined;
  surfaceUnsubscribe?: () => void;
  leaseUnsubscribe?: () => void;
  /** One entry per observing client. The surface keeps the matching cursor. */
  readonly observers: Map<string, SessionSurfaceAttachment>;
  /** Events observed while a surface snapshot is being assembled. */
  stagedEvents: PimoteSessionEvent[];
  ready: boolean;
  closed: boolean;
  /** Serialize asynchronous replacement and refresh operations. */
  transition: Promise<void>;
};

type ProviderWithShutdown = SubagentPresentationProvider & { shutdown?: () => void | Promise<void> };

const pathKey = (path: AgentPath): string => JSON.stringify(path);
const clonePath = (path: AgentPath): AgentPath => Object.freeze([...path]);
const isPathPrefix = (prefix: AgentPath, path: AgentPath): boolean => prefix.length <= path.length && prefix.every((part, index) => part === path[index]);

/** First cursor minus one for a fresh child surface. A rebuilt surface starts
 *  above every cursor its predecessor handed out, so both a stale client
 *  cursor and a live client's last position sit below its first event. */
const surfaceBaseCursor = (previousCursor: number): number => Math.max(Date.now() * 1000, previousCursor + 1);

function providerCapabilities(session: BorrowedAgentSession, leaseCapabilities: SubagentCapabilities, localCapabilities: SessionSurfaceCapabilities): SessionSurfaceCapabilities {
  // The callback owns Pimote-specific adapters. The provider owns the narrow
  // identity-preserving admission projection. Merge both without exposing the
  // provider object itself to the child surface.
  const merged: SessionSurfaceCapabilities = { ...localCapabilities };
  if (leaseCapabilities.operations !== undefined) merged.operations = [...leaseCapabilities.operations];
  if (leaseCapabilities.renderer !== undefined) merged.renderer = { ...localCapabilities.renderer, ...leaseCapabilities.renderer };
  if (leaseCapabilities.resolveModel !== undefined) {
    merged.resolveModel = async (provider, modelId) => {
      const resolved = await leaseCapabilities.resolveModel?.(provider, modelId);
      return resolved as Parameters<BorrowedAgentSession['setModel']>[0] | undefined;
    };
  }
  if (leaseCapabilities.getSettings !== undefined) merged.getSettings = () => leaseCapabilities.getSettings?.() as ReturnType<SessionSurfaceCapabilities['getSettings']>;
  if (leaseCapabilities.getCommands !== undefined)
    merged.getCommands = async () => (await leaseCapabilities.getCommands?.()) as ReturnType<SessionSurfaceCapabilities['getCommands']> extends Promise<infer T> ? T : never;
  if (leaseCapabilities.completeArgs !== undefined)
    merged.completeArgs = async (commandName, prefix) =>
      (await leaseCapabilities.completeArgs?.(commandName, prefix)) as ReturnType<SessionSurfaceCapabilities['completeArgs']> extends Promise<infer T> ? T : never;
  if (leaseCapabilities.completeFileRefs !== undefined)
    merged.completeFileRefs = async (prefix) =>
      (await leaseCapabilities.completeFileRefs?.(prefix)) as ReturnType<SessionSurfaceCapabilities['completeFileRefs']> extends Promise<infer T> ? T : never;
  if (leaseCapabilities.nativeBash !== undefined) {
    const native = leaseCapabilities.nativeBash;
    merged.nativeBash = {
      admitted: native.admitted,
      execute: native.execute ? async (command, options) => native.execute?.(command, options) : localCapabilities.nativeBash?.execute,
      abort: native.abort ? async () => native.abort?.() : localCapabilities.nativeBash?.abort,
    };
  }
  if (leaseCapabilities.executeBash !== undefined) merged.executeBash = async (command, options) => leaseCapabilities.executeBash?.(command, options);
  return merged;
}

/** Construct the provider host for one root session. */
export function createSubagentHost(options: SubagentHostOptions): SubagentHost {
  const views = new Map<string, ViewRecord>();
  const inFlightCreates = new Map<string, Promise<ViewRecord>>();
  const nodes = new Map<string, SubagentNodeSnapshot>();
  const seenEventIdentities = new Set<string>();
  const createSurface = options.createChildSurface ?? createSessionSurface;

  let started = false;
  let closed = false;
  let starting = false;
  let stagedProviderEvents: ProviderFeedEvent[] = [];
  let providerUnsubscribe: (() => void) | undefined;
  let nextParentCursor: number | undefined;
  let lastSnapshot: SubagentProviderSnapshot | undefined;

  const observeNode = (node: SubagentNodeSnapshot): void => {
    const copy: SubagentNodeSnapshot = {
      ...node,
      path: clonePath(node.path),
      channels: Object.freeze([...(node.channels ?? [])]),
      waitingFor: Object.freeze((node.waitingFor ?? []).map((target) => clonePath(target))),
    };
    nodes.set(pathKey(copy.path), copy);
  };

  const replaceSnapshotNodes = (snapshot: SubagentProviderSnapshot): void => {
    nodes.clear();
    for (const node of snapshot.nodes) observeNode(node);
    lastSnapshot = snapshot;
  };

  const liveRecord = (key: string): ViewRecord | undefined => {
    const record = views.get(key);
    return record && !record.closed ? record : undefined;
  };

  const cursorForChange = (record: ViewRecord, change: SubagentViewChange): number => {
    if (change.type === 'snapshot') return change.snapshot.cursor;
    if (change.type === 'event') return 'cursor' in change.event && typeof change.event.cursor === 'number' ? change.event.cursor : (record.surface?.currentCursor ?? 0);
    return record.surface?.currentCursor ?? 0;
  };

  const emitTo = (clientId: string, record: ViewRecord, change: SubagentViewChange): void => {
    options.emitViewChange(clientId, change, clonePath(record.path), record.incarnation, cursorForChange(record, change));
  };

  const emitAll = (record: ViewRecord, change: SubagentViewChange): void => {
    for (const clientId of [...record.observers.keys()]) emitTo(clientId, record, change);
  };

  const releaseObservers = (record: ViewRecord): void => {
    for (const attachment of [...record.observers.values()]) {
      try {
        attachment.release();
      } catch {
        // A closed surface cannot release its own observers twice.
      }
    }
    record.observers.clear();
  };

  const removeView = (record: ViewRecord): void => {
    if (views.get(record.key) === record) views.delete(record.key);
  };

  const closeRecord = async (record: ViewRecord, reason: SubagentViewClosedReason | 'released', notify: boolean): Promise<void> => {
    if (record.closed) return;
    record.closed = true;
    record.ready = false;
    removeView(record);
    record.surfaceUnsubscribe?.();
    record.surfaceUnsubscribe = undefined;
    record.leaseUnsubscribe?.();
    record.leaseUnsubscribe = undefined;
    if (notify && reason !== 'released') emitAll(record, { type: 'closed', reason });
    record.surface?.close();
    record.surface = undefined;
    releaseObservers(record);
    await record.lease.release();
  };

  const closeSubtree = async (path: AgentPath, reason: 'unavailable' | 'teardown'): Promise<void> => {
    const affected: ViewRecord[] = [];
    for (const record of views.values()) if (!record.closed && isPathPrefix(path, record.path)) affected.push(record);
    await Promise.all(affected.map((record) => closeRecord(record, reason, true)));
  };

  const surfaceForPath = (path: AgentPath): SessionSurface | undefined => {
    if (path.length === 0) return options.parentSurface;
    const record = views.get(pathKey(path));
    return record && !record.closed ? record.surface : undefined;
  };

  const appendParentEvent = (event: SubagentTopologyEvent): number => {
    const observed = options.parentCursor();
    if (nextParentCursor === undefined || observed > nextParentCursor) nextParentCursor = observed;
    const parentCursor = (nextParentCursor ?? observed) + 1;
    nextParentCursor = parentCursor;
    options.emitParentEvent(event, parentCursor);
    const after = options.parentCursor();
    if (after > nextParentCursor) nextParentCursor = after;
    return parentCursor;
  };

  const updateNodesForEvent = (event: SubagentTopologyEvent): void => {
    if (event.kind === 'node_added' || event.kind === 'node_updated') {
      if ('path' in event.data) observeNode(event.data);
      else {
        const previous = nodes.get(pathKey(event.path));
        if (previous) observeNode({ ...previous, sessionId: event.data.sessionId });
      }
      return;
    }
    if (event.kind === 'node_removed') {
      nodes.delete(pathKey(event.data.node.path));
      void closeSubtree(event.data.node.path, 'teardown');
      return;
    }
    if (event.kind === 'runtime_replaced') {
      const previous = nodes.get(pathKey(event.path));
      if (previous) observeNode({ ...previous, sessionId: event.data.newSessionId });
    }
  };

  const appendProviderEvent = (event: ProviderFeedEvent): void => {
    if (closed) return;
    // Older providers can replay lifecycle facts (`completion`, `resurrect`,
    // `teardown`, and similar) through the provider feed. They are not
    // topology and must never cross Pimote's typed wire seam.
    if (!isPresentationEvent(event) && !isSupportedTopologyEvent(event)) return;
    const identity = providerEventIdentity(event);
    if (seenEventIdentities.has(identity)) return;
    seenEventIdentities.add(identity);
    if (isPresentationEvent(event)) {
      const path = (event as SubagentProviderEvent & { target: { path: AgentPath } }).target.path;
      const surface = path.length === 0 ? options.parentSurface : surfaceForPath(path);
      // Presentation operations belong to the transcript surface that owns the
      // logical path. They never enter the root hierarchy event stream.
      surface?.acceptProviderEvent?.(event);
      return;
    }
    const boundary = lastSnapshot?.cursor;
    const snapshotCoversEvent = boundary !== undefined && event.cursor.epoch === boundary.epoch && event.cursor.sequence <= boundary.sequence;
    // Historical topology is already represented by the current snapshot.
    // Forward only its semantic history, not removed or replaced incarnations.
    if (snapshotCoversEvent && (event.kind === 'node_added' || event.kind === 'node_updated' || event.kind === 'node_removed' || event.kind === 'runtime_replaced')) return;
    updateNodesForEvent(event);
    appendParentEvent(event);
  };

  const receiveProviderEvent = (event: ProviderFeedEvent): void => {
    if (closed) return;
    if (starting) stagedProviderEvents.push(event);
    else appendProviderEvent(event);
  };

  const assertStarted = (): void => {
    if (closed) throw new Error('subagent host is shut down');
    if (!started) throw new Error('subagent host has not started');
  };

  const assertReference = (view: SubagentViewReference): ViewRecord => {
    const record = liveRecord(pathKey(view.path));
    if (!record || pathKey(record.path) !== pathKey(view.path)) throw new Error('subagent view is not open');
    if (view.incarnation !== undefined && record.incarnation !== view.incarnation) throw new Error('stale child incarnation');
    return record;
  };

  const assertCurrentIncarnation = (record: ViewRecord): void => {
    const current = nodes.get(record.key);
    if (!current || current.incarnation !== record.incarnation) throw new Error('stale child incarnation');
  };

  const surfaceOptions = (
    record: ViewRecord,
    session: BorrowedAgentSession,
    leaseCapabilities: SubagentCapabilities,
    /** Cursor handed out by the surface this one replaces. */
    previousCursor: number,
    initialProjection?: import('./subagent-transcript-projector.js').SubagentProjectionSnapshot,
  ): SessionSurfaceOptions => {
    const localCapabilities = options.childCapabilities(session);
    const capabilities = providerCapabilities(session, leaseCapabilities, localCapabilities);
    return {
      sessionId: session.sessionId,
      session,
      kind: 'child',
      capabilities,
      baseCursor: surfaceBaseCursor(previousCursor),
      parentCursor: options.parentCursor(),
      path: record.path,
      incarnation: record.incarnation,
      subagentProvider: options.provider as unknown as SessionSurfaceOptions['subagentProvider'],
      subagentPath: record.path,
      ...(initialProjection ? { initialProjection } : {}),
      stop: async (request) => {
        const expectedSessionId = request.expectedSessionId;
        if (expectedSessionId !== record.lease.session.sessionId) throw new Error('stale child runtime');
        await options.provider.stop({
          path: record.path,
          incarnation: record.incarnation,
          expectedSessionId,
        });
      },
    };
  };

  const refreshSurface = async (record: ViewRecord, notifySnapshot: boolean, inheritedSnapshot?: SessionSurfaceSnapshot): Promise<void> => {
    if (record.closed) return;
    const session = record.lease.session;
    let previousProjection: import('./subagent-transcript-projector.js').SubagentProjectionSnapshot | undefined;
    try {
      const previousSnapshot = inheritedSnapshot ?? record.surface?.snapshot?.();
      if (previousSnapshot) {
        previousProjection = {
          messages: previousSnapshot.messages,
          activeOperations: (previousSnapshot.activeSubagentContent ?? []).map((operation) => ({
            target: {
              operationId: operation.operationId,
              kind: operation.kind,
              path: clonePath(record.path),
              ...(operation.placement ? { placement: operation.placement } : {}),
            },
            data: operation.data,
          })) as import('@pimote/sdk/subagents').ActiveSubagentOperation[],
        };
      }
    } catch {
      previousProjection = undefined;
    }
    const previousCursor = record.surface?.currentCursor ?? 0;
    const nextSurface = createSurface(surfaceOptions(record, session, record.lease.capabilities, previousCursor, previousProjection));
    const staged: PimoteSessionEvent[] = [];
    record.stagedEvents = staged;
    record.ready = false;
    const previousSurface = record.surface;
    record.surfaceUnsubscribe?.();
    record.surfaceUnsubscribe = undefined;
    previousSurface?.close();
    record.surface = nextSurface;
    record.surfaceUnsubscribe = nextSurface.subscribe((event) => {
      if (record.closed || record.surface !== nextSurface) return;
      if (!record.ready) staged.push(event);
      else emitAll(record, { type: 'event', event });
    });
    try {
      const snapshot = await nextSurface.initialize();
      if (record.closed || record.surface !== nextSurface) {
        nextSurface.close();
        return;
      }
      record.snapshot = snapshot;
      record.ready = true;
      if (notifySnapshot) emitAll(record, { type: 'snapshot', snapshot });
      const pending = [...staged];
      staged.length = 0;
      for (const event of pending) emitAll(record, { type: 'event', event });
    } catch (error) {
      nextSurface.close();
      if (!record.closed) await closeRecord(record, 'unavailable', true);
      throw error;
    }
  };

  const refreshCurrentSnapshot = (record: ViewRecord): void => {
    if (record.closed || !record.surface) return;
    const surface = record.surface;
    const staged: PimoteSessionEvent[] = [];
    record.stagedEvents = staged;
    record.ready = false;
    try {
      const snapshot = surface.refreshSnapshot();
      if (record.closed || record.surface !== surface) return;
      record.snapshot = snapshot;
      emitAll(record, { type: 'snapshot', snapshot });
      record.ready = true;
      const pending = [...staged];
      staged.length = 0;
      for (const event of pending) emitAll(record, { type: 'event', event });
    } finally {
      if (!record.closed && record.surface === surface) record.ready = true;
    }
  };

  const refreshAfterNavigation = (record: ViewRecord): Promise<void> => {
    const next = record.transition
      .then(() => refreshCurrentSnapshot(record))
      .catch(() => {
        if (!record.closed) return closeRecord(record, 'unavailable', true);
      });
    record.transition = next;
    return next;
  };

  const enqueueTransition = (record: ViewRecord, operation: () => Promise<void>): void => {
    record.transition = record.transition.then(operation).catch(() => {
      if (!record.closed) return closeRecord(record, 'unavailable', true);
    });
  };

  const handleLeaseEvent = (record: ViewRecord, event: SubagentLeaseEvent): void => {
    if (record.closed) return;
    if (event.kind === 'closed') {
      void closeRecord(record, event.reason === 'removed' ? 'teardown' : 'unavailable', true);
      return;
    }
    enqueueTransition(record, async () => {
      if (record.closed) return;
      await refreshSurface(record, true);
    });
  };

  const createRecord = (path: AgentPath): Promise<ViewRecord> => {
    const key = pathKey(path);
    const pending = inFlightCreates.get(key);
    if (pending) return pending;
    const operation = (async (): Promise<ViewRecord> => {
      const currentSnapshot = options.provider.snapshot();
      replaceSnapshotNodes(currentSnapshot);
      const node = nodes.get(key);
      if (!node) throw new Error(`subagent path is unavailable: ${key}`);
      const lease = await options.provider.acquire(clonePath(path));
      const record: ViewRecord = {
        key,
        path: clonePath(path),
        incarnation: node.incarnation,
        lease,
        surface: undefined,
        snapshot: undefined,
        observers: new Map(),
        stagedEvents: [],
        ready: false,
        closed: false,
        transition: Promise.resolve(),
      };
      views.set(key, record);
      record.leaseUnsubscribe = lease.subscribe((event) => handleLeaseEvent(record, event));
      try {
        await refreshSurface(record, false);
        return record;
      } catch (error) {
        await closeRecord(record, 'unavailable', false);
        throw error;
      }
    })();
    inFlightCreates.set(key, operation);
    void operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (inFlightCreates.get(key) === operation) inFlightCreates.delete(key);
      });
    return operation;
  };

  const openView = async (clientId: string, path: AgentPath, after?: number): Promise<SubagentViewOpenResult> => {
    assertStarted();
    if (closed) throw new Error('subagent host is shut down');
    const key = pathKey(path);
    const existing = liveRecord(key);
    const record = existing ?? (await createRecord(path));
    const surface = record.surface;
    if (!surface) throw new Error('subagent view is unavailable');
    if (record.closed) throw new Error('subagent view is unavailable');
    // A client cursor can only be trusted against a surface that client has
    // already seen. A fresh record and a caller without a cursor both ask for
    // state, not history: -1 falls below the base cursor and yields a
    // snapshot.
    const attachment = await surface.attachObserver(clientId, existing ? (after ?? -1) : -1);
    if (record.closed || record.surface !== surface) {
      attachment.release();
      throw new Error('subagent view is unavailable');
    }
    record.observers.set(clientId, attachment);
    if (attachment.events) {
      for (const event of attachment.events) emitTo(clientId, record, { type: 'event', event });
    } else if (attachment.snapshot) {
      emitTo(clientId, record, { type: 'snapshot', snapshot: attachment.snapshot });
    }
    return {
      path: clonePath(record.path),
      incarnation: record.incarnation,
      viewCursor: attachment.cursor,
      mode: attachment.events ? 'events' : 'snapshot',
    };
  };

  const closeView = async (clientId: string, path: AgentPath): Promise<void> => {
    assertStarted();
    const record = liveRecord(pathKey(path));
    if (!record) return;
    const attachment = record.observers.get(clientId);
    if (!attachment) return;
    record.observers.delete(clientId);
    attachment.release();
    if (record.observers.size === 0) await closeRecord(record, 'released', false);
  };

  const detachClient = async (clientId: string): Promise<void> => {
    const records = [...views.values()].filter((record) => !record.closed && record.observers.has(clientId));
    for (const record of records) {
      const attachment = record.observers.get(clientId);
      if (!attachment) continue;
      record.observers.delete(clientId);
      attachment.release();
      if (record.observers.size === 0) await closeRecord(record, 'released', false);
    }
  };

  const dispatch = async (clientId: string, view: SubagentViewReference, command: SubagentSurfaceCommand, caller?: SessionSurfaceCallerContext): Promise<unknown> => {
    assertStarted();
    const record = assertReference(view);
    assertCurrentIncarnation(record);
    if (!record.observers.has(clientId)) throw new Error('subagent view is not open');
    const expectedSessionId = (command as SessionSurfaceCommand & { expectedSessionId?: unknown }).expectedSessionId;
    if (command.type === 'abort' && expectedSessionId !== undefined) {
      if (typeof expectedSessionId !== 'string' || expectedSessionId !== record.lease.session.sessionId) throw new Error('stale child runtime');
      // Keep the expected identity in the owner-control request. Calling the
      // borrowed session's abort directly would allow a replacement runtime to
      // win a race between validation and dispatch.
      await options.provider.stop({
        path: record.path,
        incarnation: record.incarnation,
        expectedSessionId,
      });
      return { steering: [], followUp: [] };
    }
    if (!record.surface) throw new Error('child surface is closed');
    const result = await record.surface.dispatch(command, caller);
    if (command.type === 'navigate_tree' && (!result || typeof result !== 'object' || (result as { cancelled?: unknown }).cancelled !== true)) {
      // Tree navigation changes the shared saved branch. The one live surface
      // replaces its transcript and replay cursor for every observer.
      const refreshed = await refreshAfterNavigation(record).then(
        () => true,
        () => false,
      );
      if (!refreshed) throw new Error('subagent view is unavailable');
    }
    return result;
  };

  const start = async (): Promise<SubagentHostStartResult> => {
    if (closed) throw new Error('subagent host is shut down');
    if (started && lastSnapshot) return { snapshot: lastSnapshot, providerCursor: lastSnapshot.cursor, parentCursor: Math.max(options.parentCursor(), nextParentCursor ?? 0) };
    if (starting) throw new Error('subagent host is already starting');
    starting = true;
    stagedProviderEvents = [];
    providerUnsubscribe = options.provider.subscribe(receiveProviderEvent as (event: ProviderFeedEvent) => void);
    try {
      const snapshot = options.provider.snapshot();
      replaceSnapshotNodes(snapshot);
      // Replay retained semantics before draining the live snapshot boundary.
      // Keep staging while either source delivers events, then deduplicate them.
      const replay = options.provider.replay();
      if (replay.kind === 'events') {
        for (const event of replay.events) appendProviderEvent(event);
      }
      while (stagedProviderEvents.length > 0) {
        const boundaryEvents = stagedProviderEvents;
        stagedProviderEvents = [];
        for (const event of boundaryEvents) appendProviderEvent(event);
      }
      starting = false;
      started = true;
      return {
        snapshot,
        providerCursor: snapshot.cursor,
        parentCursor: Math.max(options.parentCursor(), nextParentCursor ?? 0),
      };
    } catch (error) {
      starting = false;
      stagedProviderEvents = [];
      providerUnsubscribe?.();
      providerUnsubscribe = undefined;
      throw error;
    }
  };

  const snapshot = (): SubagentProviderSnapshot => {
    assertStarted();
    const current = options.provider.snapshot();
    replaceSnapshotNodes(current);
    return current;
  };

  const resurrect = async (request: import('@pimote/sdk/subagents').SubagentResurrectRequest): Promise<import('@pimote/sdk/subagents').SubagentResurrectResult> => {
    assertStarted();
    return options.provider.resurrect(request);
  };

  const stop = async (request: SubagentStopRequest): Promise<void> => {
    assertStarted();
    const current = options.provider.snapshot();
    replaceSnapshotNodes(current);
    const node = nodes.get(pathKey(request.path));
    if (!node || node.incarnation !== request.incarnation || node.sessionId !== request.expectedSessionId) throw new Error('stale child runtime');
    await options.provider.stop({ ...request, path: clonePath(request.path) });
  };

  const teardown = async (path: AgentPath, incarnation?: string): Promise<SubagentTeardownResult> => {
    assertStarted();
    const key = pathKey(path);
    const expectedIncarnation = incarnation ?? nodes.get(key)?.incarnation;
    if (!expectedIncarnation) throw new Error('stale child incarnation');
    const result = await options.provider.teardown(clonePath(path), expectedIncarnation);
    if (result.removed) {
      nodes.delete(key);
      await closeSubtree(path, 'teardown');
    }
    return result;
  };

  const shutdown = async (reason: 'replaced' | 'unavailable' = 'unavailable'): Promise<void> => {
    if (closed) return;
    closed = true;
    providerUnsubscribe?.();
    providerUnsubscribe = undefined;
    await Promise.all([...views.values()].map((record) => closeRecord(record, reason, true)));
    views.clear();
    inFlightCreates.clear();
    nodes.clear();
    // The root SessionSurface is owned by the session slot. Provider host
    // replacement must not close it while child views are being rebuilt.
    await (options.provider as ProviderWithShutdown).shutdown?.();
  };

  return {
    start,
    openView,
    closeView,
    detachClient,
    dispatch,
    snapshot,
    resurrect,
    stop,
    teardown,
    shutdown,
  };
}
