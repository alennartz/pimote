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
  AutoRetryEndEvent,
  SessionConflictEvent,
  SessionStateChangedEvent,
  SessionOpenedEvent,
  SessionRenamedEvent,
  SessionReplacedEvent,
  PanelUpdateEvent,
  DownloadItem,
  DownloadUpdateEvent,
  NavigateEvent,
  SessionRestoreEvent,
  Card,
  RestoreMode,
  BashResult,
  BashExecutionUpdateEvent,
} from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { commandStore } from './command-store.svelte.js';
import { panelStore } from './panel-store.svelte.js';
import { downloadUi } from './download-ui.svelte.js';
import { coordinateDownloadUpdate } from '../download-coordinator.js';
import { handleDownloadNotificationIntent, type DownloadNotificationIntent } from '../download-notification-intent.js';
import { getActiveSessions, setActiveSessions, getViewedSessionId, setViewedSessionId } from './persistence.js';

/** Maximum UTF-8 bytes retained from live bash deltas per execution. */
export const MAX_BASH_LIVE_OUTPUT_BYTES = 256 * 1024;

const bashTextEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return bashTextEncoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  // Every UTF-16 code unit consumes at least one UTF-8 byte. Avoid encoding a
  // potentially enormous delta just to discover that it exceeds the budget.
  if (value.length <= maxBytes && utf8ByteLength(value) <= maxBytes) return value;

  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Append a live delta without allowing the transient browser buffer to grow unbounded. */
function appendBoundedBashOutput(current: string, delta: string, maxBytes: number): { output: string; bytes: number; truncated: boolean } {
  const currentBytes = utf8ByteLength(current);
  if (currentBytes >= maxBytes) {
    const boundedCurrent = currentBytes > maxBytes ? truncateUtf8(current, maxBytes) : current;
    return { output: boundedCurrent, bytes: utf8ByteLength(boundedCurrent), truncated: delta.length > 0 || boundedCurrent !== current };
  }

  const available = maxBytes - currentBytes;
  // A delta with more code units than the remaining byte budget cannot fit;
  // avoid allocating a full encoded copy for that common high-volume case.
  const deltaBytes = delta.length <= available ? utf8ByteLength(delta) : available + 1;
  if (deltaBytes <= available) {
    return { output: current + delta, bytes: currentBytes + deltaBytes, truncated: false };
  }

  // Find the largest UTF-8-safe prefix of this delta that fits the remaining
  // budget. Binary search avoids repeatedly copying the entire output string.
  let low = 0;
  let high = Math.min(delta.length, available);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(delta.slice(0, middle)) <= available) low = middle;
    else high = middle - 1;
  }
  const prefix = delta.slice(0, low);
  return {
    output: current + prefix,
    bytes: currentBytes + utf8ByteLength(prefix),
    truncated: true,
  };
}

export interface BashExecutionState {
  id: string;
  command: string;
  excludeFromContext: boolean;
  output: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  result?: BashResult;
  /** True when live output was capped before the native result arrived. */
  outputTruncated?: boolean;
  /** Dispatch failure distinct from a native nonzero exit or cancellation. */
  error?: string;
}

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
  /** Transient native bash executions keyed by caller-owned command ID. */
  bashExecutions: Record<string, BashExecutionState>;
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
  /** Pending user-approved file downloads offered for this session. */
  downloads: DownloadItem[];
  widgetCards: Record<string, Card>;
  contextUsage: { percent: number | null; contextWindow: number } | null;
  /** Total USD cost summed over the session branch; 0 when no spend. */
  lifetimeCostUsd: number;
  /** Lower-bound USD cost of the next round trip (context re-sent at cache-read rate); null when unknown. */
  nextRoundtripCostUsd: number | null;
  draftText: string;
  pendingSteeringMessages: string[];
  lastBotActivityTimestamp: string | null;
  optimisticMessageKey: string | null;
}

export class SessionRegistry {
  /** Receives typed updates after their owning session snapshot has been reduced. */
  constructor(private readonly onDownloadUpdate?: (event: DownloadUpdateEvent) => void) {}

  sessions: Record<string, PerSessionState> = $state({});
  viewedSessionId: string | null = $state(null);
  /** Temporary ID of an optimistic "new session" placeholder awaiting server confirmation. */
  pendingNewSession: string | null = $state(null);
  private _nextMessageKey: number = 0;
  // Byte accounting lives outside the reactive execution object so the public
  // state shape stays focused on rendering and existing callers remain stable.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal accounting, not UI state
  private bashOutputBytes = new Map<string, number>();

  private bashOutputKey(sessionId: string, executionId: string): string {
    return `${sessionId}\u0000${executionId}`;
  }

  private clearBashOutputBytes(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.bashOutputBytes.keys()) {
      if (key.startsWith(prefix)) this.bashOutputBytes.delete(key);
    }
  }

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
      bashExecutions: {},
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
      downloads: [],
      widgetCards: {},
      gitBranch: null,
      contextUsage: null,
      lifetimeCostUsd: 0,
      nextRoundtripCostUsd: null,
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

      case 'auto_retry_end': {
        // success:true is followed immediately by a fresh agent_start for the
        // retried attempt — no-op so the working state doesn't flicker.
        // success:false is the terminal signal we get when a retry is
        // user-aborted during the backoff sleep: the SDK fires no subsequent
        // agent_end in that path (the prior agent_end already went out as
        // willRetry:true, which we intentionally ignored). Without handling
        // this here, isStreaming would stay true forever and the Abort button
        // would appear to do nothing. Treat success:false as terminal.
        const retryEvent = event as AutoRetryEndEvent;
        if (retryEvent.success) break;
        session.status = 'idle';
        session.isStreaming = false;
        session.streamingMessage = null;
        session.streamingKey = null;
        if (sessionId !== this.viewedSessionId) {
          session.needsAttention = true;
        }
        break;
      }

      case 'agent_settled': {
        // Authoritative idle boundary: raised only when the session is genuinely
        // quiescent (no active run, retry, auto-compaction, or queued
        // continuation). This — not the terminal `agent_end` — drives the idle
        // status transition, so the UI stays "working" continuously through a
        // retry, compaction, or queued follow-up instead of flickering
        // working→idle→working. Content cleanup (clearing the stray streaming
        // placeholder, entry IDs, meta) happens on `agent_end` below.
        session.status = 'idle';
        session.isStreaming = false;
        // Native recordBashResult() defers persistence while the model is
        // streaming. Promote those completed transient entries only after the
        // SDK's settled boundary, preserving assistant/message ordering.
        this.flushCompletedBash(sessionId);
        if (sessionId !== this.viewedSessionId) {
          session.needsAttention = true;
        }
        break;
      }

      case 'agent_end': {
        const endEvent = event as AgentEndEvent;
        // A `willRetry` agent_end is not a real end — the SDK detected a
        // retryable error and will re-run the prompt after backoff (a fresh
        // agent_start follows). Skipping it avoids dropping the in-flight
        // streaming message mid-retry. The idle status transition is driven by
        // `agent_settled`, not here — this branch only does per-attempt content
        // cleanup for a genuine (non-retry) end.
        if (endEvent.willRetry) break;
        // Clear any in-flight streaming message. The SDK does not emit message_end
        // for a partial message when a run ends abnormally (e.g. user abort during a
        // thinking block), so without this the streaming placeholder would linger
        // indefinitely and the UI would continue to look "streaming".
        session.streamingMessage = null;
        session.streamingKey = null;
        // Apply entry IDs so fork targets work on messages received via streaming.
        //
        // Same alignment subtlety as server/src/message-mapper.ts::applyEntryIds:
        // agent.state.messages on the server side includes pi-agent-core's
        // synthetic aborted-assistant placeholders (abort pushes an empty
        // assistant into state but never persists an entry). messageEntryIds
        // comes from persisted entries and therefore doesn't include those
        // placeholders. Skip aborted-empty messages so IDs land on the right
        // real messages. Without this, every barge-in shifts subsequent
        // entryIds one slot earlier, breaking fork / tree navigation targeting.
        if (endEvent.messageEntryIds) {
          const ids = endEvent.messageEntryIds;
          let idIdx = 0;
          for (let i = 0; i < session.messages.length && idIdx < ids.length; i++) {
            const msg = session.messages[i];
            const isAbortedPlaceholder = msg.role === 'assistant' && msg.aborted === true && msg.content.every((c) => c.type === 'text' && !c.text);
            if (isAbortedPlaceholder) continue;
            if (!msg.entryId) {
              msg.entryId = ids[idIdx];
            }
            idIdx++;
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
          // Always append a key in lockstep with messages. If streamingKey is
          // null here (e.g. agent_end cleared it before message_end, or
          // message_end arrived without a preceding message_start), falling
          // through without a key would desync messages/messageKeys by 1 and
          // poison this session — every subsequent optimistic-user reconcile
          // would resolve to the wrong index, clobbering the previous
          // assistant message and duplicating the user message in the UI.
          const key = session.streamingKey ?? 'msg-' + this._nextMessageKey++;
          if (!session.streamingKey) {
            console.error('[session-desync] message_end without streamingKey', {
              sessionId,
              cursor: end.cursor,
              role: message.role,
              messagesLen: session.messages.length,
              keysLen: session.messageKeys.length,
            });
          }
          session.messageKeys = [...session.messageKeys, key];
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

      case 'bash_execution_update': {
        this.updateBash(sessionId, event as BashExecutionUpdateEvent);
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
        this.clearBashOutputBytes(sessionId);
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

      case 'download_update': {
        const update = event as DownloadUpdateEvent;
        // Every update is a complete replacement snapshot. Copy the array so
        // subsequent protocol-object mutation cannot leak into this session's
        // reactive state, then notify presentation after reduction so it can
        // inspect the authoritative pending list.
        session.downloads = [...update.downloads];
        this.onDownloadUpdate?.(update);
        break;
      }

      case 'pimote_navigate': {
        // Only honor navigation for the currently viewed session — don't
        // yank the user away if a background session emits this.
        if (sessionId === this.viewedSessionId) {
          const url = (event as NavigateEvent).url;
          if (typeof url === 'string' && url.length > 0) {
            location.href = url;
          }
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
    this.clearBashOutputBytes(sessionId);
    this.sessions[sessionId] = this.createSessionState(sessionId, folderPath, projectName);
    this.persistSessions();
  }

  /** Remove a session from the registry */
  removeSession(sessionId: string): void {
    this.clearBashOutputBytes(sessionId);
    // A session removal has no download_update event to reconcile against;
    // explicitly drop any queued one-shot actions owned by that session.
    downloadUi.clearSession(sessionId);
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

    // A reset/replacement creates a new session identity and does not migrate
    // one-shot registrations or their actionable toasts.
    this.clearBashOutputBytes(oldSessionId);
    this.clearBashOutputBytes(newSessionId);
    downloadUi.clearSession(oldSessionId);

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

  /** Update session meta (git branch, context usage, lifetime cost) */
  updateMeta(sessionId: string, meta: SessionMeta): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    // Context usage and lifetime cost are session-specific, but git branch is
    // repository-level. Keep branch labels in sync for all sessions under the
    // same folder.
    session.contextUsage = meta.contextUsage;
    session.lifetimeCostUsd = meta.lifetimeCostUsd;
    session.nextRoundtripCostUsd = meta.nextRoundtripCostUsd;
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

  /** Begin tracking a caller-owned native bash execution. */
  startBash(sessionId: string, execution: Pick<BashExecutionState, 'id' | 'command' | 'excludeFromContext'>): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    this.bashOutputBytes.set(this.bashOutputKey(sessionId, execution.id), 0);
    session.bashExecutions = {
      ...session.bashExecutions,
      [execution.id]: {
        id: execution.id,
        command: execution.command,
        excludeFromContext: execution.excludeFromContext,
        output: '',
        status: 'running',
      },
    };
  }

  /** Apply one live SDK bash output update to its transient execution. */
  updateBash(sessionId: string, update: Pick<BashExecutionUpdateEvent, 'id' | 'delta'>): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    let targetId = update.id;
    if (!targetId) {
      const runningIds = Object.values(session.bashExecutions)
        .filter((execution) => execution.status === 'running')
        .map((execution) => execution.id);
      if (runningIds.length !== 1) return;
      targetId = runningIds[0];
    }

    const execution = session.bashExecutions[targetId];
    if (!execution || execution.status !== 'running') return;

    const outputKey = this.bashOutputKey(sessionId, targetId);
    const bounded = appendBoundedBashOutput(execution.output, update.delta, MAX_BASH_LIVE_OUTPUT_BYTES);
    this.bashOutputBytes.set(outputKey, bounded.bytes);
    session.bashExecutions = {
      ...session.bashExecutions,
      [targetId]: {
        ...execution,
        output: bounded.output,
        ...(execution.outputTruncated || bounded.truncated ? { outputTruncated: true } : {}),
      },
    };
  }

  private appendBashMessage(session: PerSessionState, execution: BashExecutionState, result: BashResult): void {
    const message: PimoteAgentMessage = {
      role: 'bashExecution',
      content: [{ type: 'text', text: `$ ${execution.command}\n${result.output}` }],
      command: execution.command,
      output: result.output,
      cancelled: result.cancelled,
      truncated: result.truncated,
      excludeFromContext: execution.excludeFromContext,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.fullOutputPath !== undefined ? { fullOutputPath: result.fullOutputPath } : {}),
    };

    const key = 'msg-' + this._nextMessageKey++;
    session.messages = [...session.messages, message];
    session.messageKeys = [...session.messageKeys, key];
    session.messageCount++;
  }

  /** Promote completed entries once the SDK's model turn has settled. */
  private flushCompletedBash(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (!session || session.isStreaming) return;

    const completed = Object.values(session.bashExecutions).filter((execution) => execution.status === 'complete' || execution.status === 'cancelled');
    if (completed.length === 0) return;

    const remaining = { ...session.bashExecutions };
    for (const execution of completed) {
      if (!execution.result) continue;
      this.appendBashMessage(session, execution, execution.result);
      delete remaining[execution.id];
      this.bashOutputBytes.delete(this.bashOutputKey(sessionId, execution.id));
    }
    session.bashExecutions = remaining;
  }

  /** Promote a successful native result to the message list and remove its transient state. */
  completeBash(sessionId: string, id: string, result: BashResult): void {
    const session = this.sessions[sessionId];
    const execution = session?.bashExecutions[id];
    if (!session || !execution) return;

    // If the model is still streaming, retain a completed transient entry until
    // agent_settled. Pi queues the native history entry until that same boundary;
    // appending it now would place it before the active assistant message and
    // shift positional fork targets.
    const completed: BashExecutionState = {
      ...execution,
      output: result.output,
      status: result.cancelled ? 'cancelled' : 'complete',
      result,
      ...(execution.outputTruncated ? { outputTruncated: false } : {}),
    };
    if (session.isStreaming) {
      session.bashExecutions = { ...session.bashExecutions, [id]: completed };
      return;
    }

    this.appendBashMessage(session, completed, result);
    const { [id]: _removed, ...remaining } = session.bashExecutions;
    session.bashExecutions = remaining;
    this.bashOutputBytes.delete(this.bashOutputKey(sessionId, id));
  }

  /** Retain a failed dispatch as a visible, non-context transient entry. */
  failBash(sessionId: string, id: string, error: string): void {
    const session = this.sessions[sessionId];
    const execution = session?.bashExecutions[id];
    if (!session || !execution) return;

    session.bashExecutions = {
      ...session.bashExecutions,
      [id]: {
        ...execution,
        status: 'error',
        error,
      },
    };
  }

  /** Drop transient bash state, e.g. after a full resync or session close. */
  clearBash(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (!session) return;
    this.clearBashOutputBytes(sessionId);
    session.bashExecutions = {};
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
export const sessionRegistry = new SessionRegistry((event) => {
  coordinateDownloadUpdate(event, downloadUi);
});

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

export interface AppNotificationIntent {
  sessionId: string;
  folderPath?: string;
  openDownloads?: boolean;
}

function queueDownloadNotificationIntent(intent: DownloadNotificationIntent): void {
  const folderPath = intent.folderPath ?? sessionRegistry.sessions[intent.sessionId]?.folderPath;
  if (!folderPath) return;

  // Keep the intent in the connection layer until a socket is open and all
  // existing subscriptions have been restored. This avoids adding/removing a
  // temporary session when a notification click lands during reconnect.
  connection.pendingAdopt = {
    sessionId: intent.sessionId,
    folderPath,
    openDownloads: true,
  };
  connection.connect();
}

/**
 * Route every OS notification click through one app-level adapter. Download
 * intents open only the owning session's inbox; ordinary notifications retain
 * their existing session-switch/adopt behavior.
 */
export async function routeNotificationIntent(intent: AppNotificationIntent): Promise<void> {
  if (intent.openDownloads === true) {
    const downloadIntent: DownloadNotificationIntent = {
      sessionId: intent.sessionId,
      ...(intent.folderPath ? { folderPath: intent.folderPath } : {}),
      openDownloads: true,
    };

    // A focused existing window can be in backoff or mid-restore. Queue the
    // inbox intent instead of attempting open_session over a dead socket.
    if (!connection.ready) {
      queueDownloadNotificationIntent(downloadIntent);
      return;
    }

    await handleDownloadNotificationIntent(downloadIntent, {
      hasSession: (sessionId) => sessionRegistry.isActiveSession(sessionId),
      switchToSession,
      openExistingSession: (sessionId, folderPath) => openExistingSession(sessionId, folderPath, { force: true, switchTo: true }),
      openDownloadInbox: (sessionId) => downloadUi.openDownloadInbox(sessionId),
    });

    // The socket may have dropped during the adoption request. Preserve the
    // intent for the next successful restore rather than losing the click.
    if (!connection.ready && !sessionRegistry.isActiveSession(intent.sessionId)) {
      queueDownloadNotificationIntent(downloadIntent);
    }
    return;
  }

  if (sessionRegistry.isActiveSession(intent.sessionId)) {
    switchToSession(intent.sessionId);
    return;
  }

  if (intent.folderPath) {
    await openExistingSession(intent.sessionId, intent.folderPath, { force: true, switchTo: true });
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
      // Only tear down registry state for a session WE just added here. If the
      // session was already open (takeover/notification-adopt path), a transient
      // failure must not wipe the user's tab, draft, or pending steering — the
      // reconnect cycle retries restores.
      if (!alreadyTracked) {
        sessionRegistry.removeSession(sessionId);
        connection.removeSubscribedSession(sessionId);
        commandStore.removeSession(sessionId);
      }
      return false;
    }

    await refreshSessionMetaAndCommands(sessionId);
    if (shouldSwitch) {
      connection.send({ type: 'view_session', sessionId }).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('[SessionRegistry] Failed to open existing session:', err);
    if (!alreadyTracked) {
      sessionRegistry.removeSession(sessionId);
      connection.removeSubscribedSession(sessionId);
      commandStore.removeSession(sessionId);
    }
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

connection.onPendingAdopt = (sessionId, folderPath, { openDownloads }) => {
  void routeNotificationIntent({
    sessionId,
    folderPath,
    ...(openDownloads ? { openDownloads: true } : {}),
  });
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
