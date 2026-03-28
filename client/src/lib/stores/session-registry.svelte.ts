// SessionRegistry — Svelte 5 runes-based session state manager
//
// This class MUST live in a .svelte.ts file so the Svelte compiler can
// transform $state() runes on class fields into reactive getter/setter pairs.
// Svelte 5's $state() proxy only wraps plain objects and arrays — class
// instances are returned as-is. That means wrapping `new SessionRegistry()`
// with $state() does nothing. The runes must be on the individual fields.

import type { PimoteEvent, PimoteAgentMessage, SessionState } from '@pimote/shared';
import { connection } from './connection.svelte.js';

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
  activeToolCalls: Record<string, { name: string; args: unknown; partialResult: string }>;
  autoCompactionEnabled: boolean;
  messageCount: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
  conflictingProcesses: Array<{ pid: number; command: string }>;
}

export class SessionRegistry {
  sessions: Record<string, PerSessionState> = $state({});
  viewedSessionId: string | null = $state(null);

  /** Get the currently viewed session's state */
  get viewed(): PerSessionState | null {
    return this.sessions[this.viewedSessionId!] ?? null;
  }

  /** List all active sessions */
  get activeSessions(): PerSessionState[] {
    return Object.values(this.sessions);
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
    const session = this.sessions[sessionId];
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
        session.activeToolCalls[start.toolCallId] = {
          name: start.toolName,
          args: start.args,
          partialResult: '',
        };
        break;
      }

      case 'tool_execution_update': {
        const upd = event as any;
        const call = session.activeToolCalls[upd.toolCallId];
        if (call) {
          call.partialResult += upd.content;
        }
        break;
      }

      case 'tool_execution_end': {
        const end = event as any;
        delete session.activeToolCalls[end.toolCallId];
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
        session.activeToolCalls = {};
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
      activeToolCalls: {},
      autoCompactionEnabled: false,
      messageCount: 0,
      status: 'idle',
      needsAttention: false,
      conflictingProcesses: [],
    };
    this.sessions[sessionId] = session;
  }

  /** Remove a session from the registry */
  removeSession(sessionId: string): void {
    delete this.sessions[sessionId];
    if (this.viewedSessionId === sessionId) {
      this.viewedSessionId = null;
    }
  }

  /** Switch viewed session, clears needsAttention for target */
  switchTo(sessionId: string): void {
    this.viewedSessionId = sessionId;
    const session = this.sessions[sessionId];
    if (session) {
      session.needsAttention = false;
    }
  }

  /** Clear conflicting processes for a session (after user dismisses or kills them) */
  clearConflict(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (session) {
      session.conflictingProcesses = [];
    }
  }
}

// Create singleton instance — fields are reactive via $state() runes above
export const sessionRegistry = new SessionRegistry();

// Subscribe to connection events and route to the registry
connection.onEvent((event) => {
  switch (event.type) {
    case 'session_opened': {
      const folder = (event as any).folder;
      const projectName = folder?.name ?? 'Unknown';
      sessionRegistry.addSession(event.sessionId, folder?.path ?? '', projectName);
      connection.addSubscribedSession(event.sessionId);
      sessionRegistry.switchTo(event.sessionId);
      // Request initial state and messages atomically to avoid race conditions
      Promise.all([
        connection.send({ type: 'get_state', sessionId: event.sessionId }),
        connection.send({ type: 'get_messages', sessionId: event.sessionId }),
      ]).then(([stateRes, msgRes]) => {
        const session = sessionRegistry.sessions[event.sessionId];
        if (!session) return;
        if (stateRes.success && stateRes.data) {
          const state = (stateRes.data as any).state;
          session.model = state.model;
          session.thinkingLevel = state.thinkingLevel;
          session.isStreaming = state.isStreaming;
          session.isCompacting = state.isCompacting;
          session.autoCompactionEnabled = state.autoCompactionEnabled;
          session.messageCount = state.messageCount;
          session.status = state.isStreaming ? 'working' : 'idle';
        }
        if (msgRes.success && msgRes.data) {
          const messages = (msgRes.data as any).messages;
          session.messages = messages;
          session.messageCount = messages.length;
        }
      });
      break;
    }
    case 'session_closed': {
      sessionRegistry.removeSession(event.sessionId);
      connection.removeSubscribedSession(event.sessionId);
      break;
    }
    default: {
      // Route all other events with sessionId to the registry
      if ('sessionId' in event) {
        sessionRegistry.handleEvent(event);
      }
      break;
    }
  }
});

// Helper that also sends view_session to server
export function switchToSession(sessionId: string): void {
  sessionRegistry.switchTo(sessionId);
  connection.send({ type: 'view_session', sessionId }).catch(() => {});
}
