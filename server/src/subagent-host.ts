import type {
  AgentPath,
  BorrowedAgentSession,
  FeedCursor,
  SubagentCapabilities,
  SubagentEvent,
  SubagentLease,
  SubagentLeaseEvent,
  SubagentNodeSnapshot,
  SubagentProvider,
  SubagentSnapshot,
  SubagentTeardownResult,
} from '@pimote/sdk/subagents';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import {
  createSessionSurface,
  type SessionSurface,
  type SessionSurfaceCapabilities,
  type SessionSurfaceCallerContext,
  type SessionSurfaceCommand,
  type SessionSurfaceOptions,
  type SessionSurfaceSnapshot,
} from './session-surface.js';

/** Semantic events enter the parent surface's replay stream at its cursor. */
export type ParentSemanticEventSink = (event: SubagentEvent, parentCursor: number) => void;

export interface SubagentViewReference {
  readonly path: AgentPath;
  /** Opaque private generation for this connection-scoped attachment. */
  readonly attachmentGeneration: string;
  /** Optional incarnation guard supplied by newer wire clients. */
  readonly incarnation?: string;
}

export interface SubagentViewAttachment extends SubagentViewReference {
  readonly snapshot: SessionSurfaceSnapshot;
}

export type SubagentViewChange =
  | (SubagentViewReference & { type: 'snapshot'; snapshot: SessionSurfaceSnapshot })
  | (SubagentViewReference & { type: 'event'; event: PimoteSessionEvent })
  | (SubagentViewReference & { type: 'closed'; reason: 'replaced' | 'unavailable' | 'teardown' });

export interface SubagentHostStartResult {
  readonly snapshot: SubagentSnapshot;
  readonly providerCursor: FeedCursor;
  /** Parent cursor after the hierarchy snapshot boundary. */
  readonly parentCursor: number;
}

export interface SubagentHostOptions {
  rootSessionId: string;
  provider: SubagentProvider;
  parentSurface: SessionSurface;
  parentCursor: () => number;
  emitParentEvent: ParentSemanticEventSink;
  emitViewChange: (connectionId: string, change: SubagentViewChange, incarnation?: string, viewCursor?: number) => void;
  reconnectGraceMs: number;
  childCapabilities: (session: BorrowedAgentSession) => SessionSurfaceCapabilities;
  createChildSurface?: (options: SessionSurfaceOptions) => SessionSurface;
}

/**
 * Per-root provider host. It is not part of the root session-slot registry.
 *
 * The host owns connection-scoped child leases and view surfaces. Provider
 * events are projected into the parent surface; child transcript events stay
 * on each view surface's cursor.
 */
export type SubagentSurfaceCommand = SessionSurfaceCommand & { readonly expectedSessionId?: string };

export interface SubagentHost {
  /** Subscribe to provider events before requesting the first hierarchy snapshot. */
  start(): Promise<SubagentHostStartResult>;
  openView(connectionId: string, path: AgentPath, connectionToken?: number): Promise<SubagentViewAttachment>;
  closeView(connectionId: string, view: SubagentViewReference, connectionToken?: number): Promise<void>;
  dispatch(connectionId: string, view: SubagentViewReference, command: SubagentSurfaceCommand, connectionToken?: number, caller?: SessionSurfaceCallerContext): Promise<unknown>;
  /** Return the latest provider hierarchy snapshot at the host boundary. */
  snapshot(): SubagentSnapshot;
  /** Delegate resurrection through the provider's owner-control seam. */
  resurrect(request: import('@pimote/sdk/subagents').SubagentResurrectRequest): Promise<import('@pimote/sdk/subagents').SubagentResurrectResult>;
  /** Release every attachment for one connection without reconnect grace. */
  releaseConnection(connectionId: string, connectionToken?: number): Promise<void>;
  /** Close all views when the root runtime is replaced or closed. */
  shutdown(reason?: 'replaced' | 'unavailable'): Promise<void>;
  /** Keep attachments during the grace period for this reconnect identity. */
  disconnect(connectionId: string, connectionToken?: number): void;
  reconnect(connectionId: string, connectionToken?: number): Promise<readonly SubagentViewAttachment[]>;
  /**
   * Teardown a path or subtree through the provider's owner-control seam.
   * The optional incarnation and attachment identity guard confirmation flows.
   */
  teardown(path: AgentPath, incarnation?: string, connectionId?: string, attachmentGeneration?: string, connectionToken?: number): Promise<SubagentTeardownResult>;
  /** Release subscriptions, timers, child surfaces, and leases. */
  shutdown(): Promise<void>;
}

type ConnectionRecord = {
  readonly id: string;
  token: number;
  connected: boolean;
  timer?: ReturnType<typeof setTimeout>;
  readonly attachments: Map<string, ViewRecord>;
};

type ViewRecord = {
  readonly connection: ConnectionRecord;
  readonly key: string;
  readonly path: AgentPath;
  readonly attachmentGeneration: string;
  readonly lease: SubagentLease;
  incarnation: string;
  surface: SessionSurface | undefined;
  snapshot: SessionSurfaceSnapshot | undefined;
  surfaceUnsubscribe?: () => void;
  leaseUnsubscribe?: () => void;
  /** Events observed while a surface snapshot is being assembled. */
  stagedEvents: PimoteSessionEvent[];
  ready: boolean;
  closed: boolean;
  /** Serialize asynchronous replacement and refresh operations. */
  transition: Promise<void>;
};

type ProviderWithShutdown = SubagentProvider & { shutdown?: () => void | Promise<void> };

const pathKey = (path: AgentPath): string => JSON.stringify(path);
const clonePath = (path: AgentPath): AgentPath => Object.freeze([...path]);
const isPathPrefix = (prefix: AgentPath, path: AgentPath): boolean => prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
const randomGeneration = (rootSessionId: string, sequence: number): string => `${rootSessionId}:${sequence}:${Math.random().toString(36).slice(2)}`;

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
  const connections = new Map<string, ConnectionRecord>();
  const recordsByPath = new Map<string, Set<ViewRecord>>();
  const nodes = new Map<string, SubagentNodeSnapshot>();
  const seenEventIds = new Set<string>();
  const createSurface = options.createChildSurface ?? createSessionSurface;

  let started = false;
  let closed = false;
  let starting = false;
  let stagedProviderEvents: SubagentEvent[] = [];
  let providerUnsubscribe: (() => void) | undefined;
  let generation = 0;
  let nextParentCursor: number | undefined;
  let lastSnapshot: SubagentSnapshot | undefined;

  const observeNode = (node: SubagentNodeSnapshot): void => {
    const copy: SubagentNodeSnapshot = {
      ...node,
      path: clonePath(node.path),
      channels: Object.freeze([...node.channels]),
      waitingFor: Object.freeze(node.waitingFor.map((target) => clonePath(target))),
      pendingCorrelations: Object.freeze([...node.pendingCorrelations]),
    };
    nodes.set(pathKey(copy.path), copy);
  };

  const replaceSnapshotNodes = (snapshot: SubagentSnapshot): void => {
    nodes.clear();
    for (const node of snapshot.nodes) observeNode(node);
    lastSnapshot = snapshot;
  };

  const getConnection = (connectionId: string): ConnectionRecord => {
    const existing = connections.get(connectionId);
    if (existing) {
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      existing.connected = true;
      return existing;
    }
    const connection: ConnectionRecord = {
      id: connectionId,
      token: 1,
      connected: true,
      attachments: new Map(),
    };
    connections.set(connectionId, connection);
    return connection;
  };

  const emitViewChange = (record: ViewRecord, change: SubagentViewChange, allowClosed = false): void => {
    if ((!allowClosed && record.closed) || (!allowClosed && !record.connection.connected)) return;
    const viewCursor = change.type === 'snapshot' ? change.snapshot.cursor : record.surface?.currentCursor;
    options.emitViewChange(record.connection.id, change, record.incarnation, viewCursor);
  };

  const removeRecord = (record: ViewRecord): void => {
    const connectionRecord = record.connection.attachments.get(record.key);
    if (connectionRecord === record) record.connection.attachments.delete(record.key);
    const pathRecords = recordsByPath.get(record.key);
    if (pathRecords) {
      pathRecords.delete(record);
      if (pathRecords.size === 0) recordsByPath.delete(record.key);
    }
  };

  const closeRecord = async (record: ViewRecord, reason: 'released' | 'replaced' | 'unavailable' | 'teardown', notify: boolean): Promise<void> => {
    if (record.closed) return;
    record.closed = true;
    record.ready = false;
    removeRecord(record);
    record.leaseUnsubscribe?.();
    record.leaseUnsubscribe = undefined;
    record.surfaceUnsubscribe?.();
    record.surfaceUnsubscribe = undefined;
    record.surface?.close();
    record.surface = undefined;
    if (notify && reason !== 'released') {
      emitViewChange(
        record,
        {
          type: 'closed',
          path: record.path,
          attachmentGeneration: record.attachmentGeneration,
          reason,
        },
        true,
      );
    }
    await record.lease.release();
  };

  const closeSubtree = async (path: AgentPath, reason: 'unavailable' | 'teardown'): Promise<void> => {
    const affected: ViewRecord[] = [];
    for (const records of recordsByPath.values()) {
      for (const record of records) if (isPathPrefix(path, record.path)) affected.push(record);
    }
    await Promise.all(affected.map((record) => closeRecord(record, reason, true)));
  };

  const appendParentEvent = (event: SubagentEvent): number => {
    const observed = options.parentCursor();
    if (nextParentCursor === undefined || observed > nextParentCursor) nextParentCursor = observed;
    const parentCursor = (nextParentCursor ?? observed) + 1;
    nextParentCursor = parentCursor;
    options.emitParentEvent(event, parentCursor);
    const after = options.parentCursor();
    if (after > nextParentCursor) nextParentCursor = after;
    return parentCursor;
  };

  const updateNodesForEvent = (event: SubagentEvent): void => {
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

  const appendProviderEvent = (event: SubagentEvent): void => {
    if (closed || seenEventIds.has(event.eventId)) return;
    seenEventIds.add(event.eventId);
    updateNodesForEvent(event);
    appendParentEvent(event);
  };

  const receiveProviderEvent = (event: SubagentEvent): void => {
    if (closed) return;
    if (starting) stagedProviderEvents.push(event);
    else appendProviderEvent(event);
  };

  const assertStarted = (): void => {
    if (closed) throw new Error('subagent host is shut down');
    if (!started) throw new Error('subagent host has not started');
  };

  const assertConnectionToken = (connection: ConnectionRecord, token: number | undefined): void => {
    if (token !== undefined && token !== connection.token) throw new Error('stale connection token');
  };

  const assertReference = (connectionId: string, view: SubagentViewReference, token?: number): ViewRecord => {
    const connection = connections.get(connectionId);
    if (!connection) throw new Error('unknown connection');
    assertConnectionToken(connection, token);
    const record = connection.attachments.get(pathKey(view.path));
    if (
      !record ||
      record.closed ||
      record.attachmentGeneration !== view.attachmentGeneration ||
      pathKey(record.path) !== pathKey(view.path) ||
      (view.incarnation !== undefined && record.incarnation !== view.incarnation)
    )
      throw new Error('stale child view attachment');
    return record;
  };

  const assertCurrentIncarnation = (record: ViewRecord): void => {
    const current = nodes.get(record.key);
    if (!current || current.incarnation !== record.incarnation) throw new Error('stale child incarnation');
  };

  const surfaceOptions = (record: ViewRecord, session: BorrowedAgentSession, leaseCapabilities: SubagentCapabilities): SessionSurfaceOptions => {
    const localCapabilities = options.childCapabilities(session);
    const capabilities = providerCapabilities(session, leaseCapabilities, localCapabilities);
    return {
      sessionId: session.sessionId,
      session,
      kind: 'child',
      capabilities,
      parentCursor: options.parentCursor(),
      path: record.path,
      incarnation: record.incarnation,
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

  const refreshSurface = async (record: ViewRecord, notifySnapshot: boolean): Promise<void> => {
    if (record.closed) return;
    const session = record.lease.session;
    const nextSurface = createSurface(surfaceOptions(record, session, record.lease.capabilities));
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
      else
        emitViewChange(record, {
          type: 'event',
          path: record.path,
          attachmentGeneration: record.attachmentGeneration,
          event,
        });
    });
    try {
      const snapshot = await nextSurface.initialize();
      if (record.closed || record.surface !== nextSurface) {
        nextSurface.close();
        return;
      }
      record.snapshot = snapshot;
      record.ready = true;
      if (notifySnapshot) {
        emitViewChange(record, {
          type: 'snapshot',
          path: record.path,
          attachmentGeneration: record.attachmentGeneration,
          snapshot,
        });
      }
      const pending = [...staged];
      staged.length = 0;
      for (const event of pending) {
        emitViewChange(record, {
          type: 'event',
          path: record.path,
          attachmentGeneration: record.attachmentGeneration,
          event,
        });
      }
    } catch (error) {
      nextSurface.close();
      if (!record.closed) await closeRecord(record, 'unavailable', true);
      throw error;
    }
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

  const createViewRecord = async (connection: ConnectionRecord, path: AgentPath, node: SubagentNodeSnapshot, lease: SubagentLease): Promise<ViewRecord> => {
    const record: ViewRecord = {
      connection,
      key: pathKey(path),
      path: clonePath(path),
      attachmentGeneration: randomGeneration(options.rootSessionId, ++generation),
      lease,
      incarnation: node.incarnation,
      surface: undefined,
      snapshot: undefined,
      stagedEvents: [],
      ready: false,
      closed: false,
      transition: Promise.resolve(),
    };
    connection.attachments.set(record.key, record);
    const pathRecords = recordsByPath.get(record.key) ?? new Set<ViewRecord>();
    pathRecords.add(record);
    recordsByPath.set(record.key, pathRecords);
    record.leaseUnsubscribe = lease.subscribe((event) => handleLeaseEvent(record, event));
    try {
      await refreshSurface(record, false);
      return record;
    } catch (error) {
      await closeRecord(record, 'unavailable', false);
      throw error;
    }
  };

  const refreshAttachment = async (record: ViewRecord): Promise<void> => {
    if (record.closed) return;
    await record.transition;
    if (record.closed) return;
    await refreshSurface(record, false);
  };

  const start = async (): Promise<SubagentHostStartResult> => {
    if (closed) throw new Error('subagent host is shut down');
    if (started && lastSnapshot) return { snapshot: lastSnapshot, providerCursor: lastSnapshot.cursor, parentCursor: Math.max(options.parentCursor(), nextParentCursor ?? 0) };
    if (starting) throw new Error('subagent host is already starting');
    starting = true;
    stagedProviderEvents = [];
    providerUnsubscribe = options.provider.subscribe(receiveProviderEvent);
    try {
      const snapshot = options.provider.snapshot();
      replaceSnapshotNodes(snapshot);
      // A provider can return a boundary cursor while events are delivered by
      // the subscription in the same call. Drain both the staged feed and a
      // contiguous replay, de-duplicating by provider event id.
      const boundaryEvents = stagedProviderEvents;
      stagedProviderEvents = [];
      starting = false;
      for (const event of boundaryEvents) appendProviderEvent(event);
      const replay = options.provider.replay(snapshot.cursor);
      if (replay.kind === 'events') {
        for (const event of replay.events) appendProviderEvent(event);
      } else if (replay.kind === 'snapshot_required') {
        // The returned snapshot is already the recovery boundary. Keep the
        // latest node projection so opens after recovery validate incarnation.
        lastSnapshot = snapshot;
      }
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

  const openView = async (connectionId: string, path: AgentPath, connectionToken?: number): Promise<SubagentViewAttachment> => {
    assertStarted();
    const connection = getConnection(connectionId);
    assertConnectionToken(connection, connectionToken);
    const key = pathKey(path);
    const existing = connection.attachments.get(key);
    if (existing && !existing.closed && existing.snapshot) {
      return { path: existing.path, attachmentGeneration: existing.attachmentGeneration, snapshot: existing.snapshot };
    }
    const currentSnapshot = options.provider.snapshot();
    replaceSnapshotNodes(currentSnapshot);
    const node = nodes.get(key);
    if (!node) throw new Error(`subagent path is unavailable: ${key}`);
    const lease = await options.provider.acquire(clonePath(path));
    try {
      const record = await createViewRecord(connection, clonePath(path), node, lease);
      if (!record.snapshot) throw new Error('child surface did not return a snapshot');
      return { path: record.path, attachmentGeneration: record.attachmentGeneration, snapshot: record.snapshot };
    } catch (error) {
      await lease.release();
      throw error;
    }
  };

  const closeView = async (connectionId: string, view: SubagentViewReference, connectionToken?: number): Promise<void> => {
    assertStarted();
    const record = assertReference(connectionId, view, connectionToken);
    await closeRecord(record, 'released', false);
  };

  const dispatch = async (
    connectionId: string,
    view: SubagentViewReference,
    command: SubagentSurfaceCommand,
    connectionToken?: number,
    caller?: SessionSurfaceCallerContext,
  ): Promise<unknown> => {
    assertStarted();
    const record = assertReference(connectionId, view, connectionToken);
    assertCurrentIncarnation(record);
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
    return record.surface.dispatch(command, caller);
  };

  const disconnect = (connectionId: string, connectionToken?: number): void => {
    const connection = connections.get(connectionId);
    if (!connection || closed) return;
    assertConnectionToken(connection, connectionToken);
    if (!connection.connected) return;
    connection.connected = false;
    connection.token++;
    const timerToken = connection.token;
    if (connection.timer) clearTimeout(connection.timer);
    connection.timer = setTimeout(
      () => {
        if (closed || connection.connected || connection.token !== timerToken) return;
        connection.timer = undefined;
        const records = [...connection.attachments.values()];
        void Promise.all(records.map((record) => closeRecord(record, 'unavailable', true)));
      },
      Math.max(0, options.reconnectGraceMs),
    );
  };

  const reconnect = async (connectionId: string, connectionToken?: number): Promise<readonly SubagentViewAttachment[]> => {
    const connection = connections.get(connectionId);
    if (!connection || closed) return [];
    assertConnectionToken(connection, connectionToken);
    if (connection.timer) {
      clearTimeout(connection.timer);
      connection.timer = undefined;
    }
    connection.connected = true;
    connection.token++;
    const records = [...connection.attachments.values()];
    const attachments: SubagentViewAttachment[] = [];
    for (const record of records) {
      await refreshAttachment(record).catch(() => undefined);
      if (!record.closed && record.snapshot) attachments.push({ path: record.path, attachmentGeneration: record.attachmentGeneration, snapshot: record.snapshot });
    }
    return attachments;
  };

  const snapshot = (): SubagentSnapshot => {
    assertStarted();
    const current = options.provider.snapshot();
    replaceSnapshotNodes(current);
    return current;
  };

  const resurrect = async (request: import('@pimote/sdk/subagents').SubagentResurrectRequest): Promise<import('@pimote/sdk/subagents').SubagentResurrectResult> => {
    assertStarted();
    return options.provider.resurrect(request);
  };

  const releaseConnection = async (connectionId: string, connectionToken?: number): Promise<void> => {
    const connection = connections.get(connectionId);
    if (!connection || closed) return;
    assertConnectionToken(connection, connectionToken);
    if (connection.timer) {
      clearTimeout(connection.timer);
      connection.timer = undefined;
    }
    connection.connected = false;
    const records = [...connection.attachments.values()];
    await Promise.all(records.map((record) => closeRecord(record, 'released', false)));
    connection.token++;
  };

  const teardown = async (
    path: AgentPath,
    incarnation?: string,
    connectionId?: string,
    attachmentGeneration?: string,
    connectionToken?: number,
  ): Promise<SubagentTeardownResult> => {
    assertStarted();
    if (connectionId !== undefined) {
      const connection = connections.get(connectionId);
      if (!connection) throw new Error('unknown connection');
      assertConnectionToken(connection, connectionToken);
      if (attachmentGeneration !== undefined) assertReference(connectionId, { path, attachmentGeneration }, connectionToken);
    }
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
    for (const connection of connections.values()) {
      if (connection.timer) clearTimeout(connection.timer);
      connection.timer = undefined;
    }
    const records = [...recordsByPath.values()].flatMap((records) => [...records]);
    await Promise.all(records.map((record) => closeRecord(record, reason, true)));
    for (const connection of connections.values()) connection.connected = false;
    recordsByPath.clear();
    connections.clear();
    nodes.clear();
    (options.parentSurface as { close?: () => void }).close?.();
    await (options.provider as ProviderWithShutdown).shutdown?.();
  };

  return {
    start,
    openView,
    closeView,
    dispatch,
    snapshot,
    resurrect,
    releaseConnection,
    disconnect,
    reconnect,
    teardown,
    shutdown,
  };
}
