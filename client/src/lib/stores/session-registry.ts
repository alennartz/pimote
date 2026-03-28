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
  conflictingProcesses: Array<{ pid: number; command: string }>;
}

export class SessionRegistry {
  sessions: Map<string, PerSessionState> = new Map();
  viewedSessionId: string | null = null;

  /** Get the currently viewed session's state */
  get viewed(): PerSessionState | null {
    return this.sessions.get(this.viewedSessionId!) ?? null;
  }

  /** List all active sessions */
  get activeSessions(): PerSessionState[] {
    return Array.from(this.sessions.values());
  }

  /** Route an incoming event to the correct session's state */
  handleEvent(event: PimoteEvent): void {
    const sessionId = (event as any).sessionId as string | undefined;

    // buffered_events: iterate sub-events
    if (event.type === 'buffered_events') {
      const buffered = event as any;
      for (const subEvent of buffered.events) {
        this.handleEvent(subEvent);
      }
      return;
    }

    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (event.type) {
      case 'agent_start':
        session.status = 'working';
        session.isStreaming = true;
        break;

      case 'agent_end':
        session.status = 'idle';
        session.isStreaming = false;
        if (sessionId !== this.viewedSessionId) {
          session.needsAttention = true;
        }
        break;

      case 'message_update': {
        const update = event as any;
        if (update.content.type === 'text') {
          session.streamingText += update.content.text;
        } else if (update.content.type === 'thinking') {
          session.streamingThinking += update.content.text;
        }
        break;
      }

      case 'message_end': {
        const end = event as any;
        const message: PimoteAgentMessage = end.message;
        session.messages.push(message);
        session.streamingText = '';
        session.streamingThinking = '';
        session.messageCount++;
        // Capture firstMessage from first user message
        if (message.role === 'user' && session.firstMessage === undefined) {
          const textContent = message.content.find((c: any) => c.type === 'text');
          if (textContent && textContent.text) {
            session.firstMessage = textContent.text;
          }
        }
        break;
      }

      case 'tool_execution_start': {
        const start = event as any;
        session.activeToolCalls.set(start.toolCallId, {
          name: start.toolName,
          args: start.args,
          partialResult: '',
        });
        break;
      }

      case 'tool_execution_update': {
        const upd = event as any;
        const call = session.activeToolCalls.get(upd.toolCallId);
        if (call) {
          call.partialResult += upd.content;
        }
        break;
      }

      case 'tool_execution_end': {
        const end = event as any;
        session.activeToolCalls.delete(end.toolCallId);
        break;
      }

      case 'auto_compaction_start':
        session.isCompacting = true;
        break;

      case 'auto_compaction_end':
        session.isCompacting = false;
        break;

      case 'full_resync': {
        const resync = event as any;
        const state: SessionState = resync.state;
        const messages: PimoteAgentMessage[] = resync.messages;
        session.model = state.model;
        session.thinkingLevel = state.thinkingLevel;
        session.isStreaming = state.isStreaming;
        session.isCompacting = state.isCompacting;
        session.autoCompactionEnabled = state.autoCompactionEnabled;
        session.messageCount = state.messageCount;
        session.messages = messages;
        session.status = state.isStreaming ? 'working' : 'idle';
        session.streamingText = '';
        session.streamingThinking = '';
        session.activeToolCalls = new Map();
        break;
      }

      case 'session_conflict': {
        const conflict = event as any;
        session.conflictingProcesses = conflict.processes;
        break;
      }
    }
  }

  /** Add a session to the registry */
  addSession(sessionId: string, folderPath: string, projectName: string): void {
    const session: PerSessionState = {
      sessionId,
      folderPath,
      projectName,
      firstMessage: undefined,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      model: null,
      thinkingLevel: 'off',
      streamingText: '',
      streamingThinking: '',
      activeToolCalls: new Map(),
      autoCompactionEnabled: false,
      messageCount: 0,
      status: 'idle',
      needsAttention: false,
      conflictingProcesses: [],
    };
    this.sessions.set(sessionId, session);
  }

  /** Remove a session from the registry */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.viewedSessionId === sessionId) {
      this.viewedSessionId = null;
    }
  }

  /** Switch viewed session, clears needsAttention for target */
  switchTo(sessionId: string): void {
    this.viewedSessionId = sessionId;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.needsAttention = false;
    }
  }

  /** Clear conflicting processes for a session (after user dismisses or kills them) */
  clearConflict(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.conflictingProcesses = [];
    }
  }
}
