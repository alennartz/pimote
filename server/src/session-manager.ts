import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createEventBus,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
  SessionManager as PiSessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionRuntime, EventBusController, CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import { EventBuffer } from './event-buffer.js';
import type { PimoteEvent, Card } from '../../shared/dist/index.js';
import type { SdkMessage } from './message-mapper.js';
import type { PushNotificationService } from './push-notification.js';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import type { PanelBusMessage } from './panel-state.js';
import { getGitBranch } from './git-branch.js';
import { LoginOrchestrator } from './login-orchestrator.js';
import { createVoiceExtension } from './voice/index.js';
import { autoDrainOnAbort } from './auto-drain-on-abort.js';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** Narrow interface for the WebSocket used for event routing.
 *  Avoids importing the `ws` package type in session-manager. */
export interface EventSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  readonly readyState: number;
}

export interface PendingUiEntry {
  resolve: (value: unknown) => void;
  /** The original request event, stored so it can be re-sent on reconnect. */
  event: PimoteEvent;
}

/** Outcome of a session reset, passed to the owning connection's notify
 *  callback so it can react without re-deriving old/new IDs (the slot's state
 *  has already been rebuilt to the new session by the time notify runs). */
export type SessionResetOutcome = { kind: 'unchanged' } | { kind: 'rekeyed'; oldId: string; newId: string; folderPath: string };

export interface ClientConnection {
  ws: EventSocket;
  connectedClientId: string;
  /** Notify-only hook the owning connection installs to react to a reset that
   *  has already been reconciled in the session map. Never performs the map
   *  reconcile itself — that lives in SessionManager.applySessionReset. */
  onSessionReset: ((slot: ManagedSlot, outcome: SessionResetOutcome) => Promise<void>) | null;
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
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
  /** True while a tree navigation + optional summarization is in progress. */
  treeNavigationInProgress: boolean;
}

export interface ManagedSlot {
  runtime: AgentSessionRuntime;
  folderPath: string;
  eventBusRef: { current: EventBusController | null };
  connection: ClientConnection | null;
  sessionState: SessionState;
  get session(): AgentSession;
}

// ---- Slot-based helpers (operate on ManagedSlot) ----

/** Send an event to the client connected to this slot. No-op if disconnected. */
export function sendSlotEvent(slot: ManagedSlot, event: PimoteEvent): void {
  const ws = slot.connection?.ws;
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // WebSocket send failed — ignore (client disconnecting)
  }
}

/** Create a pending promise for a UI dialog response. Stores the request event for replay on reconnect. */
export function waitForSlotUiResponse(slot: ManagedSlot, requestId: string, requestEvent: PimoteEvent): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    slot.sessionState.pendingUiResponses.set(requestId, { resolve, event: requestEvent });
  });
}

/** Resolve a specific pending UI response by requestId. */
export function resolveSlotPendingUi(slot: ManagedSlot, requestId: string, value: unknown): void {
  const pending = slot.sessionState.pendingUiResponses.get(requestId);
  if (pending) {
    slot.sessionState.pendingUiResponses.delete(requestId);
    pending.resolve(value);
  }
}

/** Resolve all pending UI responses with undefined. Used on abort, session close, or session reset. */
export function resolveAllSlotPendingUi(slot: ManagedSlot): void {
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    pending.resolve(undefined);
  }
  slot.sessionState.pendingUiResponses.clear();
}

/** Re-send all pending UI request events to the current client. Called on reconnect to recover lost dialogs. */
export function replaySlotPendingUiRequests(slot: ManagedSlot): void {
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    sendSlotEvent(slot, pending.event);
  }
}

// ---- Slot-based session state lifecycle helpers ----

/** Construct a SessionState from an AgentSession and EventBus.
 *  Subscribes to session events and sets up panel listeners. */
function createSessionState(
  session: AgentSession,
  eventBus: EventBusController,
  config: PimoteConfig,
  callbacks: {
    onStatusChange?: (sessionId: string, folderPath: string) => void;
    onAgentEnd?: (sessionId: string, slot: ManagedSlot) => void;
    sendEvent: (event: PimoteEvent) => void;
  },
  slotRef: { slot: ManagedSlot | null },
  folderPath: string,
): SessionState {
  const sessionId = session.sessionId;
  const eventBuffer = new EventBuffer(config.bufferSize);

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
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
  };

  // Subscribe to session events
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_start' && state.status !== 'working') {
      state.status = 'working';
      state.idleSince = null;
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'agent_end' && !event.willRetry && state.status !== 'idle') {
      // `willRetry` agent_end is not a real end — the SDK detected a retryable
      // error and will re-run the prompt after backoff (a fresh agent_start
      // follows). Treating it as idle here would fire a spurious completion
      // push notification and start the idle-reap clock for a session that is
      // still working. Skip it; the terminal (willRetry=false) agent_end will
      // drive the real idle transition.
      state.status = 'idle';
      state.idleSince = Date.now();
      state.needsAttention = true;
      if (slotRef.slot) callbacks.onAgentEnd?.(sessionId, slotRef.slot);
      callbacks.onStatusChange?.(sessionId, folderPath);
      // If the run ended via abort and there are queued steering /
      // follow-up messages, drain them — pi-agent-core's runLoop skips
      // its trailing queue poll on the abort exit path, so without this
      // queued messages would sit until the next prompt() call. Universal
      // across pimote (not voice-specific) so typed-mode users also
      // benefit. See `auto-drain-on-abort.ts` for rationale.
      void autoDrainOnAbort(session, event.messages[event.messages.length - 1]);
    }
    eventBuffer.onEvent(
      event,
      sessionId,
      (e) => callbacks.sendEvent(e),
      () => session.messages[session.messages.length - 1] as SdkMessage,
    );
  });

  state.unsubscribe = unsubscribe;

  // Set up panel listeners on the EventBus
  state.panelListenerUnsubs = setupSlotPanelListeners(eventBus, state, sessionId, callbacks.sendEvent);

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

  // Remove panel listeners
  for (const unsub of state.panelListenerUnsubs) unsub();
  state.panelListenerUnsubs = [];

  // Unsubscribe from session events
  state.unsubscribe();
}

/** Register panel detection and data listeners for a SessionState on an EventBus. */
function setupSlotPanelListeners(eventBus: EventBusController, state: SessionState, sessionId: string, sendEvent: (event: PimoteEvent) => void): (() => void)[] {
  const unsub1 = eventBus.on('pimote:detect:request', () => {
    eventBus.emit('pimote:detect:response', { detected: true });
  });
  const unsub2 = eventBus.on('pimote:panels', (data) => {
    applyPanelMessage(state.panelState, data as PanelBusMessage);
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
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly loginOrchestrator: LoginOrchestrator;
  private readonly sessions = new Map<string, ManagedSlot>();
  /** In-flight `openSession` promises keyed by session file path, so two
   *  concurrent opens of the same on-disk session share one runtime instead
   *  of building (and leaking) a second one over the same file. */
  private readonly inFlightOpens = new Map<string, Promise<string>>();
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
   *  session ID, BEFORE that slot is closed. Consumers notify the evicted slot's
   *  owning client (e.g. a `session_closed`/displaced event) while it is still
   *  addressable via getSlot. */
  onSlotEvicted?: (sessionId: string) => void;

  private readonly staticHostFactory?: ExtensionFactory;

  constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
    options: { staticHostFactory?: ExtensionFactory } = {},
  ) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.loginOrchestrator = new LoginOrchestrator(this.authStorage, this.modelRegistry);
    this.staticHostFactory = options.staticHostFactory;
  }

  /**
   * Build the voice extension factory for this server's config, if possible.
   * Returns undefined when voice is not configured (no speechmux URLs) or
   * when neither voice-specific model refs nor fallback defaultProvider/
   * defaultModel are configured. Non-voice deployments continue to work
   * unchanged — sessions simply don't load `@pimote/voice` at all.
   */
  private buildVoiceExtensionFactory(): ExtensionFactory | undefined {
    if (!this.config.voice?.speechmuxSignalUrl || !this.config.voice?.speechmuxLlmWsUrl) {
      return undefined;
    }
    const interpreter =
      this.config.defaultInterpreterModel ??
      (this.config.defaultProvider && this.config.defaultModel ? { provider: this.config.defaultProvider, modelId: this.config.defaultModel } : undefined);
    const worker =
      this.config.defaultWorkerModel ??
      (this.config.defaultProvider && this.config.defaultModel ? { provider: this.config.defaultProvider, modelId: this.config.defaultModel } : undefined);
    if (!interpreter || !worker) {
      console.warn('[pimote] voice extension disabled: no defaultInterpreterModel/defaultWorkerModel or fallback defaultProvider/defaultModel in config');
      return undefined;
    }
    return createVoiceExtension({
      defaultInterpreterModel: interpreter,
      defaultWorkerModel: worker,
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

  /** Find the id of an open slot bound to the given session file, if any. */
  private findSlotIdBySessionFile(sessionFilePath: string): string | undefined {
    for (const [sid, slot] of this.sessions) {
      if (slot.session.sessionFile === sessionFilePath) return sid;
    }
    return undefined;
  }

  private async doOpenSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    const eventBusRef: { current: EventBusController | null } = { current: null };
    const sharedAuthStorage = this.authStorage;
    const sharedModelRegistry = this.modelRegistry;
    const sessionManager = sessionFilePath ? PiSessionManager.open(sessionFilePath) : PiSessionManager.create(folderPath);
    const effectiveFolderPath = sessionFilePath ? sessionManager.getCwd() : folderPath;

    const voiceExtensionFactory = this.buildVoiceExtensionFactory();
    const staticHostFactory = this.staticHostFactory;
    const extensionFactories = [...(voiceExtensionFactory ? [voiceExtensionFactory] : []), ...(staticHostFactory ? [staticHostFactory] : [])];

    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const eventBus = createEventBus();
      eventBusRef.current = eventBus;

      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        authStorage: sharedAuthStorage,
        modelRegistry: sharedModelRegistry,
        resourceLoaderOptions: {
          eventBus,
          ...(extensionFactories.length ? { extensionFactories } : {}),
        },
      });

      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
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

    // Diagnostics: log model registry state after factory has loaded extensions
    const availableModels = this.modelRegistry.getAvailable();
    console.log(`[pimote] openSession: ${availableModels.length} models available, session model: ${session.model ? `${session.model.provider}/${session.model.id}` : 'none'}`);

    // Apply default model from config (only for new sessions without an existing model preference)
    if (!sessionFilePath && this.config.defaultProvider && this.config.defaultModel) {
      const models = this.modelRegistry.getAvailable();
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
        onAgentEnd: (sid, s) => this.handleAgentEnd(sid, s),
        sendEvent: (e) => sendSlotEvent(slot, e),
      },
      slotRef,
      effectiveFolderPath,
    );

    const slot: ManagedSlot = {
      runtime,
      folderPath: effectiveFolderPath,
      eventBusRef,
      connection: null,
      sessionState,
      get session() {
        return this.runtime.session;
      },
    };
    slotRef.slot = slot;

    this.sessions.set(sessionId, slot);
    this.lastKnownGitBranchBySession.set(sessionId, await getGitBranch(effectiveFolderPath));
    return sessionId;
  }

  private handleAgentEnd(sessionId: string, slot: ManagedSlot): void {
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
   *  map (rebuild state, evict any collision, re-key) ALWAYS — regardless of whether
   *  a client owns the slot — so a reset triggered with no live owner can never leave
   *  the map keyed under a stale ID. Then notifies whatever connection currently owns
   *  the slot (never the issuer). All reset entry points (newSession/fork/navigateTree/
   *  switchSession, via WS commands or extension command-context) funnel here. */
  async applySessionReset(slot: ManagedSlot): Promise<void> {
    const newId = slot.runtime.session.sessionId;
    const oldId = slot.sessionState.id;

    // navigateTree stays in the same file — same session ID, nothing to re-key.
    if (newId === oldId) {
      await slot.connection?.onSessionReset?.(slot, { kind: 'unchanged' });
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

    await slot.connection?.onSessionReset?.(slot, { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath });
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
        onAgentEnd: (sid, s) => this.handleAgentEnd(sid, s),
        sendEvent: (e) => sendSlotEvent(slot, e),
      },
      slotRef,
      slot.folderPath,
    );
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

  getAllSessions(): ManagedSlot[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(idleTimeout: number, isClientConnected?: (clientId: string) => boolean): void {
    this.stopIdleCheck();

    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, slot] of this.sessions) {
        if (slot.sessionState.treeNavigationInProgress) {
          continue;
        }

        const clientId = slot.connection?.connectedClientId ?? null;
        const hasConnectedClient = clientId !== null && (isClientConnected?.(clientId) ?? false);
        // Only idle (non-streaming) sessions are eligible for reaping. `idleSince` is set on
        // `agent_end` and cleared on `agent_start`, so a working session can never be reaped
        // here, regardless of how long it's been since a client was connected.
        const idleSince = slot.sessionState.idleSince;
        if (!hasConnectedClient && idleSince !== null && Date.now() - idleSince > idleTimeout) {
          this.closeSession(sessionId).catch(() => {
            // Best-effort cleanup — swallow errors during idle reaping
          });
        }
      }
    }, 60_000);

    this.gitBranchCheckHandle = setInterval(() => {
      // Snapshot connected sessions and refresh their branches in parallel. The
      // lookups are async (execFile) so the poll never blocks the event loop;
      // hot-path readers consume the cache via getLastKnownGitBranch.
      const connected = [...this.sessions].filter(([, slot]) => slot.connection?.connectedClientId);
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
