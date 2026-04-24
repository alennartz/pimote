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
  archived?: boolean;
  /** Whether this session is owned by the requesting client */
  isOwnedByMe?: boolean;
  /** Live status if this is an active in-memory session, null otherwise */
  liveStatus?: 'working' | 'idle' | null;
  /** Session working directory (may differ from the parent folder path) */
  cwd?: string;
}

export interface SessionState {
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  /**
   * Thinking levels supported by the current model, in display order.
   * Server-authoritative (derived from pi-ai's per-model capabilities), so
   * adding new levels (e.g. "xhigh") Just Works without client changes.
   * May be missing when talking to older servers — clients should fall back.
   */
  availableThinkingLevels?: string[];
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
  isError?: boolean;
  /** True while this content block is still receiving streaming deltas. Only set on StreamingMessage blocks. */
  streaming?: boolean;
}

export interface PimoteAgentMessage {
  role: string;
  content: PimoteMessageContent[];
  /** Stable session entry ID from the pi SDK, used for targeting specific messages (e.g. fork). */
  entryId?: string;
  /** Present when role === 'custom' — the extension-defined message type (e.g. 'agent-complete') */
  customType?: string;
  /** For custom messages: if false, the message should be hidden from the UI */
  display?: boolean;
  /**
   * True for assistant messages whose turn ended with `stopReason: 'aborted'`.
   * Common in voice sessions (every barge-in produces one) — the UI renders
   * these with an "interrupted" indicator rather than as empty bubbles.
   */
  aborted?: boolean;
  [key: string]: unknown;
}

// ----------------------------------------------------------------------------
// Panel / Card Types
// ----------------------------------------------------------------------------

export type CardColor = 'accent' | 'success' | 'warning' | 'error' | 'muted';
export type BodySectionStyle = 'text' | 'code' | 'secondary';

export interface BodySection {
  content: string;
  style: BodySectionStyle;
}

export interface Card {
  id: string;
  color?: CardColor;
  header: {
    title: string;
    tag?: string;
  };
  body?: BodySection[];
  footer?: string[];
}

// ----------------------------------------------------------------------------
// Tree navigation types
// ----------------------------------------------------------------------------

/** Session tree node transferred over the wire (preview-only, no full message content). */
export interface PimoteTreeNode {
  id: string;
  type: string;
  role?: string;
  customType?: string;
  preview: string;
  /** ISO 8601 */
  timestamp: string;
  label?: string;
  /** ISO 8601 */
  labelTimestamp?: string;
  children: PimoteTreeNode[];
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

export interface RenameSessionCommand extends CommandBase {
  type: 'rename_session';
  folderPath: string;
  sessionId: string;
  name: string;
}

export interface DequeueSteeringCommand extends CommandBase {
  type: 'dequeue_steering';
}

export interface ForkCommand extends CommandBase {
  type: 'fork';
  entryId: string;
}

export interface NavigateTreeCommand extends CommandBase {
  type: 'navigate_tree';
  targetId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface SetTreeLabelCommand extends CommandBase {
  type: 'set_tree_label';
  entryId: string;
  /** Empty string or undefined clears the label. */
  label?: string;
}

// -- Project management commands --

export interface CreateProjectCommand extends CommandBase {
  type: 'create_project';
  /** Must be one of the configured roots */
  root: string;
  /** Folder name — no slashes, non-empty */
  name: string;
}

// -- Server-level commands --

export interface ListFoldersCommand extends CommandBase {
  type: 'list_folders';
}

export interface ListSessionsCommand extends CommandBase {
  type: 'list_sessions';
  folderPath: string;
  includeArchived?: boolean;
}

export interface OpenSessionCommand extends CommandBase {
  type: 'open_session';
  folderPath: string;
  sessionId?: string;
  /** Last cursor seen by the client; when present the server may attempt incremental replay. */
  lastCursor?: number;
  /** Force takeover if the session is owned by another client */
  force?: boolean;
}

export type RestoreMode = 'incremental_replay' | 'full_resync_no_cursor' | 'full_resync_cursor_stale' | 'disk_full_resync';

export interface OpenSessionResponseData {
  sessionId: string;
  folderPath?: string;
  restoreMode?: RestoreMode;
}

export interface CloseSessionCommand extends CommandBase {
  type: 'close_session';
}

export interface DeleteSessionCommand extends CommandBase {
  type: 'delete_session';
  folderPath: string;
  sessionId: string;
}

export interface ArchiveSessionCommand extends CommandBase {
  type: 'archive_session';
  folderPath: string;
  sessionIds: string[];
  archived: boolean;
}

export interface TakeoverFolderCommand extends CommandBase {
  type: 'takeover_folder';
  folderPath: string;
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

// -- Voice call commands --

export interface CallBindCommand extends CommandBase {
  type: 'call_bind';
  id: string;
  sessionId: string;
  /** If true, displace an existing call owner on this session. */
  force?: boolean;
}

export interface CallEndCommand extends CommandBase {
  type: 'call_end';
  id: string;
  sessionId: string;
}

/** Reason codes returned in PimoteResponse.error for a failed call_bind. */
export type CallBindErrorCode = 'call_bind_failed_session_not_found' | 'call_bind_failed_owned' | 'call_bind_failed_internal';

/** Reason code returned when an extension attempts a UI bridge call during a voice call. */
export const UI_BRIDGE_DISABLED_IN_VOICE_MODE = 'ui_bridge_disabled_in_voice_mode';

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
  | ForkCommand
  | NavigateTreeCommand
  | SetTreeLabelCommand
  // Project management
  | CreateProjectCommand
  // Server-level
  | RenameSessionCommand
  | ListFoldersCommand
  | ListSessionsCommand
  | OpenSessionCommand
  | CloseSessionCommand
  | DeleteSessionCommand
  | ArchiveSessionCommand
  | TakeoverFolderCommand
  | ViewSessionCommand
  // Push notifications
  | RegisterPushCommand
  | UnregisterPushCommand
  // Session conflict
  | KillConflictingProcessesCommand
  | KillConflictingSessionsCommand
  // Extension UI
  | ExtensionUiResponseCommand
  // Voice
  | CallBindCommand
  | CallEndCommand;

// ----------------------------------------------------------------------------
// Server → Client Events
// ----------------------------------------------------------------------------

interface SessionEventBase {
  /** Which session produced this event */
  sessionId: string;
  /** Monotonically increasing cursor for reconnect replay */
  cursor: number;
  /** ISO 8601 server-side timestamp */
  timestamp?: string;
}

// -- Agent lifecycle events --

export interface AgentStartEvent extends SessionEventBase {
  type: 'agent_start';
}

export interface AgentEndEvent extends SessionEventBase {
  type: 'agent_end';
  error?: string;
  /** Entry IDs for all messages, zipped 1:1 with the session message list.
   *  Sent so the client can enable fork targets on messages received via
   *  streaming events (which don't carry entry IDs individually). */
  messageEntryIds?: string[];
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
  isError?: boolean;
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

export interface TreeNavigationStartEvent extends SessionEventBase {
  type: 'tree_navigation_start';
  targetId: string;
  summarizing: boolean;
}

export interface TreeNavigationEndEvent extends SessionEventBase {
  type: 'tree_navigation_end';
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
  | ExtensionErrorEvent
  | TreeNavigationStartEvent
  | TreeNavigationEndEvent;

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

export interface SessionDeletedEvent {
  type: 'session_deleted';
  sessionId: string;
  folderPath: string;
}

export interface SessionRenamedEvent {
  type: 'session_renamed';
  sessionId: string;
  folderPath: string;
  name: string;
}

export interface SessionArchivedEvent {
  type: 'session_archived';
  sessionId: string;
  folderPath: string;
  archived: boolean;
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
  /** Current git branch for the session folder (null when unavailable). */
  gitBranch?: string | null;
  /** Session display name (from setSessionName). */
  sessionName?: string;
  /** First user message text, for sidebar display. */
  firstMessage?: string;
  /** Total message count. */
  messageCount?: number;
}

export interface ConnectionRestoredEvent {
  type: 'connection_restored';
  sessionId: string;
}

export interface SessionRestoreEvent {
  type: 'session_restore';
  sessionId: string;
  mode: RestoreMode;
  status: 'started' | 'completed';
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

// -- Panel events --

export interface PanelUpdateEvent {
  type: 'panel_update';
  sessionId: string;
  cards: Card[];
}

// -- Voice events --

/**
 * Success response to a CallBindCommand. Carries the per-call WebRTC
 * signalling endpoint the client should connect to. The PWA obtains
 * Cloudflare Realtime TURN credentials directly from speechmux in its
 * `/signal` `session` response; pimote no longer mints or proxies either
 * the per-call auth token (Cloudflare Access is the auth boundary on
 * `/signal`) or TURN creds.
 *
 * Failed binds return a standard PimoteResponse with `success: false` and an
 * error string that is one of CallBindErrorCode.
 */
export interface CallBindResponse {
  type: 'call_bind_response';
  /** Correlates with the originating CallBindCommand.id */
  id: string;
  sessionId: string;
  webrtcSignalUrl: string;
}

/** The peer connection to speechmux has been established. */
export interface CallReadyEvent {
  type: 'call_ready';
  sessionId: string;
}

export type CallEndReason = 'user_hangup' | 'displaced' | 'server_ended' | 'error';

export interface CallEndedEvent {
  type: 'call_ended';
  sessionId: string;
  reason: CallEndReason;
}

export type CallStatus = 'binding' | 'ringing' | 'connected' | 'ended';

export interface CallStatusEvent {
  type: 'call_status';
  sessionId: string;
  status: CallStatus;
}

// -- Voice persisted custom entries --

/**
 * Custom entry customType appended by the voice extension when it observes a
 * speechmux rollback/abort frame. The payload records the user-heard watermark
 * so persisted scrollback carries evidence of the interrupt even though pi
 * itself leaves no assistant entry for an aborted turn.
 */
export const VOICE_INTERRUPT_CUSTOM_TYPE = 'pimote:voice:interrupt';

export interface VoiceInterruptEntryData {
  /** Characters the user actually heard before the cutoff. Empty for pure abort. */
  heard_text: string;
  kind: 'abort' | 'rollback';
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
  | SessionDeletedEvent
  | SessionRenamedEvent
  | SessionArchivedEvent
  | SessionReplacedEvent
  | SessionStateChangedEvent
  | ConnectionRestoredEvent
  | SessionRestoreEvent
  | BufferedEventsEvent
  | FullResyncEvent
  // Panel
  | PanelUpdateEvent
  // Voice
  | CallBindResponse
  | CallReadyEvent
  | CallEndedEvent
  | CallStatusEvent
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
