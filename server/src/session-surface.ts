import type { AutocompleteResponseItem, CommandInfo, PimoteAgentMessage, PimoteSessionEvent, SessionMeta, SessionState, StreamingMessage } from '../../shared/dist/index.js';
import type { BorrowedAgentSession } from '@pimote/sdk/subagents';

/** Commands allowed through both root and child session surfaces. */
export type SessionSurfaceCommand =
  | { type: 'prompt'; id?: string; message: string; images?: string[]; streamingBehavior?: 'streaming' | 'blocking'; clientMessageId?: string }
  | { type: 'steer'; id?: string; message: string; images?: string[] }
  | { type: 'follow_up'; id?: string; message: string }
  | { type: 'abort'; id?: string }
  | { type: 'bash'; id?: string; command: string; excludeFromContext?: boolean }
  | { type: 'abort_bash'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  | { type: 'cycle_model'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  | { type: 'cycle_thinking_level'; id?: string }
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  | { type: 'get_state'; id?: string }
  | { type: 'get_messages'; id?: string }
  | { type: 'get_session_stats'; id?: string }
  | { type: 'get_session_meta'; id?: string }
  | { type: 'get_commands'; id?: string }
  | { type: 'complete_args'; id?: string; commandName: string; prefix: string }
  | { type: 'complete_file_refs'; id?: string; prefix: string }
  | { type: 'get_tree'; id?: string }
  | {
      type: 'navigate_tree';
      id?: string;
      targetId: string;
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    }
  | { type: 'set_tree_label'; id?: string; entryId: string; label?: string }
  | { type: 'teardown'; id?: string };

/** Full transcript/state snapshot at this surface's own event cursor. */
export interface SessionSurfaceSnapshot {
  cursor: number;
  state: SessionState;
  messages: PimoteAgentMessage[];
  streamingMessage?: StreamingMessage;
  runningToolCallIds?: string[];
}

export type SessionSurfaceReplay =
  | { kind: 'events'; cursor: number; events: readonly PimoteSessionEvent[] }
  | { kind: 'snapshot_required'; reason: 'cursor_invalid' | 'history_unavailable' };

/** Result returned when an observer attaches to a surface. */
export interface SessionSurfaceAttachment {
  observerId: string;
  cursor: number;
  snapshot?: SessionSurfaceSnapshot;
  events?: readonly PimoteSessionEvent[];
  release(): void;
}

export type SessionSurfaceKind = 'root' | 'child';

export interface SessionSurfaceOptions {
  sessionId: string;
  session: BorrowedAgentSession;
  kind: SessionSurfaceKind;
  /** Parent replay cursor, when this surface is a child view. */
  parentCursor?: number;
}

/**
 * Shared public contract for root and borrowed child transcript surfaces.
 * Child surfaces expose no root-session lifecycle methods.
 */
export interface SessionSurface {
  readonly sessionId: string;
  readonly kind: SessionSurfaceKind;
  readonly currentCursor: number;
  /** Subscribe to native Pi events before taking the first transcript snapshot. */
  initialize(): Promise<SessionSurfaceSnapshot>;
  subscribe(listener: (event: PimoteSessionEvent) => void): () => void;
  attachObserver(observerId: string, after?: number): Promise<SessionSurfaceAttachment>;
  replay(after?: number): SessionSurfaceReplay;
  dispatch(command: SessionSurfaceCommand): Promise<unknown>;
  /** Full state/meta reads remain surface-local and do not move parent cursors. */
  getState(): Promise<SessionState>;
  getMeta(): Promise<SessionMeta>;
  getMessages(): Promise<readonly PimoteAgentMessage[]>;
  getCommands(): Promise<readonly CommandInfo[]>;
  completeArgs(commandName: string, prefix: string): Promise<readonly AutocompleteResponseItem[]>;
  completeFileRefs(prefix: string): Promise<readonly AutocompleteResponseItem[]>;
}

const NOT_IMPLEMENTED = 'not implemented';

/** Construct a surface for a native session. */
export function createSessionSurface(_options: SessionSurfaceOptions): SessionSurface {
  throw new Error(NOT_IMPLEMENTED);
}
