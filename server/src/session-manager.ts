import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
} from '@mariozechner/pi-coding-agent';
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

  constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
  ) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  async openSession(
    folderPath: string,
    sessionFilePath?: string,
    sendLive?: (event: PimoteSessionEvent) => void,
  ): Promise<string> {
    const loader = new DefaultResourceLoader({ cwd: folderPath });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: folderPath,
      resourceLoader: loader,
      sessionManager: sessionFilePath
        ? PiSessionManager.open(sessionFilePath)
        : PiSessionManager.create(folderPath),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const sessionId = session.sessionId;

    // Apply default model from config (only for new sessions without an existing model preference)
    if (!sessionFilePath && this.config.defaultProvider && this.config.defaultModel) {
      const models = this.modelRegistry.getAvailable();
      const defaultModel = models.find(
        (m) => m.provider === this.config.defaultProvider && m.id === this.config.defaultModel,
      );
      if (defaultModel) {
        await session.setModel(defaultModel);
        console.log(`[pimote] Set default model: ${defaultModel.provider}/${defaultModel.id}`);
      } else {
        console.warn(`[pimote] Default model not found: ${this.config.defaultProvider}/${this.config.defaultModel}`);
      }
    }

    // Apply default thinking level from config
    if (!sessionFilePath && this.config.defaultThinkingLevel) {
      session.setThinkingLevel(this.config.defaultThinkingLevel as any);
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
      } else if (event.type === 'agent_end' && managed.status !== 'idle') {
        managed.status = 'idle';
        managed.needsAttention = true;
        const projectName = folderPath.split('/').pop() ?? 'Unknown';
        const firstMessage = this.extractFirstMessage(managed);
        this.pushNotificationService.notifySessionIdle({
          projectName,
          folderPath,
          firstMessage,
          sessionId,
        }).catch(err => console.error('[SessionManager] Push notification error:', err));
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
      if ((msg as any).role !== 'user') continue;
      const content = (msg as any).content;
      if (typeof content === 'string') return content.slice(0, 100);
      if (Array.isArray(content)) {
        const textItem = content.find((c: any) => c.type === 'text');
        if (textItem?.text) return textItem.text.slice(0, 100);
      }
      break;
    }
    return undefined;
  }

  async closeSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    managed.unsubscribe();
    managed.session.dispose();
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(
    idleTimeout: number,
    isClientConnected?: (clientId: string) => boolean,
  ): void {
    this.stopIdleCheck();
    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, managed] of this.sessions) {
        const hasConnectedClient =
          managed.connectedClientId !== null &&
          (isClientConnected?.(managed.connectedClientId) ?? false);
        if (
          !hasConnectedClient &&
          Date.now() - managed.lastActivity > idleTimeout
        ) {
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
