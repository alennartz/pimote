// ============================================================================
// Pimote Wire Protocol Types
// All WebSocket messages between client and server.
// Self-contained — no imports from the pi SDK.
// ============================================================================

// ----------------------------------------------------------------------------
// Shared Data Types
// ----------------------------------------------------------------------------

export interface FolderInfo {
  path: string;
  name: string;
  activeSessionCount: number;
  externalProcessCount: number;
  /** @deprecated Client derives status from per-session data. Will be removed. */
  activeStatus?: 'working' | 'idle' | 'attention' | null;
}

export interface SessionInfo {
  id: string;
  name?: string;
  /** ISO 8601 date string */
  created: string;
  /** ISO 8601 date string */
  modified: string;
  messageCount: number;
  firstMessage?: string;
  /** Whether this session is owned by the requesting client */
  isOwnedByMe?: boolean;
  /** Live status if this is an active in-memory session, null otherwise */
  liveStatus?: 'working' | 'idle' | null;
}

export interface SessionState {
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile: string | undefined;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
}

// ----------------------------------------------------------------------------
// Simplified AgentMessage (JSON-serializable, no pi SDK dependency)
// ----------------------------------------------------------------------------

export interface PimoteMessageContent {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  /** True while this content block is still receiving streaming deltas. Only set on StreamingMessage blocks. */
  streaming?: boolean;
}

export interface PimoteAgentMessage {
  role: string;
  content: PimoteMessageContent[];
  /** Present when role === 'custom' — the extension-defined message type (e.g. 'agent-complete') */
  customType?: string;
  [key: string]: unknown;
}

// ----------------------------------------------------------------------------
// Client → Server Commands
// ----------------------------------------------------------------------------

interface CommandBase {
  /** Correlation ID for request/response matching */
  id?: string;
  /** Target session (required for session-scoped commands) */
  sessionId?: string;
}

// -- Session control commands --

export interface PromptCommand extends CommandBase {
  type: 'prompt';
  message: string;
  images?: string[];
  streamingBehavior?: 'streaming' | 'blocking';
}

export interface SteerCommand extends CommandBase {
  type: 'steer';
  message: string;
}

export interface FollowUpCommand extends CommandBase {
  type: 'follow_up';
  message: string;
}

export interface AbortCommand extends CommandBase {
  type: 'abort';
}

export interface SetModelCommand extends CommandBase {
  type: 'set_model';
  provider: string;
  modelId: string;
}

export interface CycleModelCommand extends CommandBase {
  type: 'cycle_model';
}

export interface GetAvailableModelsCommand extends CommandBase {
  type: 'get_available_models';
}

export interface SetThinkingLevelCommand extends CommandBase {
  type: 'set_thinking_level';
  level: string;
}

export interface CycleThinkingLevelCommand extends CommandBase {
  type: 'cycle_thinking_level';
}

export interface CompactCommand extends CommandBase {
  type: 'compact';
  customInstructions?: string;
}

export interface SetAutoCompactionCommand extends CommandBase {
  type: 'set_auto_compaction';
  enabled: boolean;
}

export interface GetStateCommand extends CommandBase {
  type: 'get_state';
}

export interface GetMessagesCommand extends CommandBase {
  type: 'get_messages';
}

export interface NewSessionCommand extends CommandBase {
  type: 'new_session';
}

export interface GetSessionStatsCommand extends CommandBase {
  type: 'get_session_stats';
}

export interface GetSessionMetaCommand extends CommandBase {
  type: 'get_session_meta';
}

export interface SessionMeta {
  gitBranch: string | null;
  contextUsage: {
    percent: number | null;
    contextWindow: number;
  } | null;
}

export interface GetCommandsCommand extends CommandBase {
  type: 'get_commands';
}

export interface CompleteArgsCommand extends CommandBase {
  type: 'complete_args';
  commandName: string;
  prefix: string;
}

// -- Command / autocomplete response shapes --

export interface CommandInfo {
  name: string;
  description: string;
  hasArgCompletions: boolean;
}

export interface AutocompleteResponseItem {
  value: string;
  label: string;
  description?: string;
}

export interface SetSessionNameCommand extends CommandBase {
  type: 'set_session_name';
  name: string;
}

export interface DequeueSteeringCommand extends CommandBase {
  type: 'dequeue_steering';
}

// -- Server-level commands --

export interface ListFoldersCommand extends CommandBase {
  type: 'list_folders';
}

export interface ListSessionsCommand extends CommandBase {
  type: 'list_sessions';
  folderPath: string;
}

export interface OpenSessionCommand extends CommandBase {
  type: 'open_session';
  folderPath: string;
  sessionId?: string;
  /** Force takeover if the session is owned by another client */
  force?: boolean;
}

export interface CloseSessionCommand extends CommandBase {
  type: 'close_session';
}

export interface TakeoverFolderCommand extends CommandBase {
  type: 'takeover_folder';
  folderPath: string;
}

export interface ReconnectCommand extends CommandBase {
  type: 'reconnect';
  sessionId: string;
  lastCursor: number;
}

export interface ViewSessionCommand extends CommandBase {
  type: 'view_session';
  sessionId: string;
}

// -- Push notification commands --

export interface RegisterPushCommand extends CommandBase {
  type: 'register_push';
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

export interface UnregisterPushCommand extends CommandBase {
  type: 'unregister_push';
  endpoint: string;
}

// -- Session conflict commands --

export interface KillConflictingProcessesCommand extends CommandBase {
  type: 'kill_conflicting_processes';
  sessionId: string;
  pids: number[];
}

export interface KillConflictingSessionsCommand extends CommandBase {
  type: 'kill_conflicting_sessions';
  sessionIds: string[];
}

// -- Extension UI commands --

export interface ExtensionUiResponseCommand extends CommandBase {
  type: 'extension_ui_response';
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

// -- Discriminated union --

export type PimoteCommand =
  // Session control
  | PromptCommand
  | SteerCommand
  | FollowUpCommand
  | AbortCommand
  | SetModelCommand
  | CycleModelCommand
  | GetAvailableModelsCommand
  | SetThinkingLevelCommand
  | CycleThinkingLevelCommand
  | CompactCommand
  | SetAutoCompactionCommand
  | GetStateCommand
  | GetMessagesCommand
  | NewSessionCommand
  | GetSessionStatsCommand
  | GetSessionMetaCommand
  | GetCommandsCommand
  | CompleteArgsCommand
  | SetSessionNameCommand
  | DequeueSteeringCommand
  // Server-level
  | ListFoldersCommand
  | ListSessionsCommand
  | OpenSessionCommand
  | CloseSessionCommand
  | TakeoverFolderCommand
  | ReconnectCommand
  | ViewSessionCommand
  // Push notifications
  | RegisterPushCommand
  | UnregisterPushCommand
  // Session conflict
  | KillConflictingProcessesCommand
  | KillConflictingSessionsCommand
  // Extension UI
  | ExtensionUiResponseCommand;

// ----------------------------------------------------------------------------
// Server → Client Events
// ----------------------------------------------------------------------------

interface SessionEventBase {
  /** Which session produced this event */
  sessionId: string;
  /** Monotonically increasing cursor for reconnect replay */
  cursor: number;
}

// -- Agent lifecycle events --

export interface AgentStartEvent extends SessionEventBase {
  type: 'agent_start';
}

export interface AgentEndEvent extends SessionEventBase {
  type: 'agent_end';
  error?: string;
}

export interface TurnStartEvent extends SessionEventBase {
  type: 'turn_start';
}

export interface TurnEndEvent extends SessionEventBase {
  type: 'turn_end';
}

// -- Message streaming events --

export interface MessageStartEvent extends SessionEventBase {
  type: 'message_start';
  role: string;
}

export interface MessageUpdateEvent extends SessionEventBase {
  type: 'message_update';
  contentIndex: number;
  subtype: 'start' | 'delta' | 'end';
  content: { type: 'text' | 'thinking' | 'tool_call'; text: string };
  /** Present only on tool_call start */
  toolCallId?: string;
  /** Present only on tool_call start */
  toolName?: string;
}

/**
 * Shape shared by both streaming (in-progress) and finalized messages.
 * The streaming message uses this during accumulation; on message_end
 * the finalized PimoteAgentMessage replaces it.
 */
export interface StreamingMessage {
  role: string;
  content: PimoteMessageContent[];
  customType?: string;
}

export interface MessageEndEvent extends SessionEventBase {
  type: 'message_end';
  message: PimoteAgentMessage;
}

// -- Tool execution events --

export interface ToolExecutionStartEvent extends SessionEventBase {
  type: 'tool_execution_start';
  toolName: string;
  toolCallId: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent extends SessionEventBase {
  type: 'tool_execution_update';
  toolCallId: string;
  content: string;
}

export interface ToolExecutionEndEvent extends SessionEventBase {
  type: 'tool_execution_end';
  toolCallId: string;
  result: unknown;
}

// -- Auto-compaction events --

export interface AutoCompactionStartEvent extends SessionEventBase {
  type: 'auto_compaction_start';
  reason: 'threshold' | 'overflow';
}

export interface AutoCompactionEndEvent extends SessionEventBase {
  type: 'auto_compaction_end';
  result: unknown;
  aborted: boolean;
  willRetry: boolean;
  errorMessage?: string;
}

// -- Auto-retry events --

export interface AutoRetryStartEvent extends SessionEventBase {
  type: 'auto_retry_start';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface AutoRetryEndEvent extends SessionEventBase {
  type: 'auto_retry_end';
  success: boolean;
  attempt: number;
  finalError?: string;
}

// -- Extension error --

export interface ExtensionErrorEvent extends SessionEventBase {
  type: 'extension_error';
  error: string;
  extensionName?: string;
}

/** All session-scoped events (mirror of pi SDK's AgentSessionEvent) */
export type PimoteSessionEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | AutoCompactionStartEvent
  | AutoCompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | ExtensionErrorEvent;

// -- Session conflict events --

export interface SessionConflictEvent {
  type: 'session_conflict';
  sessionId: string;
  processes: Array<{ pid: number; command: string }>;
  remoteSessions?: Array<{
    sessionId: string;
    status: 'working' | 'idle';
  }>;
}

// -- Extension UI request events --

export interface ExtensionUiRequestEvent {
  type: 'extension_ui_request';
  sessionId: string;
  requestId: string;
  method: string;
  /** Method-specific fields (e.g., prompt text, options, etc.) */
  [key: string]: unknown;
}

// -- Server-level events --

export interface SessionOpenedEvent {
  type: 'session_opened';
  sessionId: string;
  folder: FolderInfo;
}

export interface SessionClosedEvent {
  type: 'session_closed';
  sessionId: string;
  reason?: 'displaced' | 'killed' | 'replaced';
}

export interface SessionReplacedEvent {
  type: 'session_replaced';
  oldSessionId: string;
  newSessionId: string;
  folder: FolderInfo;
}

export interface SessionStateChangedEvent {
  type: 'session_state_changed';
  sessionId: string;
  folderPath: string;
  liveStatus: 'working' | 'idle' | null;
  connectedClientId: string | null;
  folderActiveSessionCount: number;
  folderActiveStatus: 'working' | 'idle' | 'attention' | null;
}

export interface ConnectionRestoredEvent {
  type: 'connection_restored';
  sessionId: string;
}

export interface BufferedEventsEvent {
  type: 'buffered_events';
  sessionId: string;
  events: PimoteSessionEvent[];
}

export interface FullResyncEvent {
  type: 'full_resync';
  sessionId: string;
  state: SessionState;
  messages: PimoteAgentMessage[];
}

// -- Version mismatch --

export interface VersionMismatchEvent {
  type: 'version_mismatch';
  serverVersion: string;
}

// -- Discriminated union --

export type PimoteEvent =
  // Session events
  | PimoteSessionEvent
  // Extension UI
  | ExtensionUiRequestEvent
  // Session conflict
  | SessionConflictEvent
  // Server-level
  | SessionOpenedEvent
  | SessionClosedEvent
  | SessionReplacedEvent
  | SessionStateChangedEvent
  | ConnectionRestoredEvent
  | BufferedEventsEvent
  | FullResyncEvent
  // Version
  | VersionMismatchEvent;

// ----------------------------------------------------------------------------
// Server → Client Responses (request/response pattern)
// ----------------------------------------------------------------------------

export interface PimoteResponse<T = unknown> {
  /** Matches the `id` from the originating PimoteCommand */
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

// ----------------------------------------------------------------------------
// Top-level WebSocket message (everything on the wire is one of these)
// ----------------------------------------------------------------------------

export type PimoteServerMessage = PimoteEvent | PimoteResponse;

export type PimoteClientMessage = PimoteCommand;
