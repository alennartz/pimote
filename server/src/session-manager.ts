import { createAgentSession, AuthStorage, ModelRegistry, DefaultResourceLoader, SessionManager as PiSessionManager } from '@mariozechner/pi-coding-agent';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import { EventBuffer } from './event-buffer.js';
import type { PimoteSessionEvent } from '@pimote/shared';
import type { PushNotificationService } from './push-notification.js';

export interface ManagedSession {
  id: string;
  session: AgentSession;
  folderPath: string;
  eventBuffer: EventBuffer;
  connectedClientId: string | null;
  lastActivity: number; // Date.now()
  status: 'idle' | 'working';
  needsAttention: boolean;
  sendLive: (event: PimoteSessionEvent) => void;
  unsubscribe: () => void;
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

  async openSession(folderPath: string, sessionFilePath?: string, sendLive?: (event: PimoteSessionEvent) => void): Promise<string> {
    const loader = new DefaultResourceLoader({ cwd: folderPath });
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
      sendLive: sendLive ?? (() => {}),
      unsubscribe: () => {},
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' && managed.status !== 'working') {
        managed.status = 'working';
        this.onStatusChange?.(sessionId, folderPath);
      } else if (event.type === 'agent_end' && managed.status !== 'idle') {
        managed.status = 'idle';
        managed.needsAttention = true;
        const projectName = folderPath.split('/').pop() ?? 'Unknown';
        const firstMessage = this.extractFirstMessage(managed);
        this.pushNotificationService
          .notifySessionIdle({
            projectName,
            folderPath,
            firstMessage,
            sessionId,
          })
          .catch((err) => console.error('[SessionManager] Push notification error:', err));
        this.onStatusChange?.(sessionId, folderPath);
      }
      eventBuffer.onEvent(event, sessionId, (e) => managed.sendLive(e));
    });

    managed.unsubscribe = unsubscribe;

    this.sessions.set(sessionId, managed);
    return sessionId;
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

    const folderPath = managed.folderPath;
    managed.unsubscribe();
    managed.session.dispose();
    this.sessions.delete(sessionId);

    this.onSessionClosed?.(sessionId, folderPath);
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
