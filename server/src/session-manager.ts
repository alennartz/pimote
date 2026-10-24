import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  createEventBus,
  ModelRuntime,
  getAgentDir,
  SessionManager as PiSessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionRuntime, EventBusController, CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import { EventBuffer } from './event-buffer.js';
import { QUEUE_KINDS, QueueOwnership, type QueueTexts } from './queue-ownership.js';
import { extractMessageEntryIds, rendererRegisteredVisibility } from './message-mapper.js';
import type { PimoteEvent, Card, DownloadItem, DownloadSnapshotUpdateEvent, DownloadUpdateEvent, SessionSettingsChangedEvent } from '../../shared/dist/index.js';
import type { PushNotificationPayload, PushNotificationService } from './push-notification.js';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import type { PanelMessage } from './panel-state.js';
import { askActivity } from '@pimote/sdk/activity';
import { getGitBranch } from './git-branch.js';
import { LoginOrchestrator } from './login-orchestrator.js';
import { createVoiceExtension } from './voice/index.js';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { loadManagerExtension } from './manager/attachment.js';

/** Narrow interface for the WebSocket used for event routing.
 *  Avoids importing the `ws` package type in session-manager. */
export interface EventSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  readonly readyState: number;
}

export interface SessionManagerOptions {
  staticHostFactory?: ExtensionFactory;
  fileDownloadFactory?: ExtensionFactory;
  /** Injects the `pimote-docs` system-prompt section into every session. */
  pimoteDocsFactory?: ExtensionFactory;
  /** Included only when canonical session cwd equals canonical managerRoot.
   * Manager sessions use the ordinary persisted session and slot lifecycle. */
  managerExtensionFactory?: ExtensionFactory;
}

export interface PendingUiEntry {
  resolve: (value: unknown) => void;
  /** The original request event, stored so it can be re-sent on reconnect. */
  event: PimoteEvent;
}

/** Outcome of a session reset, passed to an observer's notify callback after
 * the slot state has been rebuilt and any map re-key is complete. */
export type SessionResetOutcome = { kind: 'unchanged' } | { kind: 'rekeyed'; oldId: string; newId: string; folderPath: string };

/** One live client observer of a managed session. The event cursor is the last
 * buffered event delivered to this observer. */
export interface SessionObserver {
  clientId: string;
  ws: EventSocket;
  cursor: number;
  onSessionReset: ((slot: ManagedSlot, outcome: SessionResetOutcome, isFirstObserver?: boolean) => Promise<void>) | null;
}

export interface SessionState {
  id: string;
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  /** Timestamp the session entered the idle state (last `agent_end`), or null while `status === 'working'`.
   *  The reaper uses this to decide eligibility — a streaming session is never reapable.
   *  Client connect/disconnect does NOT reset this clock; idleness is purely an agent-level concept. */
  idleSince: number | null;
  unsubscribe: () => void;
  pendingUiResponses: Map<string, PendingUiEntry>;
  extensionsBound: boolean;
  panelState: Map<string, Card[]>;
  /** Current pending file-download snapshot for this session. */
  downloads: DownloadItem[];
  /** Removes this state's dedicated download EventBus listener during teardown. */
  downloadListenerUnsub?: () => void;
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
  /** True while a tree navigation + optional summarization is in progress. */
  treeNavigationInProgress: boolean;
  /** True from bash admission through extension interception/native execution. */
  bashDispatchInProgress?: boolean;
  /** Set when abort_bash arrives before native execution has been admitted. */
  bashAbortRequested?: boolean;
  /** Which client submitted each message in pi's steering and follow-up queues. */
  queueOwnership: QueueOwnership;
  /** Abort-drained drafts for senders that were offline, delivered on their next claim. */
  undeliveredDrafts?: Map<string, QueueTexts>;
}

export interface ManagedSlot {
  runtime: AgentSessionRuntime;
  folderPath: string;
  eventBusRef: { current: EventBusController | null };
  observers: Map<string, SessionObserver>;
  sessionState: SessionState;
  get session(): AgentSession;
}

// ---- Slot-based helpers (operate on ManagedSlot) ----

/** Send one session event to every live observer. */
export function sendSlotEvent(slot: ManagedSlot, event: PimoteEvent, options?: { exceptClientId?: string }): void {
  for (const observer of slot.observers.values()) {
    if (observer.clientId === options?.exceptClientId) continue;
    if (!observer.ws || observer.ws.readyState !== 1) continue;
    try {
      observer.ws.send(JSON.stringify(event));
      if ('cursor' in event && typeof event.cursor === 'number') observer.cursor = event.cursor;
    } catch {
      // WebSocket send failed — ignore (client disconnecting)
    }
  }
}

/** Dependencies for routing one extension download update to its owning client. */
export interface DownloadEventBus {
  on(type: 'pimote:downloads', listener: (update: unknown) => void | Promise<void>): () => void;
}

export interface RouteSlotDownloadUpdateOptions {
  sessionId: string;
  folderPath: string;
  sessionName?: string;
  state: Pick<SessionState, 'downloads'>;
  send(event: DownloadUpdateEvent): void;
  notify(payload: PushNotificationPayload): Promise<void>;
}

/** True when an untrusted EventBus payload has the public download-item shape. */
function isDownloadItem(value: unknown): value is DownloadItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.filename === 'string' && typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && typeof item.href === 'string';
}

/** True when an untrusted EventBus payload has one of the download-update shapes. */
function isDownloadUpdateEvent(value: unknown): value is DownloadUpdateEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  if (update.type !== 'download_update' || typeof update.sessionId !== 'string' || !Array.isArray(update.downloads) || !update.downloads.every(isDownloadItem)) {
    return false;
  }
  if (update.cause === 'offered') return typeof update.offeredDownloadId === 'string';
  return update.cause === 'restored' || update.cause === 'consumed' || update.cause === 'revoked';
}

/** Subscribe one session state to extension download updates. */
export function setupSlotDownloadListener(eventBus: DownloadEventBus, options: RouteSlotDownloadUpdateOptions): () => void {
  return eventBus.on('pimote:downloads', async (update) => {
    if (!isDownloadUpdateEvent(update) || update.sessionId !== options.sessionId) return;
    await routeSlotDownloadUpdate(update, options);
  });
}

/** Build the silent full snapshot used after reconnect, resync, and view changes. */
export function makeDownloadSnapshot(sessionId: string, downloads: DownloadItem[]): DownloadSnapshotUpdateEvent {
  return { type: 'download_update', sessionId, cause: 'restored', downloads };
}

/**
 * Apply an extension update to session-local state, route it to the current
 * owner, and emit VAPID only for a newly offered item. The implementation
 * validates that the update belongs to this session and resolves
 * `offeredDownloadId` from the full snapshot before notifying.
 */
export async function routeSlotDownloadUpdate(update: DownloadUpdateEvent, options: RouteSlotDownloadUpdateOptions): Promise<void> {
  if (update.sessionId !== options.sessionId) return;

  options.state.downloads = update.downloads;
  options.send(update);

  if (update.cause !== 'offered') return;
  const offered = update.downloads.find((download) => download.id === update.offeredDownloadId);
  if (!offered) return;

  const projectName = options.folderPath.split('/').filter(Boolean).at(-1) ?? 'Unknown';
  try {
    await options.notify({
      projectName,
      folderPath: options.folderPath,
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      reason: 'download',
      download: {
        downloadId: offered.id,
        filename: offered.filename,
        sizeBytes: offered.sizeBytes,
      },
    });
  } catch (error) {
    console.error('[SessionManager] Download push notification error:', error);
  }
}

/** Ask the extension side to re-project its steady panel state (ordinary
 *  `pimote:panels` messages). Emitted when a client (re)claims a session or the
 *  session state is reset: pimote's panel snapshot is in-memory and can be empty
 *  or stale after a restart, and extension repaints are otherwise driven by state
 *  transitions. Fire-and-forget; extensions that don't know the channel ignore it. */
export function requestSlotPanelResync(slot: ManagedSlot, reason: 'claim' | 'reset'): void {
  slot.eventBusRef.current?.emit('pimote:panels:sync', { reason });
}

/** Create a pending promise for a UI dialog response. Stores the request event for replay on reconnect. */
export function waitForSlotUiResponse(slot: ManagedSlot, requestId: string, requestEvent: PimoteEvent): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    slot.sessionState.pendingUiResponses.set(requestId, { resolve, event: requestEvent });
  });
}

/** Resolve a specific pending UI response by requestId. */
export function resolveSlotPendingUi(slot: ManagedSlot, requestId: string, value: unknown): boolean {
  const pending = slot.sessionState.pendingUiResponses.get(requestId);
  if (!pending) return false;
  slot.sessionState.pendingUiResponses.delete(requestId);
  pending.resolve(value);
  return true;
}

/** Resolve all pending UI responses with undefined. Used on abort, session close, or session reset. */
export function resolveAllSlotPendingUi(slot: ManagedSlot): void {
  const requestIds = [...slot.sessionState.pendingUiResponses.keys()];
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    pending.resolve(undefined);
  }
  slot.sessionState.pendingUiResponses.clear();
  for (const requestId of requestIds) {
    sendSlotEvent(slot, { type: 'extension_ui_resolved', sessionId: slot.sessionState.id, requestId });
  }
}

/** Re-send all pending UI request events to the current client. Called on reconnect to recover lost dialogs. */
export function replaySlotPendingUiRequests(slot: ManagedSlot, send: (event: PimoteEvent) => void): void {
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    send(pending.event);
  }
}

// ---- Slot-based session state lifecycle helpers ----

/** Construct a SessionState from an AgentSession and EventBus.
 *  Subscribes to session events and sets up panel listeners. */
/** @internal Exported for lifecycle contract tests. */
export function createSessionState(
  session: AgentSession,
  eventBus: EventBusController,
  config: PimoteConfig,
  callbacks: {
    onStatusChange?: (sessionId: string, folderPath: string) => void;
    onSessionIdle?: (sessionId: string, slot: ManagedSlot) => void;
    sendEvent: (event: PimoteEvent) => void;
    notify: (payload: PushNotificationPayload) => Promise<void>;
  },
  slotRef: { slot: ManagedSlot | null },
  folderPath: string,
): SessionState {
  const sessionId = session.sessionId;
  // Wall-clock base: a recreated slot's cursors sit above every cursor its
  // predecessor handed out (at most 1000 events per millisecond of lifetime),
  // so a client's stale cursor replays as stale instead of as caught up.
  const visibility = rendererRegisteredVisibility(session);
  const eventBuffer = new EventBuffer(config.bufferSize, visibility, Date.now() * 1000, () => extractMessageEntryIds(session.sessionManager.getBranch(), visibility));

  const state: SessionState = {
    id: sessionId,
    eventBuffer,
    status: session.isStreaming ? 'working' : 'idle',
    needsAttention: false,
    idleSince: session.isStreaming ? null : Date.now(),
    unsubscribe: () => {},
    pendingUiResponses: new Map(),
    extensionsBound: false,
    panelState: new Map(),
    downloads: [],
    downloadListenerUnsub: undefined,
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
    bashDispatchInProgress: false,
    bashAbortRequested: false,
    queueOwnership: new QueueOwnership(),
  };

  // Subscribe to session events
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'queue_update') {
      for (const kind of QUEUE_KINDS) state.queueOwnership.syncFromPi(kind, event[kind]);
    }
    if (event.type === 'agent_start' && state.status !== 'working') {
      state.status = 'working';
      state.idleSince = null;
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'session_info_changed') {
      // Session names are part of the sidebar/session metadata snapshot rather
      // than a streamed conversation event. Broadcast that snapshot immediately
      // so the active title and folder session row both stay current.
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'agent_settled' && state.status !== 'idle') {
      // Authoritative idle boundary: raised only when the session is genuinely
      // quiescent (no active run, retry, auto-compaction, or queued
      // continuation). Driving the completion push + idle-reap clock off this
      // rather than the terminal `agent_end` avoids a premature "done" push /
      // reap when a queued follow-up continues the session after `agent_end`.
      state.status = 'idle';
      state.idleSince = Date.now();
      state.needsAttention = true;
      // Nothing queued can still arrive from an idle session. Drop unconsumed intents.
      state.queueOwnership.clearIntents();
      // A user-aborted run does not warrant a completion push: whoever
      // aborted it is already engaged with the session.
      if (!event.aborted && slotRef.slot) callbacks.onSessionIdle?.(sessionId, slotRef.slot);
      callbacks.onStatusChange?.(sessionId, folderPath);
    }
    eventBuffer.onEvent(
      event,
      sessionId,
      (e) => callbacks.sendEvent(e),
      () => session.messages[session.messages.length - 1],
    );
  });

  state.unsubscribe = unsubscribe;

  // Bind feature EventBus listeners after the state holder exists.
  state.panelListenerUnsubs = setupSlotPanelListeners(eventBus, state, sessionId, callbacks.sendEvent);
  state.panelListenerUnsubs.push(eventBus.on(SETTINGS_CHANGED_CHANNEL, () => callbacks.sendEvent(makeSessionSettingsEvent(sessionId, session))));
  state.downloadListenerUnsub = setupSlotDownloadListener(eventBus, {
    sessionId,
    folderPath,
    sessionName: session.sessionName,
    state,
    send: callbacks.sendEvent,
    notify: callbacks.notify,
  });

  return state;
}

/** Clean up a SessionState: resolve pending UI, clear timers, unsubscribe listeners. */
function teardownSessionState(state: SessionState): void {
  // Resolve all pending UI responses
  for (const [, pending] of state.pendingUiResponses) {
    pending.resolve(undefined);
  }
  state.pendingUiResponses.clear();

  // Clear panel throttle timer
  if (state.panelThrottleTimer) clearTimeout(state.panelThrottleTimer);

  // Remove feature EventBus listeners.
  state.downloadListenerUnsub?.();
  state.downloadListenerUnsub = undefined;
  for (const unsub of state.panelListenerUnsubs) unsub();
  state.panelListenerUnsubs = [];

  // Unsubscribe from session events
  state.unsubscribe();
}

/** EventBus channel on which the settings watcher reports model and thinking-level changes. */
const SETTINGS_CHANGED_CHANNEL = 'pimote:settings-changed';

/** Snapshot of a session's settings, as observers render them. */
export function makeSessionSettingsEvent(sessionId: string, session: AgentSession): SessionSettingsChangedEvent {
  const model = session.model;
  return {
    type: 'session_settings_changed',
    sessionId,
    model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    autoCompactionEnabled: session.autoCompactionEnabled,
  };
}

/**
 * Report model and thinking-level changes from every source (pimote commands,
 * slash commands, extensions, pi's own clamping) on the session EventBus, so
 * every observer renders current settings. pi emits no session event for a
 * model change; only extensions see `model_select`.
 */
export function createSettingsWatchExtension(): ExtensionFactory {
  return (pi) => {
    const report = () => {
      pi.events.emit(SETTINGS_CHANGED_CHANNEL, undefined);
    };
    pi.on('model_select', report);
    pi.on('thinking_level_select', report);
  };
}

/** Register panel detection and data listeners for a SessionState on an EventBus. */
function setupSlotPanelListeners(eventBus: EventBusController, state: SessionState, sessionId: string, sendEvent: (event: PimoteEvent) => void): (() => void)[] {
  const unsub1 = eventBus.on('pimote:detect:request', () => {
    eventBus.emit('pimote:detect:response', { detected: true });
  });
  const unsub2 = eventBus.on('pimote:panels', (data) => {
    applyPanelMessage(state.panelState, data as PanelMessage);
    scheduleSlotPanelPush(state, sessionId, sendEvent);
  });
  const unsub3 = eventBus.on('pimote:navigate', (data) => {
    const url = (data as { url?: unknown } | null | undefined)?.url;
    if (typeof url !== 'string' || url.length === 0) return;
    sendEvent({ type: 'pimote_navigate', sessionId, url });
  });
  return [unsub1, unsub2, unsub3];
}

/** Schedule a throttled panel push (~200ms) for a SessionState. */
function scheduleSlotPanelPush(state: SessionState, sessionId: string, sendEvent: (event: PimoteEvent) => void): void {
  if (state.panelThrottleTimer !== null) return;
  state.panelThrottleTimer = setTimeout(() => {
    state.panelThrottleTimer = null;
    const cards = getMergedPanelCards(state.panelState);
    sendEvent({ type: 'panel_update', sessionId, cards });
  }, 200);
}

/**
 * Coalesce concurrent async operations keyed by `key`: while one is in flight,
 * callers passing the same key share its promise instead of starting a second
 * run. The map entry is cleared once the operation settles, so a later call
 * with the same key runs fresh.
 */
export async function singleFlight<V>(map: Map<string, Promise<V>>, key: string, run: () => Promise<V>): Promise<V> {
  const inflight = map.get(key);
  if (inflight) return inflight;
  const p = run().finally(() => {
    map.delete(key);
  });
  map.set(key, p);
  return p;
}

export class PimoteSessionManager {
  private readonly loginOrchestrator: LoginOrchestrator;
  private readonly sessions = new Map<string, ManagedSlot>();
  /** In-flight `openSession` promises keyed by session file path, so two
   *  concurrent opens of the same on-disk session share one runtime instead
   *  of building (and leaking) a second one over the same file. */
  private readonly inFlightOpens = new Map<string, Promise<string>>();
  /** Lifecycle locks keyed by stable session id. Archive, resume, and open
   *  callers use this seam so metadata and live-slot transitions cannot cross
   *  each other halfway through an operation. */
  private readonly sessionOperationLocks = new Map<string, Promise<unknown>>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private gitBranchCheckHandle: ReturnType<typeof setInterval> | null = null;
  private lastKnownGitBranchBySession = new Map<string, string | null>();

  onStatusChange?: (sessionId: string, folderPath: string) => void;
  onSessionClosed?: (sessionId: string, folderPath: string) => void;
  onGitBranchChange?: (sessionId: string, folderPath: string) => void;
  /** Fired synchronously before a session's state is torn down (e.g. idle
   *  reap, explicit close). Consumers use this to drop external bookkeeping
   *  (e.g. `VoiceOrchestrator.endCall`) while the session is still addressable. */
  onBeforeSessionClose?: (sessionId: string, folderPath: string) => Promise<void> | void;
  /** Fired when a re-key collision evicts the slot currently holding the target
   *  session ID, BEFORE that slot is closed. Consumers notify every observer of
   *  the evicted slot while it is still addressable via getSlot. */
  onSlotEvicted?: (sessionId: string) => void;

  private readonly staticHostFactory?: ExtensionFactory;
  private readonly fileDownloadFactory?: ExtensionFactory;
  private readonly managerExtensionFactory?: ExtensionFactory;
  private readonly pimoteDocsFactory?: ExtensionFactory;

  private constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
    private readonly modelRuntime: ModelRuntime,
    options: SessionManagerOptions = {},
  ) {
    // Login stays server-global and shares the exact runtime every session uses.
    this.loginOrchestrator = new LoginOrchestrator(this.modelRuntime);
    this.staticHostFactory = options.staticHostFactory;
    this.fileDownloadFactory = options.fileDownloadFactory;
    this.managerExtensionFactory = options.managerExtensionFactory;
    this.pimoteDocsFactory = options.pimoteDocsFactory;
  }

  /** Initialize the one process-lifetime Pi model/auth runtime before serving sessions. */
  static async create(config: PimoteConfig, pushNotificationService: PushNotificationService, options: SessionManagerOptions = {}): Promise<PimoteSessionManager> {
    const modelRuntime = await ModelRuntime.create();
    return new PimoteSessionManager(config, pushNotificationService, modelRuntime, options);
  }

  /**
   * Build the voice extension factory for this server's config, if possible.
   * Returns undefined when voice is not configured (no speechmux URLs) or
   * when neither voice-specific model refs nor fallback defaultProvider/
   * defaultModel are configured. Non-voice deployments continue to work
   * unchanged — sessions simply don't load `@pimote/voice` at all.
   */
  private buildVoiceExtensionFactory(getSession: () => AgentSession): ExtensionFactory | undefined {
    if (!this.config.voice?.speechmuxSignalUrl || !this.config.voice?.speechmuxLlmWsUrl) {
      return undefined;
    }
    const interpreter =
      this.config.defaultInterpreterModel ?? (this.config.defaultProvider && this.config.defaultModel ? `${this.config.defaultProvider}/${this.config.defaultModel}` : undefined);
    const worker =
      this.config.defaultWorkerModel ?? (this.config.defaultProvider && this.config.defaultModel ? `${this.config.defaultProvider}/${this.config.defaultModel}` : undefined);
    if (!interpreter || !worker) {
      console.warn('[pimote] voice extension disabled: no defaultInterpreterModel/defaultWorkerModel or fallback defaultProvider/defaultModel in config');
      return undefined;
    }
    return createVoiceExtension({
      defaultInterpreterModel: interpreter,
      defaultWorkerModel: worker,
      getSession,
    });
  }

  /**
   * Open (or reopen) a session, returning its id.
   *
   * For an existing on-disk session (`sessionFilePath` provided), this guards
   * against ever binding a SECOND pi runtime to the same session file: it
   * returns the already-open session's id when it's live in memory, and
   * coalesces concurrent opens of the same file into a single runtime. Without
   * this, a reconnect double-fire or two devices opening the same session race
   * between the (miss) existence check and the eventual `sessions.set`, spawn
   * two runtimes appending to one file (corrupting history), and leak the
   * first. New sessions (no file) create a fresh file each time, so they need
   * no coalescing.
   */
  async openSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    if (!sessionFilePath) {
      return this.doOpenSession(folderPath);
    }
    const alreadyOpenId = this.findSlotIdBySessionFile(sessionFilePath);
    if (alreadyOpenId) return alreadyOpenId;
    return singleFlight(this.inFlightOpens, sessionFilePath, () => this.doOpenSession(folderPath, sessionFilePath));
  }

  /** Serialize metadata and runtime lifecycle changes for one stable session
   *  id. Callers keep lookup, archive checks, opens, and closes inside this
   *  operation so an archive cannot close a slot that a resume just opened. */
  withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationLocks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.finally(() => {
      if (this.sessionOperationLocks.get(sessionId) === settled) this.sessionOperationLocks.delete(sessionId);
    });
    this.sessionOperationLocks.set(sessionId, settled);
    return settled;
  }

  /** Find the id of an open slot bound to the given session file, if any. */
  private findSlotIdBySessionFile(sessionFilePath: string): string | undefined {
    for (const [sid, slot] of this.sessions) {
      if (slot.session.sessionFile === sessionFilePath) return sid;
    }
    return undefined;
  }

  private async doOpenSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    const eventBusRef: { current: EventBusController | null } = { current: null };
    const sharedModelRuntime = this.modelRuntime;
    const sessionManager = sessionFilePath ? PiSessionManager.open(sessionFilePath) : PiSessionManager.create(folderPath);
    const effectiveFolderPath = sessionFilePath ? sessionManager.getCwd() : folderPath;

    const staticHostFactory = this.staticHostFactory;
    const fileDownloadFactory = this.fileDownloadFactory;
    const managerExtensionFactory = this.managerExtensionFactory;
    const pimoteDocsFactory = this.pimoteDocsFactory;

    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      // Services load extension factories before constructing AgentSession.
      // Bind this explicit per-runtime holder before session_start is emitted
      // by bindExtensions; replacement runtimes get a fresh holder/factory.
      const voiceSessionRef: { current: AgentSession | null } = { current: null };
      const voiceExtensionFactory = this.buildVoiceExtensionFactory(() => {
        if (!voiceSessionRef.current) throw new Error('Voice session is not bound yet');
        return voiceSessionRef.current;
      });
      const extensionFactories = [
        ...(voiceExtensionFactory ? [voiceExtensionFactory] : []),
        ...(pimoteDocsFactory ? [pimoteDocsFactory] : []),
        ...(staticHostFactory ? [staticHostFactory] : []),
        ...(fileDownloadFactory ? [fileDownloadFactory] : []),
        ...(managerExtensionFactory && (await loadManagerExtension({ cwd }, this.config)) ? [managerExtensionFactory] : []),
        // SDK sessions skip pi's built-in extensions, so register Pi's
        // codemode, tool-search, and MCP extensions here. Codemode and
        // tool-search stay inactive until settings or MCP exposure activates
        // them; MCP reads Pi's mcp.json configuration at session start.
        createCodemodeExtension(),
        createToolSearchExtension(),
        createMcpExtension(),
        createSettingsWatchExtension(),
      ];
      const eventBus = createEventBus();
      eventBusRef.current = eventBus;

      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: sharedModelRuntime,
        resourceLoaderOptions: {
          eventBus,
          ...(extensionFactories.length ? { extensionFactories } : {}),
        },
      });

      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      voiceSessionRef.current = result.session;
      return {
        ...result,
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(factory, {
      cwd: effectiveFolderPath,
      agentDir: getAgentDir(),
      sessionManager,
    });

    const session = runtime.session;
    const sessionId = session.sessionId;

    // Diagnostics: log model runtime state after factory has loaded extensions
    const availableModels = await this.modelRuntime.getAvailable();
    console.log(`[pimote] openSession: ${availableModels.length} models available, session model: ${session.model ? `${session.model.provider}/${session.model.id}` : 'none'}`);

    // Apply default model from config (only for new sessions without an existing model preference)
    if (!sessionFilePath && this.config.defaultProvider && this.config.defaultModel) {
      const models = await this.modelRuntime.getAvailable();
      const defaultModel = models.find((m) => m.provider === this.config.defaultProvider && m.id === this.config.defaultModel);
      if (defaultModel) {
        await session.setModel(defaultModel);
        console.log(`[pimote] Set default model: ${defaultModel.provider}/${defaultModel.id}`);
      } else {
        console.warn(`[pimote] Default model not found: ${this.config.defaultProvider}/${this.config.defaultModel}`);
      }
    }

    // Apply default thinking level from config
    if (!sessionFilePath && this.config.defaultThinkingLevel) {
      session.setThinkingLevel(this.config.defaultThinkingLevel as AgentSession['thinkingLevel']);
      console.log(`[pimote] Set default thinking level: ${this.config.defaultThinkingLevel}`);
    }

    // Pimote convention: drain the entire steering / follow-up queue into a
    // single consolidated run rather than one message per run. Matches the
    // UX expectation that queued messages are delivered together when the
    // agent next processes, not metered out across multiple turns.
    session.setSteeringMode('all');
    session.setFollowUpMode('all');

    // Create the slot object. Use a slotRef so createSessionState callbacks can reference the slot.
    const slotRef: { slot: ManagedSlot | null } = { slot: null };

    const sessionState = createSessionState(
      session,
      eventBusRef.current!,
      this.config,
      {
        onStatusChange: (sid, fp) => this.onStatusChange?.(sid, fp),
        onSessionIdle: (sid, s) => this.handleSessionIdle(sid, s),
        sendEvent: (e) => sendSlotEvent(slot, e),
        notify: (payload) => this.pushNotificationService.notify(payload),
      },
      slotRef,
      effectiveFolderPath,
    );

    const slot: ManagedSlot = {
      runtime,
      folderPath: effectiveFolderPath,
      eventBusRef,
      observers: new Map(),
      sessionState,
      get session() {
        return this.runtime.session;
      },
    };
    slotRef.slot = slot;

    this.sessions.set(sessionId, slot);
    try {
      this.lastKnownGitBranchBySession.set(sessionId, await getGitBranch(effectiveFolderPath));
      return sessionId;
    } catch (error) {
      try {
        await this.closeSession(sessionId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Session opening and cleanup failed', { cause: cleanupError });
      }
      throw error;
    }
  }

  private handleSessionIdle(sessionId: string, slot: ManagedSlot): void {
    const folderPath = slot.folderPath;
    const projectName = folderPath.split('/').pop() ?? 'Unknown';
    const firstMessage = this.extractFirstMessage(slot);
    const lastAgentMessage = this.extractLastAgentMessage(slot);
    this.pushNotificationService
      .notify({
        projectName,
        folderPath,
        sessionId,
        sessionName: slot.session.sessionName,
        firstMessage,
        reason: 'idle',
        lastAgentMessage,
      })
      .catch((err) => console.error('[SessionManager] Push notification error:', err));
  }

  private extractLastAgentMessage(slot: ManagedSlot): string | undefined {
    const messages = slot.session.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const text = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) return text.slice(0, 200);
      break;
    }
    return undefined;
  }

  private extractFirstMessage(slot: ManagedSlot): string | undefined {
    const messages = slot.session.messages ?? [];
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const { content } = msg;
      if (typeof content === 'string') return content.slice(0, 100);
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') return c.text.slice(0, 100);
        }
      }
      break;
    }
    return undefined;
  }

  async closeSession(sessionId: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) return;

    if (this.onBeforeSessionClose) {
      try {
        await this.onBeforeSessionClose(sessionId, slot.folderPath);
      } catch (err) {
        console.warn('[pimote] onBeforeSessionClose threw:', err);
      }
    }

    teardownSessionState(slot.sessionState);
    slot.eventBusRef.current?.clear();

    const folderPath = slot.folderPath;
    await slot.runtime.dispose();
    this.sessions.delete(sessionId);
    this.lastKnownGitBranchBySession.delete(sessionId);

    this.onSessionClosed?.(sessionId, folderPath);
  }

  /** Re-key a slot in the session map after session replacement. */
  reKeySession(slot: ManagedSlot, oldId: string, newId: string): void {
    this.sessions.delete(oldId);
    this.sessions.set(newId, slot);

    const lastKnown = this.lastKnownGitBranchBySession.get(oldId) ?? null;
    this.lastKnownGitBranchBySession.delete(oldId);
    this.lastKnownGitBranchBySession.set(newId, lastKnown);
  }

  /** Sync read of the cached git branch for a session. Refreshed every 3s by the
   *  branch-check poll and seeded on open, so hot paths (sidebar broadcasts,
   *  get_session_meta) read this instead of shelling out to git on the event loop.
   *  May be up to ~3s stale; branch changes are rare so this is invisible in practice. */
  getLastKnownGitBranch(sessionId: string): string | null {
    return this.lastKnownGitBranchBySession.get(sessionId) ?? null;
  }

  /** The single "session was replaced" business operation. Reconciles the session
   *  map (rebuild state, evict any collision, re-key) ALWAYS, so a reset triggered
   *  with no live observer can never leave the map keyed under a stale ID. Then
   *  notifies every observer. All reset entry points (newSession/fork/navigateTree/
   *  switchSession, via WS commands or extension command-context) funnel here. */
  async applySessionReset(slot: ManagedSlot): Promise<void> {
    const newId = slot.runtime.session.sessionId;
    const oldId = slot.sessionState.id;
    const observers = [...slot.observers.values()];

    // navigateTree stays in the same file — same session ID, nothing to re-key.
    if (newId === oldId) {
      for (let index = 0; index < observers.length; index++) {
        const observer = observers[index];
        await observer.onSessionReset?.(slot, { kind: 'unchanged' }, index === 0);
      }
      return;
    }

    // Rebuild session state (tears down old, creates new from runtime.session).
    // Refreshes slot.folderPath from the new session header cwd (fork-from can
    // change cwd, e.g. the worktree extension), so read folderPath after this.
    this.rebuildSessionState(slot);

    // Collision: another live slot already holds newId. This happens when an
    // extension calls ctx.switchSession(path) onto a session file already open in
    // a different slot (the new ID is the target file's existing ID, not a fresh
    // one like fork's). Without eviction, reKeySession would overwrite the
    // occupant's map entry and orphan its runtime — two runtimes on one file.
    // Treat it as a takeover: notify the occupant's owner, then dispose it.
    const occupant = this.sessions.get(newId);
    if (occupant && occupant !== slot) {
      this.onSlotEvicted?.(newId);
      await this.closeSession(newId);
    }

    this.reKeySession(slot, oldId, newId);

    for (let index = 0; index < observers.length; index++) {
      const observer = observers[index];
      await observer.onSessionReset?.(slot, { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath }, index === 0);
    }
  }

  /** Rebuild a slot's SessionState after session replacement.
   *  Tears down the old state and creates a new one from the current runtime.session.
   *  Also refreshes slot.folderPath from the new session's header cwd, since fork-from
   *  (e.g. the worktree extension) can rebind the slot to a session whose cwd differs
   *  from the original. */
  rebuildSessionState(slot: ManagedSlot): void {
    teardownSessionState(slot.sessionState);

    const newCwd = slot.runtime.session.sessionManager.getCwd();
    if (newCwd) slot.folderPath = newCwd;

    const slotRef = { slot: slot as ManagedSlot | null };
    slot.sessionState = createSessionState(
      slot.runtime.session,
      slot.eventBusRef.current!,
      this.config,
      {
        onStatusChange: (sid, fp) => this.onStatusChange?.(sid, fp),
        onSessionIdle: (sid, s) => this.handleSessionIdle(sid, s),
        sendEvent: (e) => sendSlotEvent(slot, e),
        notify: (payload) => this.pushNotificationService.notify(payload),
      },
      slotRef,
      slot.folderPath,
    );
  }

  /** Attach or replace one observer for a live session. */
  async attachObserver(sessionId: string, observer: SessionObserver): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) throw new Error(`Session not found: ${sessionId}`);
    slot.observers.set(observer.clientId, observer);
  }

  /** Detach one observer from a live session. */
  detachObserver(sessionId: string, clientId: string): void {
    this.sessions.get(sessionId)?.observers.delete(clientId);
  }

  /** Alias for getSession that returns null (not undefined) for consumers
   *  that expect nullable pointers (e.g. VoiceSessionBusResolver). */
  getSlot(sessionId: string): ManagedSlot | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getSession(sessionId: string): ManagedSlot | undefined {
    return this.sessions.get(sessionId);
  }

  /** The shared, server-wide login orchestrator (login is global, not session-scoped). */
  getLoginOrchestrator(): LoginOrchestrator {
    return this.loginOrchestrator;
  }

  /** The process-lifetime model/auth runtime every session shares (manager sessions included). */
  getModelRuntime(): ModelRuntime {
    return this.modelRuntime;
  }

  getAllSessions(): ManagedSlot[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(idleTimeout: number, isCallActive?: (sessionId: string) => boolean): void {
    this.stopIdleCheck();

    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, candidate] of this.sessions) {
        this.withSessionOperation(sessionId, async () => {
          const slot = this.sessions.get(sessionId);
          if (slot !== candidate) return;
          if (slot.sessionState.treeNavigationInProgress) return;

          const hasObservers = slot.observers.size > 0;
          const hasActiveCall = isCallActive?.(sessionId) === true;
          // Only settled sessions can reap. Bash admission and active calls also
          // protect unobserved slots. Poll extensions only after the idle threshold.
          const idleSince = slot.sessionState.idleSince;
          const bashInProgress = slot.session.isBashRunning || slot.sessionState.bashDispatchInProgress === true;
          if (!hasObservers && !hasActiveCall && !bashInProgress && idleSince !== null && Date.now() - idleSince > idleTimeout) {
            const activityBus = slot.eventBusRef.current;
            if (activityBus && askActivity(activityBus)) return;
            await this.closeSession(sessionId);
          }
        }).catch(() => {
          // Best-effort cleanup — swallow errors during idle reaping
        });
      }
    }, 60_000);

    this.gitBranchCheckHandle = setInterval(() => {
      // Snapshot connected sessions and refresh their branches in parallel. The
      // lookups are async (execFile) so the poll never blocks the event loop;
      // hot-path readers consume the cache via getLastKnownGitBranch.
      const connected = [...this.sessions].filter(([, slot]) => slot.observers.size > 0);
      void Promise.all(
        connected.map(async ([sessionId, slot]) => {
          const next = await getGitBranch(slot.folderPath);
          const prev = this.lastKnownGitBranchBySession.get(sessionId) ?? null;
          if (next !== prev) {
            this.lastKnownGitBranchBySession.set(sessionId, next);
            this.onGitBranchChange?.(sessionId, slot.folderPath);
          }
        }),
      );
    }, 3000);
  }

  stopIdleCheck(): void {
    if (this.idleCheckHandle !== null) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
    if (this.gitBranchCheckHandle !== null) {
      clearInterval(this.gitBranchCheckHandle);
      this.gitBranchCheckHandle = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopIdleCheck();
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
  }
}
