import { createAgentSession, createEventBus, AuthStorage, ModelRegistry, DefaultResourceLoader, SessionManager as PiSessionManager } from '@mariozechner/pi-coding-agent';
import type { AgentSession, EventBusController } from '@mariozechner/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import { EventBuffer } from './event-buffer.js';
import type { PimoteEvent, Card } from '@pimote/shared';
import type { SdkMessage } from './message-mapper.js';
import type { PushNotificationService } from './push-notification.js';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import type { PanelBusMessage } from './panel-state.js';

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

export interface ManagedSession {
  id: string;
  session: AgentSession;
  folderPath: string;
  eventBuffer: EventBuffer;
  connectedClientId: string | null;
  lastActivity: number; // Date.now()
  status: 'idle' | 'working';
  needsAttention: boolean;
  unsubscribe: () => void;

  /** Current WebSocket for sending events. Null when no client is connected. */
  ws: EventSocket | null;
  /** Pending extension UI dialog promises. Keyed by requestId. Session-scoped, survives reconnects. */
  pendingUiResponses: Map<string, PendingUiEntry>;
  /** Whether bindExtensions has been called (only done once per session). */
  extensionsBound: boolean;
  /** Callback for session resets (newSession, fork, etc.). Set by the claiming handler. */
  onSessionReset: ((managed: ManagedSession) => Promise<void>) | null;
  /** Panel card state, keyed by namespace. */
  panelState: Map<string, Card[]>;
  /** Timer handle for throttled panel pushes. */
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
  /** EventBus for extension communication (panels, detect). Survives session resets. */
  eventBus: EventBusController | null;
  /** Unsubscribe functions for EventBus panel listeners. Called on detach to prevent stale handlers. */
  panelListenerUnsubs: (() => void)[];
}

// ---- Managed session helpers (closure-free, operate on stable ManagedSession reference) ----

/** Send an event to the client connected to this session. No-op if disconnected. */
export function sendManagedEvent(managed: ManagedSession, event: PimoteEvent): void {
  if (!managed.ws || managed.ws.readyState !== 1) return;
  try {
    managed.ws.send(JSON.stringify(event));
  } catch {
    // WebSocket send failed — ignore (client disconnecting)
  }
}

/** Create a pending promise for a UI dialog response. Stores the request event for replay on reconnect. */
export function waitForManagedUiResponse(managed: ManagedSession, requestId: string, requestEvent: PimoteEvent): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    managed.pendingUiResponses.set(requestId, { resolve, event: requestEvent });
  });
}

/** Resolve a specific pending UI response by requestId. */
export function resolveManagedPendingUi(managed: ManagedSession, requestId: string, value: unknown): void {
  const pending = managed.pendingUiResponses.get(requestId);
  if (pending) {
    managed.pendingUiResponses.delete(requestId);
    pending.resolve(value);
  }
}

/** Resolve all pending UI responses with undefined. Used on abort, session close, or session reset. */
export function resolveAllManagedPendingUi(managed: ManagedSession): void {
  for (const [, pending] of managed.pendingUiResponses) {
    pending.resolve(undefined);
  }
  managed.pendingUiResponses.clear();
}

/** Re-send all pending UI request events to the current client. Called on reconnect to recover lost dialogs. */
export function replayManagedPendingUiRequests(managed: ManagedSession): void {
  for (const [, pending] of managed.pendingUiResponses) {
    sendManagedEvent(managed, pending.event);
  }
}

/** Register panel detection and data listeners on an EventBus for a managed session.
 *  Returns unsubscribe functions so listeners can be removed on detach. */
function setupPanelListeners(eventBus: EventBusController, managed: ManagedSession): (() => void)[] {
  const unsub1 = eventBus.on('pimote:detect:request', () => {
    eventBus.emit('pimote:detect:response', { detected: true });
  });
  const unsub2 = eventBus.on('pimote:panels', (data) => {
    applyPanelMessage(managed.panelState, data as PanelBusMessage);
    schedulePanelPush(managed);
  });
  return [unsub1, unsub2];
}

/** Schedule a throttled panel push (~200ms). Merges all namespaces and sends to the client. */
function schedulePanelPush(managed: ManagedSession): void {
  if (managed.panelThrottleTimer !== null) return;
  managed.panelThrottleTimer = setTimeout(() => {
    managed.panelThrottleTimer = null;
    const cards = getMergedPanelCards(managed.panelState);
    sendManagedEvent(managed, { type: 'panel_update', sessionId: managed.id, cards });
  }, 200);
}

export class PimoteSessionManager {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, ManagedSession>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  onStatusChange?: (sessionId: string, folderPath: string) => void;
  onSessionClosed?: (sessionId: string, folderPath: string) => void;

  constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
  ) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  async openSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({ cwd: folderPath, eventBus });
    await loader.reload();

    // Flush extension provider registrations so extension-provided models are
    // available for model resolution before AgentSession is created.
    // Without this, extension models (e.g. azure-foundry) aren't in the registry
    // when findInitialModel() runs inside createAgentSession, causing the first
    // session after restart to get model: null.
    const extensionsResult = loader.getExtensions();
    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        this.modelRegistry.registerProvider(name, config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pimote] Extension "${extensionPath}" provider registration error: ${message}`);
      }
    }

    const { session } = await createAgentSession({
      cwd: folderPath,
      resourceLoader: loader,
      sessionManager: sessionFilePath ? PiSessionManager.open(sessionFilePath) : PiSessionManager.create(folderPath),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const sessionId = session.sessionId;

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

    const eventBuffer = new EventBuffer(this.config.bufferSize);

    const managed: ManagedSession = {
      id: sessionId,
      session,
      folderPath,
      eventBuffer,
      connectedClientId: null,
      lastActivity: Date.now(),
      status: 'idle',
      needsAttention: false,
      unsubscribe: () => {},
      ws: null,
      pendingUiResponses: new Map(),
      extensionsBound: false,
      onSessionReset: null,
      panelState: new Map(),
      panelThrottleTimer: null,
      eventBus,
      panelListenerUnsubs: [],
    };

    managed.panelListenerUnsubs = setupPanelListeners(eventBus, managed);

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' && managed.status !== 'working') {
        managed.status = 'working';
        this.onStatusChange?.(sessionId, folderPath);
      } else if (event.type === 'agent_end' && managed.status !== 'idle') {
        managed.status = 'idle';
        managed.needsAttention = true;
        const projectName = folderPath.split('/').pop() ?? 'Unknown';
        const firstMessage = this.extractFirstMessage(managed);
        const lastAgentMessage = this.extractLastAgentMessage(managed);
        this.pushNotificationService
          .notify({
            projectName,
            folderPath,
            sessionId,
            sessionName: managed.session.sessionName,
            firstMessage,
            reason: 'idle',
            lastAgentMessage,
          })
          .catch((err) => console.error('[SessionManager] Push notification error:', err));
        this.onStatusChange?.(sessionId, folderPath);
      }
      eventBuffer.onEvent(
        event,
        sessionId,
        (e) => sendManagedEvent(managed, e),
        () => session.messages[session.messages.length - 1] as SdkMessage,
      );
    });

    managed.unsubscribe = unsubscribe;

    this.sessions.set(sessionId, managed);
    return sessionId;
  }

  private extractLastAgentMessage(managed: ManagedSession): string | undefined {
    const messages = managed.session.messages ?? [];
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

  private extractFirstMessage(managed: ManagedSession): string | undefined {
    const messages = managed.session.messages ?? [];
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
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    resolveAllManagedPendingUi(managed);
    if (managed.panelThrottleTimer) clearTimeout(managed.panelThrottleTimer);
    managed.eventBus?.clear();

    const folderPath = managed.folderPath;
    managed.unsubscribe();
    managed.session.dispose();
    this.sessions.delete(sessionId);

    this.onSessionClosed?.(sessionId, folderPath);
  }

  /** Remove a session from management without disposing the underlying AgentSession.
   *  Used when the pi SDK resets the session (newSession, fork, switchSession) —
   *  the AgentSession object is reused by the new session. */
  detachSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (managed.panelThrottleTimer) clearTimeout(managed.panelThrottleTimer);
    // Remove old panel listeners so they don't fire on the detached managed session.
    // The EventBus itself survives — adoptSession will re-register on the new managed session.
    for (const unsub of managed.panelListenerUnsubs) unsub();
    managed.panelListenerUnsubs = [];
    managed.unsubscribe();
    this.sessions.delete(sessionId);
    this.onSessionClosed?.(sessionId, managed.folderPath);
  }

  /** Wrap an existing AgentSession in a new ManagedSession.
   *  Used after detachSession when the pi SDK has reset the session to a new ID.
   *  Pass `extensionsBound: true` when the underlying AgentSession already has
   *  extensions bound (e.g. after a session reset that reuses the same object). */
  adoptSession(session: AgentSession, folderPath: string, opts?: { extensionsBound?: boolean; eventBus?: EventBusController }): string {
    const sessionId = session.sessionId;
    const eventBuffer = new EventBuffer(this.config.bufferSize);
    const eventBus = opts?.eventBus ?? null;

    const managed: ManagedSession = {
      id: sessionId,
      session,
      folderPath,
      eventBuffer,
      connectedClientId: null,
      lastActivity: Date.now(),
      status: session.isStreaming ? 'working' : 'idle',
      needsAttention: false,
      unsubscribe: () => {},
      ws: null,
      pendingUiResponses: new Map(),
      extensionsBound: opts?.extensionsBound ?? false,
      onSessionReset: null,
      panelState: new Map(),
      panelThrottleTimer: null,
      eventBus,
      panelListenerUnsubs: [],
    };

    if (eventBus) managed.panelListenerUnsubs = setupPanelListeners(eventBus, managed);

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' && managed.status !== 'working') {
        managed.status = 'working';
        this.onStatusChange?.(managed.id, folderPath);
      } else if (event.type === 'agent_end' && managed.status !== 'idle') {
        managed.status = 'idle';
        managed.needsAttention = true;
        const projectName = folderPath.split('/').pop() ?? 'Unknown';
        const firstMessage = this.extractFirstMessage(managed);
        const lastAgentMessage = this.extractLastAgentMessage(managed);
        this.pushNotificationService
          .notify({
            projectName,
            folderPath,
            sessionId: managed.id,
            sessionName: managed.session.sessionName,
            firstMessage,
            reason: 'idle',
            lastAgentMessage,
          })
          .catch((err) => console.error('[SessionManager] Push notification error:', err));
        this.onStatusChange?.(managed.id, folderPath);
      }
      eventBuffer.onEvent(
        event,
        managed.id,
        (e) => sendManagedEvent(managed, e),
        () => session.messages[session.messages.length - 1] as SdkMessage,
      );
    });

    managed.unsubscribe = unsubscribe;
    this.sessions.set(sessionId, managed);
    return sessionId;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(idleTimeout: number, isClientConnected?: (clientId: string) => boolean): void {
    this.stopIdleCheck();
    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, managed] of this.sessions) {
        const hasConnectedClient = managed.connectedClientId !== null && (isClientConnected?.(managed.connectedClientId) ?? false);
        if (!hasConnectedClient && Date.now() - managed.lastActivity > idleTimeout) {
          this.closeSession(sessionId).catch(() => {
            // Best-effort cleanup — swallow errors during idle reaping
          });
        }
      }
    }, 60_000);
  }

  stopIdleCheck(): void {
    if (this.idleCheckHandle !== null) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopIdleCheck();
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
  }
}
