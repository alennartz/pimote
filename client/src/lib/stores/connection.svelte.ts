// ConnectionStore — Svelte 5 runes-based WebSocket connection manager
import type {
  OpenSessionResponseData,
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  PimoteServerMessage,
  RestoreMode,
  UserSessionsChangedEvent,
  UserOpenViewRef,
  SubagentViewEvent,
  FullResyncEvent,
  FullResyncStartEvent,
  FullResyncChunkEvent,
  FullResyncBranchChunkEvent,
  FullResyncJsonChunkEvent,
  FullResyncDataChunkEvent,
  PimoteActiveSubagentContent,
  PimoteAgentMessage,
  StreamingMessage,
} from '@pimote/shared';
import { SvelteMap } from 'svelte/reactivity';
import { JSONParser } from '@streamparser/json';
import { version } from '$app/environment';
import { clearActiveSessions, getClientId, getUser, setClientId } from './persistence.js';
import type { UserSessionFacts } from './user-session-facts.js';
import { updateStore } from './update.svelte.js';

type EventListener = (event: PimoteEvent) => void;

type FullResyncDataField = FullResyncDataChunkEvent['field'];

interface PendingJsonField {
  offset: number;
  parser: JSONParser | null;
  complete: boolean;
  failed: boolean;
}

interface PendingFullResync {
  readonly start: FullResyncStartEvent;
  readonly view?: SubagentViewEvent;
  readonly messages: PimoteAgentMessage[];
  readonly branchEntryIds: string[];
  readonly activeSubagentContent: PimoteActiveSubagentContent[];
  readonly runningToolCallIds: string[];
  messageMode: 'array' | 'json' | null;
  messageStreamComplete: boolean;
  jsonOffset: number;
  jsonParser: JSONParser | null;
  messageParseFailed: boolean;
  streamingMessage: StreamingMessage | null;
  jsonFields: Map<FullResyncDataField, PendingJsonField>;
}

/** Errors that mean a request may have reached the server before the socket dropped. */
export function isConnectionLossError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message === 'websocket closed' || message === 'websocket replaced' || message === 'websocket not connected') return true;
  // Browsers can throw their own wording when the socket closes between the
  // readyState check and ws.send(). Treat those as the same unknown outcome.
  return message.includes('websocket') && /closed|closing|not connected|not open|connecting|replaced/.test(message);
}

/** `open_session` rejections that are definitive: the session is neither live
 *  on the server nor persisted on disk, so no retry can succeed. The client
 *  must drop such sessions instead of restoring them forever. (The legacy
 *  `session_expired` string is accepted so a rolled-back server still gets
 *  the orphan cleanup.) */
export function isSessionNotFoundError(error: string | undefined): boolean {
  return error === 'session_not_found' || error === 'session_expired';
}

/** Notification-driven session adoption may also request its local download inbox. */
export interface PendingSessionAdopt {
  sessionId: string;
  folderPath: string;
  openDownloads?: boolean;
}

/** How to bring this connection's subscribed set in line with the user's
 *  server-side profile. */
export interface ReconcilePlan {
  /** Open via the existing restore path. */
  toOpen: { sessionId: string; folderPath: string }[];
  /** Remove locally, never open. */
  toDrop: string[];
}

/** Diff this connection's subscribed set against the server's profile truth.
 *  `fresh` marks a user with no server profile yet (never linked): the local
 *  set is then the one-time migration seed and gets adopted wholesale
 *  instead of dropped — a stale second browser with a `fresh: false` set
 *  reconciles down to server truth instead of resurrecting closed sessions. */
export function reconcileUserSessions(current: { sessionId: string; folderPath: string }[], server: { sessionId: string; folderPath: string }[], fresh: boolean): ReconcilePlan {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- pure-function locals, never read reactively
  const currentIds = new Set(current.map((s) => s.sessionId));
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- pure-function locals, never read reactively
  const serverIds = new Set(server.map((s) => s.sessionId));
  const toOpen = server.filter((s) => !currentIds.has(s.sessionId));
  const toDrop: string[] = [];
  if (fresh) {
    toOpen.push(...current);
  } else {
    for (const s of current) {
      if (!serverIds.has(s.sessionId)) toDrop.push(s.sessionId);
    }
  }
  return { toOpen, toDrop };
}

/** One-time migration gate: after the first user_sessions_changed of the page
 *  clears the local mirror, nothing reads or writes pimote:activeSessions
 *  again — the server's per-user profile is the only open-session set. */
let localMirrorCleared = false;

let nextId = 1;
/** Identity of this tab. sessionStorage, not localStorage: two tabs must not
 *  share an id — a repeat id makes the server read the other tab's reconnect
 *  as a stale-connection takeover and close this socket, so two tabs evict
 *  each other in a loop and the UI flaps between connected and reconnecting —
 *  but a reload must reclaim its own id, or the server drops this tab's
 *  queued-draft attribution and pending-UI replays. */
let clientId =
  getClientId() ??
  (() => {
    const id = crypto.randomUUID();
    setClientId(id);
    return id;
  })();

/**
 * Duplicating a tab copies sessionStorage, and with it this tab's id. Announce
 * the id to the other tabs; a tab that already holds it answers, and the
 * newcomer takes a fresh id. Both tabs announce and answer, so two tabs that
 * start together both move to fresh ids, which is harmless.
 */
function guardDuplicateTabId(onRenamed: () => void): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('pimote-client-id');
  // Node (tests, SSR) keeps the process alive for an open channel.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent<{ type: 'hello' | 'taken'; id: string }>) => {
    const msg = event.data;
    if (msg?.id !== clientId) return;
    if (msg.type === 'hello') {
      channel.postMessage({ type: 'taken', id: clientId });
      return;
    }
    clientId = crypto.randomUUID();
    setClientId(clientId);
    onRenamed();
  };
  channel.postMessage({ type: 'hello', id: clientId });
}

export class ConnectionStore {
  get clientId(): string {
    return clientId;
  }
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = $state('disconnected');
  /** True only after WebSocket is open AND all session reconnects have completed. */
  ready: boolean = $state(false);
  /** Canonical manager persona path supplied by ordinary folder responses. */
  managerRoot: string | null = $state(null);
  /** Detailed reconnection phase for status display. */
  phase: 'idle' | 'backoff' | 'connecting' | 'syncing' | 'ready' = $state('idle');
  /** Seconds until next reconnect attempt (ticks down during backoff). */
  reconnectCountdown: number = $state(0);
  /** Progress of per-session restore/open commands during syncing phase. */
  syncProgress: { done: number; total: number } | null = $state(null);
  /** Human-readable restore detail for reconnect sync. */
  syncDetail: string | null = $state(null);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive internal bookkeeping; no template reads it
  private sessionCursors: Map<string, number> = new Map();
  subscribedSessions: Map<string, string> = $state(new SvelteMap());

  /** Last root replay cursor observed for a session. */
  getRootCursor(sessionId: string): number | undefined {
    return this.sessionCursors.get(sessionId);
  }

  private ws: WebSocket | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight request registry, not reactive UI state
  private pending = new Map<string, { resolve: (r: PimoteResponse) => void; reject: (e: Error) => void }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight snapshot assembly, not reactive UI state
  private pendingFullResync = new Map<string, PendingFullResync>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- event-listener set, not reactive UI state
  private listeners = new Set<EventListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  /** Set once the first user_sessions_changed of this socket has driven the
   *  restore dispatch; reset per connect(). Later events mid-connection
   *  apply their plan without the syncing/ready bookkeeping. */
  private restoreDispatched = false;

  /** Called after all session restore/open commands complete. Set by session-registry to restore viewed session. */
  onReconnected: (() => void) | null = null;

  /** Called when a per-session restore/open command succeeds. Set by
   *  session-registry to rebind the session's folder row — restores emit no
   *  session_opened event, so the open_session response is the only wire
   *  moment carrying the folder facts (nature, shortcutCount). */
  onSessionRestored: ((sessionId: string, data: OpenSessionResponseData) => void) | null = null;

  /** Called when restoring/opening a session is rejected with session_not_found
   *  (the session is gone server-side: never persisted and pruned). The
   *  registry drops the orphan session in response. */
  onSessionNotFound: ((sessionId: string) => void) | null = null;

  /** Called when an archived session rejects a restore or is archived live. */
  onSessionArchived: ((sessionId: string) => void) | null = null;

  /** Called when a reconnect restore fails without a definitive server reason. */
  onSessionRestoreFailed: ((sessionId: string) => void) | null = null;

  /** Called when a user_sessions_changed reconcile drops a session this
   *  connection held but the user's profile does not. */
  onSessionDropped: ((sessionId: string) => void) | null = null;

  /** Called after connection restore when a notification-driven adopt should begin. */
  onPendingAdopt: ((sessionId: string, folderPath: string, options: { openDownloads?: boolean }) => void) | null = null;

  /** Called for every `user_sessions_changed`, after its reconcile plan ran,
   *  with the user's chip order and selection (D4). */
  onUserSessionFacts: ((facts: UserSessionFacts) => void) | null = null;
  /** The user's open child views, in server-profile order. */
  onUserViews: ((views: UserOpenViewRef[]) => void) | null = null;

  /** Disconnect listeners — a set, not a slot, so the next consumer can't
   *  silently assign over an existing listener. Fires on close and on socket
   *  replacement. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- listener set, not reactive UI state
  private disconnectListeners = new Set<() => void>();

  /** Subscribe to WebSocket close/replacement; returns unsubscribe. */
  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  private notifyDisconnected(): void {
    this.pendingFullResync.clear();
    for (const cb of [...this.disconnectListeners]) {
      try {
        cb();
      } catch (e) {
        console.error('[ConnectionStore] Disconnect listener error:', e);
      }
    }
  }

  /** Deliver a local event through the same seam as server events. */
  private emitEvent(event: PimoteEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[ConnectionStore] Event listener error:', e);
      }
    }
  }

  /** Session to adopt after next successful connection (set from notification URL param or click). */
  pendingAdopt: PendingSessionAdopt | null = null;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // Starting a fresh connection. Any existing socket here is CLOSING/CLOSED
    // (OPEN/CONNECTING bailed above). Abandon it deterministically:
    //  - detach its listeners so a late `onclose` can't null `this.ws` (the new
    //    socket) or reject the new connection's pending requests;
    //  - reject its still-pending requests *here* rather than relying on the
    //    racing stale `onclose` (send() has no timeout, so they'd otherwise hang);
    //  - clear any prior intentional-close intent (we now intend to be connected).
    // Each handler/continuation below also guards on its own socket identity
    // (`this.ws !== ws`), which additionally covers a plain drop-into-backoff
    // where no replacement socket exists yet.
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    this.rejectAllPending('WebSocket replaced');
    // The replaced socket is closing or already closed; dependent stores reset
    // before the replacement connects.
    this.notifyDisconnected();
    this.intentionalClose = false;

    this.installLifecycleListeners();
    this.ready = false;
    this.clearCountdownInterval();
    this.phase = 'connecting';
    this.status = this.status === 'disconnected' ? 'connecting' : 'reconnecting';
    this.syncDetail = null;
    this.restoreDispatched = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const user = getUser();
    const userParam = user !== null ? `&user=${encodeURIComponent(user)}` : '';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws?clientId=${clientId}&version=${encodeURIComponent(version)}${userParam}`);
    // Identity of THIS socket. Handlers and the async restore continuation
    // capture it and no-op once `this.ws` points elsewhere (replaced) or is
    // null (dropped into backoff).
    const ws = this.ws;

    this.ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = 'connected';
      this.reconnectDelay = 1000;
      // Restore dispatch waits for the connect burst's user_sessions_changed:
      // the server's per-user profile owns the open-session set, so the
      // reconcile must shape the subscription set before any restore goes
      // out. See the user_sessions_changed branch in onmessage.
    };

    this.ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: PimoteServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      // Version mismatch — server is serving newer assets than what we're running.
      // Reload the page to pick up the new client code.
      if ('type' in msg && msg.type === 'version_mismatch') {
        console.log(`[ConnectionStore] Version mismatch — reloading (server=${(msg as { serverVersion: string }).serverVersion}, client=${version})`);
        location.reload();
        return;
      }

      if ('type' in msg && msg.type === 'update_available') {
        updateStore.handleEvent(msg);
        return;
      }

      // Response (has `id` and `success` fields)
      if ('id' in msg && 'success' in msg) {
        const response = msg as PimoteResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          pending.resolve(response);
        }
        return;
      }

      // Event
      this.handleWireEvent(msg as PimoteEvent, ws);
    };

    this.ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.rejectAllPending('WebSocket closed');
      // Dependent stores reset before any reconnect bookkeeping runs.
      this.notifyDisconnected();

      if (!this.intentionalClose) {
        this.status = 'reconnecting';
        this.scheduleReconnect();
      } else {
        this.status = 'disconnected';
        this.phase = 'idle';
        this.syncDetail = null;
        this.intentionalClose = false;
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  /** Reconcile the subscription set against the user's profile snapshot and
   *  apply the plan. The first event of a connection dispatches the restore
   *  loop over the reconciled set; later events mid-connection open missing
   *  entries directly (their `fresh` is always false, so drops are
   *  unconditional). */
  private handleWireEvent(event: PimoteEvent, ws: WebSocket): void {
    if (event.type === 'event_batch') {
      for (const batched of event.events) this.handleWireEvent(batched, ws);
      return;
    }
    if (event.type === 'subagent_view_event') {
      if (this.collectFullResync(event.event, event)) return;
    } else if (this.collectFullResync(event)) return;
    this.recordRootCursor(event);

    if (event.type === 'user_sessions_changed') {
      this.handleUserSessionsChanged(event as UserSessionsChangedEvent, ws);
      return;
    }
    if (event.type === 'session_archived' && event.archived) {
      this.removeSubscribedSession(event.sessionId);
      this.onSessionArchived?.(event.sessionId);
    }
    this.emitEvent(event);
  }

  private collectFullResync(event: PimoteEvent, view?: SubagentViewEvent): boolean {
    switch (event.type) {
      case 'full_resync_start':
        this.beginFullResync(event, view);
        return true;
      case 'full_resync_chunk':
        this.appendFullResyncChunk(event);
        return true;
      case 'full_resync_branch_chunk':
        this.appendFullResyncBranchChunk(event);
        return true;
      case 'full_resync_json_chunk':
        this.appendFullResyncJsonChunk(event);
        return true;
      case 'full_resync_data_chunk':
        this.appendFullResyncDataChunk(event);
        return true;
      default:
        return false;
    }
  }

  private recordRootCursor(event: PimoteEvent): void {
    if (event.type === 'subagent_view_snapshot' || event.type === 'subagent_view_event' || event.type === 'subagent_view_closed') return;
    if (event.type === 'buffered_events') {
      const highest = event.events.reduce(
        (cursor, item) => ('cursor' in item && typeof item.cursor === 'number' ? Math.max(cursor, item.cursor) : cursor),
        this.sessionCursors.get(event.sessionId) ?? 0,
      );
      this.sessionCursors.set(event.sessionId, highest);
    } else if ('cursor' in event && typeof event.cursor === 'number' && 'sessionId' in event) {
      this.sessionCursors.set(event.sessionId, event.cursor);
    }
  }

  private beginFullResync(start: FullResyncStartEvent, view?: SubagentViewEvent): void {
    if (!Number.isSafeInteger(start.totalMessages) || start.totalMessages < 0) return;
    if (start.totalBranchEntryIds !== undefined && (!Number.isSafeInteger(start.totalBranchEntryIds) || start.totalBranchEntryIds < 0)) return;
    const pending: PendingFullResync = {
      start,
      ...(view ? { view } : {}),
      messages: [],
      branchEntryIds: [],
      activeSubagentContent: [],
      runningToolCallIds: [],
      messageMode: null,
      messageStreamComplete: start.totalMessages === 0,
      jsonOffset: 0,
      jsonParser: null,
      messageParseFailed: false,
      streamingMessage: start.streamingMessage ?? null,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- per-snapshot parse state, not read by UI
      jsonFields: new Map([
        ...(start.hasStreamingMessage && start.streamingMessage === undefined ? [['streamingMessage', { offset: 0, parser: null, complete: false, failed: false }] as const] : []),
        ...(start.hasActiveSubagentContent && start.activeSubagentContent === undefined
          ? [['activeSubagentContent', { offset: 0, parser: null, complete: false, failed: false }] as const]
          : []),
        ...(start.hasRunningToolCallIds && start.runningToolCallIds === undefined
          ? [['runningToolCallIds', { offset: 0, parser: null, complete: false, failed: false }] as const]
          : []),
      ]),
    };
    this.pendingFullResync.set(start.sessionId, pending);
    if (this.fullResyncComplete(pending)) this.finishFullResync(pending);
  }

  private appendFullResyncChunk(chunk: FullResyncChunkEvent): void {
    const pending = this.pendingFullResync.get(chunk.sessionId);
    if (!pending || pending.start.snapshotId !== chunk.snapshotId) return;
    if (pending.messageMode === 'json' || chunk.offset !== pending.messages.length || !Array.isArray(chunk.messages)) {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    pending.messageMode = 'array';
    if (pending.messages.length + chunk.messages.length > pending.start.totalMessages) {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    pending.messages.push(...chunk.messages);
    pending.messageStreamComplete = pending.messages.length === pending.start.totalMessages;
    if (this.fullResyncComplete(pending)) this.finishFullResync(pending);
  }

  private appendFullResyncJsonChunk(chunk: FullResyncJsonChunkEvent): void {
    const pending = this.pendingFullResync.get(chunk.sessionId);
    if (!pending || pending.start.snapshotId !== chunk.snapshotId) return;
    if (pending.messageMode === 'array' || chunk.offset !== pending.jsonOffset || typeof chunk.data !== 'string') {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    pending.messageMode = 'json';
    const parser = (pending.jsonParser ??= new JSONParser({ paths: ['$.*'], keepStack: false }));
    parser.onValue = (info) => {
      if (info.value && typeof info.value === 'object' && !Array.isArray(info.value)) pending.messages.push(info.value as PimoteAgentMessage);
    };
    parser.onError = () => {
      pending.messageParseFailed = true;
    };
    try {
      parser.write(chunk.data);
    } catch {
      pending.messageParseFailed = true;
    }
    if (pending.messageParseFailed || pending.messages.length > pending.start.totalMessages) {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    pending.jsonOffset += chunk.data.length;
    if (chunk.final) {
      if (pending.messages.length !== pending.start.totalMessages) {
        this.pendingFullResync.delete(chunk.sessionId);
        return;
      }
      pending.messageStreamComplete = true;
    }
    if (this.fullResyncComplete(pending)) this.finishFullResync(pending);
  }

  private appendFullResyncDataChunk(chunk: FullResyncDataChunkEvent): void {
    const pending = this.pendingFullResync.get(chunk.sessionId);
    if (!pending || pending.start.snapshotId !== chunk.snapshotId) return;
    const field = pending.jsonFields.get(chunk.field);
    if (!field || field.complete || chunk.offset !== field.offset || typeof chunk.data !== 'string') {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    const paths = chunk.field === 'streamingMessage' ? ['$'] : ['$.*'];
    const parser = (field.parser ??= new JSONParser({ paths, keepStack: false }));
    parser.onValue = (info) => {
      if (chunk.field === 'streamingMessage') {
        if (!info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return;
        const message = info.value as { role?: unknown; content?: unknown };
        if (typeof message.role === 'string' && Array.isArray(message.content)) pending.streamingMessage = info.value as unknown as StreamingMessage;
      } else if (chunk.field === 'activeSubagentContent') {
        if (info.value && typeof info.value === 'object' && !Array.isArray(info.value)) pending.activeSubagentContent.push(info.value as PimoteActiveSubagentContent);
      } else if (typeof info.value === 'string') {
        pending.runningToolCallIds.push(info.value);
      }
    };
    parser.onError = () => {
      field.failed = true;
    };
    try {
      parser.write(chunk.data);
    } catch {
      field.failed = true;
    }
    if (field.failed) {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    field.offset += chunk.data.length;
    if (chunk.final) {
      if (chunk.field === 'streamingMessage' && !pending.streamingMessage) {
        this.pendingFullResync.delete(chunk.sessionId);
        return;
      }
      field.complete = true;
    }
    if (this.fullResyncComplete(pending)) this.finishFullResync(pending);
  }

  private appendFullResyncBranchChunk(chunk: FullResyncBranchChunkEvent): void {
    const pending = this.pendingFullResync.get(chunk.sessionId);
    if (!pending || pending.start.snapshotId !== chunk.snapshotId || pending.start.totalBranchEntryIds === undefined) return;
    if (chunk.offset !== pending.branchEntryIds.length || !Array.isArray(chunk.ids) || pending.branchEntryIds.length + chunk.ids.length > pending.start.totalBranchEntryIds) {
      this.pendingFullResync.delete(chunk.sessionId);
      return;
    }
    pending.branchEntryIds.push(...chunk.ids);
    if (this.fullResyncComplete(pending)) this.finishFullResync(pending);
  }

  private fullResyncComplete(pending: PendingFullResync): boolean {
    const branchCount = pending.start.totalBranchEntryIds;
    return (
      pending.messageStreamComplete &&
      [...pending.jsonFields.values()].every((field) => field.complete) &&
      (branchCount === undefined || pending.branchEntryIds.length === branchCount)
    );
  }

  private finishFullResync(pending: PendingFullResync): void {
    const { start, messages } = pending;
    if (this.pendingFullResync.get(start.sessionId) === pending) this.pendingFullResync.delete(start.sessionId);
    const event: FullResyncEvent = {
      type: 'full_resync',
      sessionId: start.sessionId,
      ...(start.cursor !== undefined ? { cursor: start.cursor } : {}),
      ...(start.pendingSteeringMessages !== undefined ? { pendingSteeringMessages: start.pendingSteeringMessages } : {}),
      state: start.state,
      messages,
      ...(start.activeSubagentContent !== undefined
        ? { activeSubagentContent: start.activeSubagentContent }
        : start.hasActiveSubagentContent
          ? { activeSubagentContent: pending.activeSubagentContent }
          : {}),
      ...(start.branchEntryIds !== undefined
        ? { branchEntryIds: start.branchEntryIds }
        : start.totalBranchEntryIds !== undefined
          ? { branchEntryIds: pending.branchEntryIds }
          : {}),
      ...(start.streamingMessage !== undefined ? { streamingMessage: start.streamingMessage } : pending.streamingMessage ? { streamingMessage: pending.streamingMessage } : {}),
      ...(start.runningToolCallIds !== undefined
        ? { runningToolCallIds: start.runningToolCallIds }
        : start.hasRunningToolCallIds
          ? { runningToolCallIds: pending.runningToolCallIds }
          : {}),
    };
    const view = pending.view;
    const { cursor: _cursor, ...payload } = event;
    const snapshot: PimoteEvent = view
      ? {
          ...payload,
          type: 'subagent_view_snapshot',
          sessionId: view.sessionId,
          childSessionId: view.childSessionId,
          path: view.path,
          incarnation: view.incarnation,
          viewCursor: view.viewCursor,
        }
      : event;
    this.recordRootCursor(snapshot);
    this.emitEvent(snapshot);
  }

  private handleUserSessionsChanged(event: UserSessionsChangedEvent, ws: WebSocket): void {
    if (this.ws !== ws) return;
    if (!localMirrorCleared) {
      localMirrorCleared = true;
      clearActiveSessions();
    }
    const current = [...this.subscribedSessions].map(([sessionId, folderPath]) => ({ sessionId, folderPath }));
    this.applyReconcilePlan(reconcileUserSessions(current, event.sessions, event.fresh), ws);
    // Facts apply after the plan so every adopted session has a registry entry
    // to navigate to. A server that predates the reorder carries none.
    this.onUserSessionFacts?.({
      order: Array.isArray(event.order) ? event.order : [],
      selectedSessionId: event.selectedSessionId ?? null,
      orderVersion: typeof event.orderVersion === 'number' ? event.orderVersion : 0,
    });
    this.onUserViews?.(Array.isArray(event.views) ? (event.views as UserOpenViewRef[]) : []);
  }

  /** Registry entry creation for sessions adopted from the user's profile.
   *  The server replays session state (full_resync) BEFORE the open_session
   *  response, and the registry drops events for sessions it does not track
   *  — so the entry must exist when the replay arrives or it is discarded
   *  and the session renders empty forever. In-page opens materialize the
   *  entry through openExistingSession before the send; the reconcile paths
   *  (connect burst and mid-connection adoption) need this callback. */
  onReconcileAdopt: ((sessionId: string, folderPath: string) => void) | null = null;

  private applyReconcilePlan(plan: ReconcilePlan, ws: WebSocket): void {
    for (const sessionId of plan.toDrop) {
      this.removeSubscribedSession(sessionId);
      this.onSessionDropped?.(sessionId);
    }
    if (!this.restoreDispatched) {
      for (const { sessionId, folderPath } of plan.toOpen) {
        if (!this.subscribedSessions.has(sessionId)) this.addSubscribedSession(sessionId, folderPath);
        this.onReconcileAdopt?.(sessionId, folderPath);
      }
      this.restoreDispatched = true;
      this.dispatchRestores(ws);
      return;
    }
    for (const { sessionId, folderPath } of plan.toOpen) {
      this.addSubscribedSession(sessionId, folderPath);
      this.onReconcileAdopt?.(sessionId, folderPath);
      void this.restoreSession(sessionId, folderPath, ws);
    }
  }

  /** Re-attach every subscribed session. Runs once per socket, after the
   *  first user_sessions_changed has reconciled the set. With an in-page
   *  cursor a restore asks for incremental replay; otherwise the server
   *  falls back to a full resync (live in-memory or disk-backed). */
  private dispatchRestores(ws: WebSocket): void {
    const sessionCount = this.subscribedSessions.size;
    if (sessionCount > 0) {
      this.phase = 'syncing';
      this.syncProgress = { done: 0, total: sessionCount };
      this.syncDetail = 'Restoring sessions';
    }
    const restorePromises: Promise<void>[] = [];
    for (const [sessionId, folderPath] of [...this.subscribedSessions]) {
      restorePromises.push(this.restoreSession(sessionId, folderPath, ws));
    }

    // After all restores, restore correct viewed session on the server.
    // Import is circular so we use the onReconnected callback instead.
    Promise.all(restorePromises).then(() => {
      // Bail if this socket was superseded while restores were in flight
      // (dropped mid-sync) — otherwise we'd flip the store to ready/'ready'
      // and fire onReconnected() while actually disconnected and backing off.
      if (this.ws !== ws) return;
      this.ready = true;
      this.phase = 'ready';
      this.syncProgress = null;
      this.syncDetail = null;
      this.onReconnected?.();

      if (this.pendingAdopt) {
        const { sessionId: sid, folderPath, openDownloads } = this.pendingAdopt;
        this.pendingAdopt = null;
        this.onPendingAdopt?.(sid, folderPath, { openDownloads });
      }
    });
  }

  /** Open one session with the reconnect-restore error handling. */
  private restoreSession(sessionId: string, folderPath: string, ws: WebSocket): Promise<void> {
    const lastCursor = this.sessionCursors.get(sessionId);
    return this.send({
      type: 'open_session',
      folderPath,
      sessionId,
      ...(lastCursor !== undefined ? { lastCursor } : {}),
    })
      .then((response) => {
        // A response can already be queued when this socket drops. Never
        // let that stale continuation mutate the current connection state.
        if (this.ws !== ws) return;
        if (!response.success) {
          if (response.error === 'session_archived') {
            if (this.phase === 'syncing') {
              this.syncDetail = 'Session archived';
            }
            this.removeSubscribedSession(sessionId);
            this.onSessionArchived?.(sessionId);
          } else if (isSessionNotFoundError(response.error)) {
            // Definitive rejection: the session is gone server-side (for
            // example never persisted before an idle reap). Tell the user,
            // drop the subscription, and let the registry delete the orphan.
            if (this.phase === 'syncing') {
              this.syncDetail = 'Session not found';
            }
            this.removeSubscribedSession(sessionId);
            this.onSessionNotFound?.(sessionId);
          } else {
            // A restore can fail after the server attached this socket, or
            // before attachment during resync. No detach is sent: cleanup
            // rests on the server's same-id takeover eviction (DR-067), and
            // detach_session would unlink the user everywhere.
            const error = response.error ?? 'unknown error';
            console.warn(`[ConnectionStore] Failed to restore session ${sessionId}: ${error}`);
            if (this.phase === 'syncing') {
              this.syncDetail = 'Session restore failed';
            }
            this.removeSubscribedSession(sessionId);
            this.onSessionRestoreFailed?.(sessionId);
            this.emitEvent({
              type: 'extension_ui_request',
              sessionId,
              requestId: `session-restore-failed-${sessionId}-${Date.now()}`,
              method: 'notify',
              message: 'Session restore failed',
              notifyType: 'error',
            });
          }
          return;
        }

        const data = response.data as OpenSessionResponseData | undefined;
        if (this.phase === 'syncing') {
          this.syncDetail = this.labelForRestoreMode(data?.restoreMode, this.syncProgress?.total ?? 1);
        }
        if (data) this.onSessionRestored?.(sessionId, data);
      })
      .catch(() => {
        // WebSocket dropped before response — will retry on next reconnect
      })
      .finally(() => {
        if (this.syncProgress) {
          this.syncProgress = { done: this.syncProgress.done + 1, total: this.syncProgress.total };
        }
      });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearCountdownInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  /**
   * Cancel any pending backoff and attempt to reconnect immediately.
   * Called when the app regains focus / visibility / network — the user is
   * waiting and the old backoff delay is no longer meaningful.
   */
  reconnectNow(): void {
    // Only act when we're sitting in backoff. If a connect attempt is already
    // in flight (or we're already connected), let it run.
    if (this.phase !== 'backoff') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearCountdownInterval();
    this.reconnectCountdown = 0;
    this.reconnectDelay = 1000;
    this.connect();
  }

  private lifecycleListenersInstalled = false;
  private installLifecycleListeners(): void {
    if (this.lifecycleListenersInstalled) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.lifecycleListenersInstalled = true;
    const trigger = () => this.reconnectNow();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') trigger();
    });
    window.addEventListener('focus', trigger);
    window.addEventListener('online', trigger);
    window.addEventListener('pageshow', trigger);
  }

  addSubscribedSession(id: string, folderPath: string): void {
    this.subscribedSessions.set(id, folderPath);
  }

  removeSubscribedSession(id: string): void {
    this.subscribedSessions.delete(id);
    this.sessionCursors.delete(id);
  }

  /** Empty the seed the connect-burst reconcile consumes. A deliberate user
   *  switch starts the chosen profile's list on this device: a fresh profile
   *  then stays empty and a known profile's set replaces the view. Local-only
   *  — each dropped entry notifies the registry through `onSessionDropped`
   *  and nothing goes over the wire, so the old profile keeps its entries. */
  clearSubscribedSessions(): void {
    for (const sessionId of [...this.subscribedSessions.keys()]) {
      this.removeSubscribedSession(sessionId);
      this.onSessionDropped?.(sessionId);
    }
  }

  send(command: PimoteCommand): Promise<PimoteResponse> {
    const id = command.id ?? `cmd-${nextId++}`;
    const withId = { ...command, id };

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(withId));
    });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private clearCountdownInterval(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /** Reject and clear every in-flight request. Single home for pending
   *  teardown so connect()-time replacement and onclose stay in sync. */
  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.phase = 'backoff';
    this.syncDetail = null;
    this.reconnectCountdown = Math.ceil(this.reconnectDelay / 1000);
    this.clearCountdownInterval();
    this.countdownInterval = setInterval(() => {
      this.reconnectCountdown = Math.max(0, this.reconnectCountdown - 1);
    }, 1000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Jitter spreads reconnect storms across clients: after a server
      // restart every tab doubles from the same delay, and a deterministic
      // schedule would sync their restore fan-outs.
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 2 * (0.5 + Math.random())), 30000);

      // Before reconnecting, check if the auth session is still valid.
      // When a reverse proxy (e.g. Cloudflare Access) expires the session,
      // WebSocket upgrades fail silently (code 1006) with no way to distinguish
      // from a network error. A fetch to our own origin will surface the redirect.
      try {
        const resp = await fetch(location.href, { method: 'HEAD', redirect: 'manual' });
        if (resp.type === 'opaqueredirect' || resp.status === 401 || resp.status === 403) {
          location.reload();
          return;
        }
      } catch {
        // Network error — proceed with WebSocket reconnect attempt
      }

      this.connect();
    }, this.reconnectDelay);
  }

  get phaseLabel(): string {
    if (this.phase === 'ready') return 'Connected';
    if (this.phase === 'syncing') {
      return this.syncProgress ? `Syncing ${this.syncProgress.done}/${this.syncProgress.total}…` : 'Syncing…';
    }
    if (this.phase === 'connecting') {
      return this.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
    }
    if (this.phase === 'backoff') {
      return `Reconnecting in ${this.reconnectCountdown}s`;
    }
    return 'Disconnected';
  }

  private labelForRestoreMode(mode: RestoreMode | undefined, sessionCount: number): string {
    if (sessionCount > 1) {
      switch (mode) {
        case 'incremental_replay':
          return 'Replaying sessions from offset';
        case 'full_resync_cursor_stale':
          return 'Full resync (offset too old)';
        case 'disk_full_resync':
          return 'Reopening sessions from disk';
        case 'full_resync_no_cursor':
        default:
          return 'Full resync';
      }
    }

    switch (mode) {
      case 'incremental_replay':
        return 'Replaying from offset';
      case 'full_resync_cursor_stale':
        return 'Full resync (offset too old)';
      case 'disk_full_resync':
        return 'Reopening from disk';
      case 'full_resync_no_cursor':
      default:
        return 'Full resync';
    }
  }
}

export const connection = new ConnectionStore();

// A renamed tab reconnects under its fresh id. If its first socket already
// evicted the original tab, that tab reconnects once and keeps its id.
guardDuplicateTabId(() => {
  if (connection.status !== 'disconnected') connection.connect();
});

// Wire the voice trace helper so client-side voice logs ship to the server.
import { configureVoiceTrace } from './voice-trace.js';
configureVoiceTrace((cmd) => connection.send(cmd));
