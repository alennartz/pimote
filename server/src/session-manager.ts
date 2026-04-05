import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createEventBus,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
  SessionManager as PiSessionManager,
} from '@mariozechner/pi-coding-agent';
import type { AgentSession, AgentSessionRuntime, EventBusController, CreateAgentSessionRuntimeFactory } from '@mariozechner/pi-coding-agent';
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

export interface ClientConnection {
  ws: EventSocket;
  connectedClientId: string;
  onSessionReset: ((slot: ManagedSlot) => Promise<void>) | null;
}

export interface SessionState {
  id: string;
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  lastActivity: number;
  unsubscribe: () => void;
  pendingUiResponses: Map<string, PendingUiEntry>;
  extensionsBound: boolean;
  panelState: Map<string, Card[]>;
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
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
    lastActivity: Date.now(),
    unsubscribe: () => {},
    pendingUiResponses: new Map(),
    extensionsBound: false,
    panelState: new Map(),
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
  };

  // Subscribe to session events
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_start' && state.status !== 'working') {
      state.status = 'working';
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'agent_end' && state.status !== 'idle') {
      state.status = 'idle';
      state.needsAttention = true;
      if (slotRef.slot) callbacks.onAgentEnd?.(sessionId, slotRef.slot);
      callbacks.onStatusChange?.(sessionId, folderPath);
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
  return [unsub1, unsub2];
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

export class PimoteSessionManager {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, ManagedSlot>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  onStatusChange?: (sessionId: string, folderPath: string) => void;
  onSessionClosed?: (sessionId: string, folderPath: string) => void;

  constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
  ) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  async openSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    const eventBusRef: { current: EventBusController | null } = { current: null };
    const sharedAuthStorage = this.authStorage;
    const sharedModelRegistry = this.modelRegistry;

    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const eventBus = createEventBus();
      eventBusRef.current = eventBus;

      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        authStorage: sharedAuthStorage,
        modelRegistry: sharedModelRegistry,
        resourceLoaderOptions: { eventBus },
      });

      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(factory, {
      cwd: folderPath,
      agentDir: getAgentDir(),
      sessionManager: sessionFilePath ? PiSessionManager.open(sessionFilePath) : PiSessionManager.create(folderPath),
    });

    const session = runtime.session;
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
      folderPath,
    );

    const slot: ManagedSlot = {
      runtime,
      folderPath,
      eventBusRef,
      connection: null,
      sessionState,
      get session() {
        return this.runtime.session;
      },
    };
    slotRef.slot = slot;

    this.sessions.set(sessionId, slot);
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

    teardownSessionState(slot.sessionState);
    slot.eventBusRef.current?.clear();

    const folderPath = slot.folderPath;
    await slot.runtime.dispose();
    this.sessions.delete(sessionId);

    this.onSessionClosed?.(sessionId, folderPath);
  }

  /** Re-key a slot in the session map after session replacement. */
  reKeySession(slot: ManagedSlot, oldId: string, newId: string): void {
    this.sessions.delete(oldId);
    this.sessions.set(newId, slot);
  }

  /** Rebuild a slot's SessionState after session replacement.
   *  Tears down the old state and creates a new one from the current runtime.session. */
  rebuildSessionState(slot: ManagedSlot): void {
    teardownSessionState(slot.sessionState);

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

  getSession(sessionId: string): ManagedSlot | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): ManagedSlot[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(idleTimeout: number, isClientConnected?: (clientId: string) => boolean): void {
    this.stopIdleCheck();
    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, slot] of this.sessions) {
        const clientId = slot.connection?.connectedClientId ?? null;
        const hasConnectedClient = clientId !== null && (isClientConnected?.(clientId) ?? false);
        if (!hasConnectedClient && Date.now() - slot.sessionState.lastActivity > idleTimeout) {
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
