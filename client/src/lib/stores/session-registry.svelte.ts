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
  StreamingMessage,
  SessionState,
  SessionMeta,
  BufferedEventsEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  FullResyncEvent,
  AgentEndEvent,
  SessionConflictEvent,
  SessionStateChangedEvent,
  SessionOpenedEvent,
  SessionRenamedEvent,
  SessionReplacedEvent,
  PanelUpdateEvent,
  SessionRestoreEvent,
  Card,
  RestoreMode,
} from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { commandStore } from './command-store.svelte.js';
import { panelStore } from './panel-store.svelte.js';
import { getActiveSessions, setActiveSessions, getViewedSessionId, setViewedSessionId } from './persistence.js';

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
  /** Server-provided list of thinking levels the current model supports. */
  availableThinkingLevels: string[];
  streamingMessage: StreamingMessage | null;
  streamingKey: string | null;
  messageKeys: string[];
  toolExecutions: Record<string, { name: string; args: unknown; partialResult: string; status: 'running' | 'completed'; result?: unknown; isError?: boolean }>;
  autoCompactionEnabled: boolean;
  messageCount: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
  conflictingProcesses: Array<{ pid: number; command: string }>;
  conflictingRemoteSessions: Array<{ sessionId: string; status: 'working' | 'idle' }>;
  pendingTakeover: boolean;
  gitBranch: string | null;
  sessionName: string | null;
  extensionTitle: string | null;
  restoreMode: RestoreMode | null;
  isRestoring: boolean;
  panelCards: Card[];
  widgetCards: Record<string, Card>;
  contextUsage: { percent: number | null; contextWindow: number } | null;
  draftText: string;
  pendingSteeringMessages: string[];
  lastBotActivityTimestamp: string | null;
  optimisticMessageKey: string | null;
}

export class SessionRegistry {
  sessions: Record<string, PerSessionState> = $state({});
  viewedSessionId: string | null = $state(null);
  /** Temporary ID of an optimistic "new session" placeholder awaiting server confirmation. */
  pendingNewSession: string | null = $state(null);
  private _nextMessageKey: number = 0;

  /** Generate stable keys for a batch of messages (used on initial load and resync) */
  generateMessageKeys(count: number): string[] {
    return Array.from({ length: count }, () => 'msg-' + this._nextMessageKey++);
  }

  /** Get the currently viewed session's state */
  get viewed(): PerSessionState | null {
    return this.sessions[this.viewedSessionId!] ?? null;
  }

  /** List all active sessions */
  get activeSessions(): PerSessionState[] {
    return Object.values(this.sessions);
  }

  private createSessionState(sessionId: string, folderPath: string, projectName: string): PerSessionState {
    return {
      sessionId,
      folderPath,
      projectName,
      firstMessage: undefined,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      model: null,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      streamingMessage: null,
      streamingKey: null,
      messageKeys: [],
      toolExecutions: {},
      autoCompactionEnabled: false,
      messageCount: 0,
      status: 'idle',
      needsAttention: false,
      conflictingProcesses: [],
      conflictingRemoteSessions: [],
      pendingTakeover: false,
      sessionName: null,
      extensionTitle: null,
      restoreMode: null,
      isRestoring: false,
      panelCards: [],
      widgetCards: {},
      gitBranch: null,
      contextUsage: null,
      draftText: '',
      pendingSteeringMessages: [],
      lastBotActivityTimestamp: null,
      optimisticMessageKey: null,
    };
  }

  firstUserMessage(messages: PimoteAgentMessage[]): string | undefined {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
      if (textContent?.text) return textContent.text;
    }
    return undefined;
  }

  private persistSessions(): void {
    setActiveSessions(
      Object.values(this.sessions)
        .filter((s) => !s.sessionId.startsWith('pending-'))
        .map((s) => ({ sessionId: s.sessionId, folderPath: s.folderPath })),
    );
  }

  private persistViewedSession(): void {
    // Don't persist a pending optimistic session as the viewed session
    if (this.viewedSessionId?.startsWith('pending-')) return;
    setViewedSessionId(this.viewedSessionId);
  }

  /** Add an optimistic user message so it renders immediately before the server round-trip */
  addOptimisticUserMessage(sessionId: string, text: string): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    const content: PimoteMessageContent[] = [];
    if (text) {
      content.push({ type: 'text', text });
    }

    const message: PimoteAgentMessage = { role: 'user', content };
    const key = 'msg-' + this._nextMessageKey++;
    session.messages = [...session.messages, message];
    session.messageKeys = [...session.messageKeys, key];
    session.optimisticMessageKey = key;
  }

  /** Route an incoming event to the correct session's state */
  handleEvent(event: PimoteEvent): void {
    const sessionId = 'sessionId' in event ? event.sessionId : undefined;

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

      case 'agent_end': {
        const endEvent = event as AgentEndEvent;
        session.status = 'idle';
        session.isStreaming = false;
        if (sessionId !== this.viewedSessionId) {
          session.needsAttention = true;
        }
        // Apply entry IDs so fork targets work on messages received via streaming
        if (endEvent.messageEntryIds) {
          const ids = endEvent.messageEntryIds;
          for (let i = 0; i < session.messages.length && i < ids.length; i++) {
            if (!session.messages[i].entryId) {
              session.messages[i].entryId = ids[i];
            }
          }
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
      }

      case 'message_start': {
        const start = event as MessageStartEvent;
        // Skip streaming placeholder when we already have an optimistic user message displayed
        if (start.role === 'user' && session.optimisticMessageKey) {
          break;
        }
        session.streamingKey = 'msg-' + this._nextMessageKey++;
        session.streamingMessage = { role: start.role, content: [] };
        break;
      }

      case 'message_update': {
        const update = event as MessageUpdateEvent;
        if (!session.streamingMessage) break;
        if (update.subtype === 'start') {
          const block: PimoteMessageContent = { type: update.content.type, text: '', streaming: true };
          if (update.content.type === 'tool_call') {
            block.toolCallId = update.toolCallId;
            block.toolName = update.toolName;
          }
          session.streamingMessage.content[update.contentIndex] = block;
        } else if (update.subtype === 'delta') {
          const block = session.streamingMessage.content[update.contentIndex];
          if (block) {
            block.text = (block.text ?? '') + update.content.text;
          }
        } else if (update.subtype === 'end') {
          const block = session.streamingMessage.content[update.contentIndex];
          if (block) {
            block.streaming = false;
          }
        }
        break;
      }

      case 'message_end': {
        const end = event as MessageEndEvent;
        const message: PimoteAgentMessage = end.message;

        if (message.role === 'user' && session.optimisticMessageKey) {
          // Replace the optimistic message with the real server message
          const idx = session.messageKeys.indexOf(session.optimisticMessageKey);
          if (idx !== -1) {
            const newMessages = [...session.messages];
            newMessages[idx] = message;
            session.messages = newMessages;
          }
          session.optimisticMessageKey = null;
          session.streamingMessage = null;
          session.streamingKey = null;
        } else {
          session.messages = [...session.messages, message];
          if (session.streamingKey) {
            session.messageKeys = [...session.messageKeys, session.streamingKey];
          }
          session.streamingMessage = null;
          session.streamingKey = null;
        }
        session.messageCount++;
        // Capture firstMessage from first user message
        if (message.role === 'user' && session.firstMessage === undefined) {
          const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
          if (textContent && textContent.text) {
            session.firstMessage = textContent.text;
          }
        }
        // Reconcile pending steering messages: when a user message is consumed,
        // find and remove the first text-matching entry from the optimistic list.
        if (message.role === 'user' && session.pendingSteeringMessages.length > 0) {
          const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
          if (textContent?.text) {
            const idx = session.pendingSteeringMessages.indexOf(textContent.text);
            if (idx !== -1) {
              session.pendingSteeringMessages.splice(idx, 1);
            }
          }
        }
        // toolResult messages carry the canonical completion data — update toolExecutions
        if (message.role === 'toolResult') {
          this.applyToolResults(session, message);
        }
        break;
      }

      case 'tool_execution_start': {
        const start = event as ToolExecutionStartEvent;
        session.toolExecutions[start.toolCallId] = {
          name: start.toolName,
          args: start.args,
          partialResult: '',
          status: 'running',
        };
        break;
      }

      case 'tool_execution_update': {
        const upd = event as ToolExecutionUpdateEvent;
        const call = session.toolExecutions[upd.toolCallId];
        if (call) {
          call.partialResult += upd.content;
        }
        break;
      }

      case 'tool_execution_end': {
        const end = event as ToolExecutionEndEvent;
        const call = session.toolExecutions[end.toolCallId];
        if (call) {
          call.status = 'completed';
          call.result = end.result;
          call.isError = end.isError;
        }
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
        const rebuilt = this.createSessionState(session.sessionId, session.folderPath, session.projectName);
        rebuilt.draftText = session.draftText;
        rebuilt.extensionTitle = session.extensionTitle;
        rebuilt.restoreMode = session.restoreMode;
        rebuilt.isRestoring = session.isRestoring;
        // Don't carry over panelCards — server will send panel_update if panels are active.
        // Carrying over stale cards causes ghost panels after agent teardown + reconnect.
        rebuilt.widgetCards = session.widgetCards;
        rebuilt.model = state.model;
        rebuilt.thinkingLevel = state.thinkingLevel;
        rebuilt.availableThinkingLevels = state.availableThinkingLevels ?? [];
        rebuilt.isStreaming = state.isStreaming;
        rebuilt.isCompacting = state.isCompacting;
        rebuilt.autoCompactionEnabled = state.autoCompactionEnabled;
        rebuilt.messageCount = state.messageCount;
        rebuilt.sessionName = state.sessionName ?? null;
        rebuilt.messages = messages;
        rebuilt.firstMessage = this.firstUserMessage(messages);
        rebuilt.status = state.isStreaming ? 'working' : 'idle';
        rebuilt.messageKeys = this.generateMessageKeys(messages.length);
        this.rebuildToolExecutions(rebuilt);
        this.sessions[sessionId] = rebuilt;
        break;
      }

      case 'session_restore': {
        const restore = event as SessionRestoreEvent;
        session.restoreMode = restore.status === 'started' ? restore.mode : null;
        session.isRestoring = restore.status === 'started';
        break;
      }

      case 'session_conflict': {
        const conflict = event as SessionConflictEvent;
        session.conflictingProcesses = conflict.processes;
        session.conflictingRemoteSessions = conflict.remoteSessions ?? [];
        break;
      }

      case 'session_state_changed': {
        const changed = event as SessionStateChangedEvent;
        if (changed.gitBranch !== undefined) {
          for (const candidate of Object.values(this.sessions)) {
            if (candidate.folderPath === changed.folderPath) {
              candidate.gitBranch = changed.gitBranch;
            }
          }
        }
        break;
      }

      case 'session_renamed': {
        session.sessionName = (event as SessionRenamedEvent).name;
        break;
      }

      case 'panel_update': {
        session.panelCards = (event as PanelUpdateEvent).cards;
        if (sessionId === this.viewedSessionId) {
          this.syncViewedPanelStore();
        }
        break;
      }
    }

    // Update last bot activity timestamp from server-side timestamp
    if ('timestamp' in event && typeof (event as Record<string, unknown>).timestamp === 'string') {
      session.lastBotActivityTimestamp = (event as Record<string, unknown>).timestamp as string;
    }
  }

  private combinedPanelCards(session: PerSessionState | null): Card[] {
    if (!session) return [];
    return [...session.panelCards, ...Object.values(session.widgetCards)];
  }

  syncViewedPanelStore(): void {
    panelStore.handlePanelUpdate(this.combinedPanelCards(this.viewed));
  }

  /** Add a session to the registry. If it already exists (e.g. takeover placeholder), resets it. */
  addSession(sessionId: string, folderPath: string, projectName: string): void {
    this.sessions[sessionId] = this.createSessionState(sessionId, folderPath, projectName);
    this.persistSessions();
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
      this.syncViewedPanelStore();
    }
    this.persistSessions();
    this.persistViewedSession();
  }

  /** Replace a session in-place — same slot in the registry, new session ID.
   *  Used when the underlying pi session resets (newSession, fork, switchSession). */
  replaceSession(oldSessionId: string, newSessionId: string, folderPath: string, projectName: string): void {
    const old = this.sessions[oldSessionId];
    if (!old) return;

    // Remove old entry, add new entry with clean state but same slot identity
    const { [oldSessionId]: _, ...rest } = this.sessions;
    const next = this.createSessionState(newSessionId, folderPath, projectName);
    next.model = old.model;
    next.thinkingLevel = old.thinkingLevel;
    next.availableThinkingLevels = old.availableThinkingLevels;
    next.autoCompactionEnabled = old.autoCompactionEnabled;
    next.gitBranch = old.gitBranch;
    rest[newSessionId] = next;
    this.sessions = rest;

    // If the old session was being viewed, view the new one
    if (this.viewedSessionId === oldSessionId) {
      this.viewedSessionId = newSessionId;
      this.syncViewedPanelStore();
    }
    this.persistSessions();
    this.persistViewedSession();
  }

  /** Switch viewed session, clears needsAttention for target */
  switchTo(sessionId: string): void {
    this.viewedSessionId = sessionId;
    const session = this.sessions[sessionId];
    if (session) {
      session.needsAttention = false;
    }
    this.syncViewedPanelStore();
    this.persistViewedSession();
  }

  /** Check if a session ID is currently active */
  isActiveSession(sessionId: string): boolean {
    return sessionId in this.sessions;
  }

  /** Update session meta (git branch, context usage) */
  updateMeta(sessionId: string, meta: SessionMeta): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    // Context usage is session-specific, but git branch is repository-level.
    // Keep branch labels in sync for all sessions under the same folder.
    session.contextUsage = meta.contextUsage;
    for (const candidate of Object.values(this.sessions)) {
      if (candidate.folderPath === session.folderPath) {
        candidate.gitBranch = meta.gitBranch;
      }
    }
  }

  /** Apply a toolResult message to toolExecutions — marks the tool as completed with its result */
  private applyToolResults(session: PerSessionState, message: PimoteAgentMessage): void {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolCallId) {
        const existing = session.toolExecutions[block.toolCallId];
        if (existing) {
          // Replace incrementally-accumulated data with canonical result
          existing.status = 'completed';
          existing.result = block.result;
          existing.isError = block.isError;
        } else {
          // Rehydration: no prior execution state, create from the result
          session.toolExecutions[block.toolCallId] = {
            name: block.toolName ?? 'unknown',
            args: undefined,
            partialResult: '',
            status: 'completed',
            result: block.result,
            isError: block.isError,
          };
        }
      }
    }
  }

  /** Rebuild toolExecutions from a full message history (for rehydration) */
  rebuildToolExecutions(session: PerSessionState): void {
    session.toolExecutions = {};
    for (const message of session.messages) {
      if (message.role === 'toolResult') {
        this.applyToolResults(session, message);
      }
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

async function fetchFullSessionData(sessionId: string): Promise<void> {
  try {
    const [stateRes, msgRes, metaRes, cmdsRes] = await Promise.all([
      connection.send({ type: 'get_state', sessionId }),
      connection.send({ type: 'get_messages', sessionId }),
      connection.send({ type: 'get_session_meta', sessionId }),
      connection.send({ type: 'get_commands', sessionId }),
    ]);

    const session = sessionRegistry.sessions[sessionId];
    if (!session) return;

    if (stateRes.success && stateRes.data) {
      const state = (stateRes.data as { state: SessionState }).state;
      session.model = state.model;
      session.thinkingLevel = state.thinkingLevel;
      session.availableThinkingLevels = state.availableThinkingLevels ?? [];
      session.isStreaming = state.isStreaming;
      session.isCompacting = state.isCompacting;
      session.autoCompactionEnabled = state.autoCompactionEnabled;
      session.messageCount = state.messageCount;
      session.sessionName = state.sessionName ?? null;
      session.status = state.isStreaming ? 'working' : 'idle';
    }

    if (msgRes.success && msgRes.data) {
      const messages = (msgRes.data as { messages: PimoteAgentMessage[] }).messages;
      session.messages = messages;
      session.messageKeys = sessionRegistry.generateMessageKeys(messages.length);
      session.messageCount = messages.length;
      session.firstMessage = sessionRegistry.firstUserMessage(messages);
      sessionRegistry.rebuildToolExecutions(session);
    }

    if (metaRes.success && metaRes.data) {
      const meta = (metaRes.data as { meta: SessionMeta }).meta;
      sessionRegistry.updateMeta(sessionId, meta);
    }

    if (cmdsRes.success && cmdsRes.data) {
      const commands = (cmdsRes.data as { commands: import('@pimote/shared').CommandInfo[] }).commands;
      commandStore.setCommands(sessionId, commands);
    }
  } catch (err) {
    console.error('[SessionRegistry] Failed to fetch full session data:', err);
  }
}

async function refreshSessionMetaAndCommands(sessionId: string): Promise<void> {
  try {
    const [metaRes, cmdsRes] = await Promise.all([connection.send({ type: 'get_session_meta', sessionId }), connection.send({ type: 'get_commands', sessionId })]);

    if (metaRes.success && metaRes.data) {
      sessionRegistry.updateMeta(sessionId, (metaRes.data as { meta: SessionMeta }).meta);
    }

    if (cmdsRes.success && cmdsRes.data) {
      const commands = (cmdsRes.data as { commands: import('@pimote/shared').CommandInfo[] }).commands;
      commandStore.setCommands(sessionId, commands);
    }
  } catch (err) {
    console.error('[SessionRegistry] Failed to refresh session meta/commands:', err);
  }
}

export async function openExistingSession(sessionId: string, folderPath: string, opts?: { force?: boolean; switchTo?: boolean }): Promise<boolean> {
  const projectName = folderPath.split('/').pop() || 'Unknown';
  const shouldSwitch = opts?.switchTo !== false;
  const alreadyTracked = !!sessionRegistry.sessions[sessionId];

  if (!alreadyTracked) {
    sessionRegistry.addSession(sessionId, folderPath, projectName);
  }
  connection.addSubscribedSession(sessionId, folderPath);

  if (shouldSwitch) {
    sessionRegistry.switchTo(sessionId);
  }

  try {
    const response = await connection.send({
      type: 'open_session',
      folderPath,
      sessionId,
      ...(opts?.force ? { force: true } : {}),
    });

    if (!response.success) {
      if (response.error === 'session_owned') {
        const session = sessionRegistry.sessions[sessionId];
        if (session) session.pendingTakeover = true;
        return false;
      }
      sessionRegistry.removeSession(sessionId);
      connection.removeSubscribedSession(sessionId);
      commandStore.removeSession(sessionId);
      return false;
    }

    await refreshSessionMetaAndCommands(sessionId);
    if (shouldSwitch) {
      connection.send({ type: 'view_session', sessionId }).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('[SessionRegistry] Failed to open existing session:', err);
    sessionRegistry.removeSession(sessionId);
    connection.removeSubscribedSession(sessionId);
    commandStore.removeSession(sessionId);
    return false;
  }
}

// Subscribe to connection events and route to the registry
connection.onEvent((event) => {
  switch (event.type) {
    case 'session_opened': {
      const folder = (event as SessionOpenedEvent).folder;
      const projectName = folder?.name ?? 'Unknown';

      // Reconcile optimistic session: replace the temp placeholder with the real ID
      const pendingId = sessionRegistry.pendingNewSession;
      if (pendingId && sessionRegistry.sessions[pendingId]) {
        sessionRegistry.pendingNewSession = null;
        sessionRegistry.replaceSession(pendingId, event.sessionId, folder?.path ?? '', projectName);
      } else {
        sessionRegistry.addSession(event.sessionId, folder?.path ?? '', projectName);
        sessionRegistry.switchTo(event.sessionId);
      }

      connection.addSubscribedSession(event.sessionId, folder?.path ?? '');
      fetchFullSessionData(event.sessionId);
      break;
    }
    case 'session_closed': {
      sessionRegistry.removeSession(event.sessionId);
      connection.removeSubscribedSession(event.sessionId);
      commandStore.removeSession(event.sessionId);
      break;
    }
    case 'session_replaced': {
      const replaced = event as SessionReplacedEvent;
      const folder = replaced.folder;
      const projectName = folder?.name ?? 'Unknown';
      sessionRegistry.replaceSession(replaced.oldSessionId, replaced.newSessionId, folder?.path ?? '', projectName);
      connection.removeSubscribedSession(replaced.oldSessionId);
      connection.addSubscribedSession(replaced.newSessionId, folder?.path ?? '');
      commandStore.removeSession(replaced.oldSessionId);
      fetchFullSessionData(replaced.newSessionId);
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

// When restoring/opening is rejected because another client owns the session, prompt user
connection.onSessionOwned = (sessionId) => {
  const session = sessionRegistry.sessions[sessionId];
  if (session) {
    session.pendingTakeover = true;
  }
};

connection.onPendingAdopt = (sessionId, folderPath) => {
  void openExistingSession(sessionId, folderPath, { force: true, switchTo: true });
};

// After restore completes, refresh per-session supplemental data and restore
// the correct viewed session on the server.
connection.onReconnected = () => {
  for (const session of sessionRegistry.activeSessions) {
    if (session.sessionId.startsWith('pending-')) continue;
    void refreshSessionMetaAndCommands(session.sessionId);
  }
  const viewedId = sessionRegistry.viewedSessionId;
  if (viewedId && !viewedId.startsWith('pending-')) {
    connection.send({ type: 'view_session', sessionId: viewedId }).catch(() => {});
  }
};

// Hydrate persisted sessions before first connection
const persistedSessions = getActiveSessions();
const persistedViewedId = getViewedSessionId();

for (const { sessionId, folderPath } of persistedSessions) {
  const projectName = folderPath.split('/').pop() || 'Unknown';
  sessionRegistry.addSession(sessionId, folderPath, projectName);
  connection.addSubscribedSession(sessionId, folderPath);
}

if (persistedViewedId && sessionRegistry.sessions[persistedViewedId]) {
  sessionRegistry.viewedSessionId = persistedViewedId;
}

/** Confirm takeover — resend open_session with force:true */
export function confirmTakeover(sessionId: string): void {
  const session = sessionRegistry.sessions[sessionId];
  if (!session) return;
  session.pendingTakeover = false;
  void openExistingSession(sessionId, session.folderPath, { force: true, switchTo: true });
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
  // Guard: ignore if there's already a pending optimistic session
  if (sessionRegistry.pendingNewSession) return;

  // Optimistic UI: create a placeholder session and switch to it immediately
  // so the user sees an empty chat window without waiting for the server.
  const tempId = `pending-${crypto.randomUUID()}`;
  sessionRegistry.addSession(tempId, session.folderPath, session.projectName);
  sessionRegistry.switchTo(tempId);
  sessionRegistry.pendingNewSession = tempId;

  connection
    .send({ type: 'open_session', folderPath: session.folderPath })
    .then((response) => {
      if (!response.success) {
        // Server rejected — clean up the placeholder
        if (sessionRegistry.pendingNewSession === tempId) {
          sessionRegistry.pendingNewSession = null;
        }
        sessionRegistry.removeSession(tempId);
      }
      // On success the session_opened event (which arrives before this response)
      // has already reconciled the placeholder — nothing more to do here.
    })
    .catch(() => {
      // WebSocket error — clean up the placeholder
      if (sessionRegistry.pendingNewSession === tempId) {
        sessionRegistry.pendingNewSession = null;
      }
      sessionRegistry.removeSession(tempId);
    });
}
