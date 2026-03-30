// SessionRegistry — Svelte 5 runes-based session state manager
//
// This class MUST live in a .svelte.ts file so the Svelte compiler can
// transform $state() runes on class fields into reactive getter/setter pairs.
// Svelte 5's $state() proxy only wraps plain objects and arrays — class
// instances are returned as-is. That means wrapping `new SessionRegistry()`
// with $state() does nothing. The runes must be on the individual fields.

import type {
  PimoteEvent,
  PimoteAgentMessage,
  PimoteMessageContent,
  SessionState,
  SessionMeta,
  BufferedEventsEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  FullResyncEvent,
  SessionConflictEvent,
  SessionOpenedEvent,
} from '@pimote/shared';
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
  conflictingRemoteSessions: Array<{ sessionId: string; status: 'working' | 'idle' }>;
  pendingTakeover: boolean;
  gitBranch: string | null;
  contextUsage: { percent: number | null; contextWindow: number } | null;
  draftText: string;
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
    const sessionId = event.sessionId;

    // buffered_events: iterate sub-events
    if (event.type === 'buffered_events') {
      const buffered = event as BufferedEventsEvent;
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
        // Refresh meta (context usage changes after each turn, branch may change)
        connection
          .send({ type: 'get_session_meta', sessionId })
          .then((res) => {
            if (res.success && res.data) {
              this.updateMeta(sessionId, (res.data as { meta: SessionMeta }).meta);
            }
          })
          .catch(() => {});
        break;

      case 'message_start':
        // Reset streaming accumulators for the new message within a turn
        session.streamingText = '';
        session.streamingThinking = '';
        break;

      case 'message_update': {
        const update = event as MessageUpdateEvent;
        if (update.content.type === 'text') {
          session.streamingText += update.content.text;
        } else if (update.content.type === 'thinking') {
          session.streamingThinking += update.content.text;
        }
        break;
      }

      case 'message_end': {
        const end = event as MessageEndEvent;
        const message: PimoteAgentMessage = end.message;
        session.messages = [...session.messages, message];
        session.streamingText = '';
        session.streamingThinking = '';
        session.messageCount++;
        // Capture firstMessage from first user message
        if (message.role === 'user' && session.firstMessage === undefined) {
          const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
          if (textContent && textContent.text) {
            session.firstMessage = textContent.text;
          }
        }
        break;
      }

      case 'tool_execution_start': {
        const start = event as ToolExecutionStartEvent;
        session.activeToolCalls[start.toolCallId] = {
          name: start.toolName,
          args: start.args,
          partialResult: '',
        };
        break;
      }

      case 'tool_execution_update': {
        const upd = event as ToolExecutionUpdateEvent;
        const call = session.activeToolCalls[upd.toolCallId];
        if (call) {
          call.partialResult += upd.content;
        }
        break;
      }

      case 'tool_execution_end': {
        const end = event as ToolExecutionEndEvent;
        delete session.activeToolCalls[end.toolCallId];
        break;
      }

      case 'auto_compaction_start':
        session.isCompacting = true;
        break;

      case 'auto_compaction_end':
        session.isCompacting = false;
        // Context usage changes significantly after compaction
        connection
          .send({ type: 'get_session_meta', sessionId })
          .then((res) => {
            if (res.success && res.data) {
              this.updateMeta(sessionId, (res.data as { meta: SessionMeta }).meta);
            }
          })
          .catch(() => {});
        break;

      case 'full_resync': {
        const resync = event as FullResyncEvent;
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
        const conflict = event as SessionConflictEvent;
        session.conflictingProcesses = conflict.processes;
        session.conflictingRemoteSessions = conflict.remoteSessions ?? [];
        break;
      }
    }
  }

  /** Add a session to the registry. If it already exists (e.g. takeover placeholder), resets it. */
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
      conflictingRemoteSessions: [],
      pendingTakeover: false,
      gitBranch: null,
      contextUsage: null,
      draftText: '',
    };
    this.sessions[sessionId] = session;
  }

  /** Remove a session from the registry */
  removeSession(sessionId: string): void {
    const wasViewed = this.viewedSessionId === sessionId;
    // Reassign rather than delete to reliably trigger Svelte 5 $state reactivity
    const { [sessionId]: _, ...rest } = this.sessions;
    this.sessions = rest;
    if (wasViewed) {
      // Switch to another active session if one exists, otherwise go to landing
      const remaining = Object.keys(this.sessions);
      this.viewedSessionId = remaining.length > 0 ? remaining[0] : null;
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

  /** Check if a session ID is currently active */
  isActiveSession(sessionId: string): boolean {
    return sessionId in this.sessions;
  }

  /** Update session meta (git branch, context usage) */
  updateMeta(sessionId: string, meta: SessionMeta): void {
    const session = this.sessions[sessionId];
    if (session) {
      session.gitBranch = meta.gitBranch;
      session.contextUsage = meta.contextUsage;
    }
  }

  /** Clear conflicting processes for a session (after user dismisses or kills them) */
  clearConflict(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (session) {
      session.conflictingProcesses = [];
      session.conflictingRemoteSessions = [];
    }
  }
}

// Create singleton instance — fields are reactive via $state() runes above
export const sessionRegistry = new SessionRegistry();

// Subscribe to connection events and route to the registry
connection.onEvent((event) => {
  switch (event.type) {
    case 'session_opened': {
      const folder = (event as SessionOpenedEvent).folder;
      const projectName = folder?.name ?? 'Unknown';
      sessionRegistry.addSession(event.sessionId, folder?.path ?? '', projectName);
      connection.addSubscribedSession(event.sessionId);
      sessionRegistry.switchTo(event.sessionId);
      // Request initial state, messages, and meta atomically to avoid race conditions
      Promise.all([
        connection.send({ type: 'get_state', sessionId: event.sessionId }),
        connection.send({ type: 'get_messages', sessionId: event.sessionId }),
        connection.send({ type: 'get_session_meta', sessionId: event.sessionId }),
      ])
        .then(([stateRes, msgRes, metaRes]) => {
          const session = sessionRegistry.sessions[event.sessionId];
          if (!session) return;
          if (stateRes.success && stateRes.data) {
            const state = (stateRes.data as { state: SessionState }).state;
            session.model = state.model;
            session.thinkingLevel = state.thinkingLevel;
            session.isStreaming = state.isStreaming;
            session.isCompacting = state.isCompacting;
            session.autoCompactionEnabled = state.autoCompactionEnabled;
            session.messageCount = state.messageCount;
            session.status = state.isStreaming ? 'working' : 'idle';
          }
          if (msgRes.success && msgRes.data) {
            const messages = (msgRes.data as { messages: PimoteAgentMessage[] }).messages;
            session.messages = messages;
            session.messageCount = messages.length;
          }
          if (metaRes.success && metaRes.data) {
            const meta = (metaRes.data as { meta: SessionMeta }).meta;
            sessionRegistry.updateMeta(event.sessionId, meta);
          }
        })
        .catch((err) => {
          console.error('[SessionRegistry] Failed to fetch initial session state:', err);
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

// When a reconnect is rejected because another client owns the session, prompt user
connection.onSessionOwned = (sessionId) => {
  const session = sessionRegistry.sessions[sessionId];
  if (session) {
    session.pendingTakeover = true;
  }
};

// When a session is adopted via notification click, add it to the registry and switch to it
connection.onSessionAdopted = (sessionId, folderPath) => {
  const projectName = folderPath.split('/').pop() || 'Unknown';
  sessionRegistry.addSession(sessionId, folderPath, projectName);
  sessionRegistry.switchTo(sessionId);
  connection.send({ type: 'view_session', sessionId }).catch(() => {});
  // Request meta for git branch and context usage
  connection
    .send({ type: 'get_session_meta', sessionId })
    .then((metaRes) => {
      if (metaRes.success && metaRes.data) {
        sessionRegistry.updateMeta(sessionId, (metaRes.data as { meta: SessionMeta }).meta);
      }
    })
    .catch(() => {});
};

// After reconnect completes, restore the correct viewed session on the server
connection.onReconnected = () => {
  const viewedId = sessionRegistry.viewedSessionId;
  if (viewedId) {
    connection.send({ type: 'view_session', sessionId: viewedId }).catch(() => {});
  }
};

/** Confirm takeover — resend open_session with force:true */
export function confirmTakeover(sessionId: string): void {
  const session = sessionRegistry.sessions[sessionId];
  if (!session) return;
  session.pendingTakeover = false;
  connection
    .send({
      type: 'open_session',
      folderPath: session.folderPath,
      sessionId,
      force: true,
    })
    .then((response) => {
      if (!response.success) {
        // Force also failed — give up
        sessionRegistry.removeSession(sessionId);
        connection.removeSubscribedSession(sessionId);
      }
    })
    .catch(() => {
      sessionRegistry.removeSession(sessionId);
      connection.removeSubscribedSession(sessionId);
    });
}

/** Dismiss takeover — drop the session */
export function dismissTakeover(sessionId: string): void {
  sessionRegistry.removeSession(sessionId);
  connection.removeSubscribedSession(sessionId);
}

// Helper that also sends view_session to server
export function switchToSession(sessionId: string): void {
  sessionRegistry.switchTo(sessionId);
  connection.send({ type: 'view_session', sessionId }).catch(() => {});
}

/** Close a session — sends close_session command; the session_closed event handler cleans up the registry */
export function closeSession(sessionId: string): void {
  connection.send({ type: 'close_session', sessionId }).catch(() => {});
}

/** Open a new session in the same project as the given session */
export function newSessionInProject(sessionId: string): void {
  const session = sessionRegistry.sessions[sessionId];
  if (!session) return;
  connection.send({ type: 'open_session', folderPath: session.folderPath }).catch(() => {});
}
