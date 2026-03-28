import type { PimoteEvent, PimoteAgentMessage, SessionState } from '@pimote/shared';

export interface PerSessionState {
  sessionId: string;
  folderPath: string;
  projectName: string;
  firstMessage: string | undefined;
  messages: PimoteAgentMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  streamingText: string;
  streamingThinking: string;
  activeToolCalls: Map<string, { name: string; args: unknown; partialResult: string }>;
  autoCompactionEnabled: boolean;
  messageCount: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
}

export class SessionRegistry {
  sessions: Map<string, PerSessionState> = new Map();
  viewedSessionId: string | null = null;

  /** Get the currently viewed session's state */
  get viewed(): PerSessionState | null { throw new Error('Not implemented'); }

  /** List all active sessions */
  get activeSessions(): PerSessionState[] { throw new Error('Not implemented'); }

  /** Route an incoming event to the correct session's state */
  handleEvent(event: PimoteEvent): void { throw new Error('Not implemented'); }

  /** Add a session to the registry */
  addSession(sessionId: string, folderPath: string, projectName: string): void { throw new Error('Not implemented'); }

  /** Remove a session from the registry */
  removeSession(sessionId: string): void { throw new Error('Not implemented'); }

  /** Switch viewed session, clears needsAttention for target */
  switchTo(sessionId: string): void { throw new Error('Not implemented'); }
}
