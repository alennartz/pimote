import crypto from 'node:crypto';
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
import type { WebSocket } from 'ws';

export interface ManagedSession {
  id: string;
  session: AgentSession;
  folderPath: string;
  sessionFilePath: string | undefined;
  eventBuffer: EventBuffer;
  connectedClient: WebSocket | null;
  lastActivity: number; // Date.now()
  status: 'idle' | 'working';
  unsubscribe: () => void;
}

export class PimoteSessionManager {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, ManagedSession>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: PimoteConfig) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  async openSession(
    folderPath: string,
    sessionPath?: string,
    sendLive?: (event: PimoteSessionEvent) => void,
    onStatusChange?: (sessionId: string, status: 'idle' | 'working') => void,
  ): Promise<string> {
    const sessionId = crypto.randomUUID();

    const loader = new DefaultResourceLoader({ cwd: folderPath });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: folderPath,
      resourceLoader: loader,
      sessionManager: sessionPath
        ? PiSessionManager.open(sessionPath)
        : PiSessionManager.create(folderPath),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const eventBuffer = new EventBuffer(this.config.bufferSize);

    const managed: ManagedSession = {
      id: sessionId,
      session,
      folderPath,
      sessionFilePath: sessionPath,
      eventBuffer,
      connectedClient: null,
      lastActivity: Date.now(),
      status: 'idle',
      unsubscribe: () => {},
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' && managed.status !== 'working') {
        managed.status = 'working';
        onStatusChange?.(sessionId, 'working');
      } else if (event.type === 'agent_end' && managed.status !== 'idle') {
        managed.status = 'idle';
        onStatusChange?.(sessionId, 'idle');
      }
      eventBuffer.onEvent(event, sessionId, sendLive ?? (() => {}));
    });

    managed.unsubscribe = unsubscribe;

    this.sessions.set(sessionId, managed);
    return sessionId;
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

  startIdleCheck(idleTimeout: number): void {
    this.stopIdleCheck();
    this.idleCheckHandle = setInterval(() => {
      for (const [sessionId, managed] of this.sessions) {
        if (
          managed.connectedClient === null &&
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
