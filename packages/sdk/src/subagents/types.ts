import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** Root-relative identity of a my-pi child runtime. */
export type AgentPath = readonly string[];

/** Provider-owned replay position. Pimote keeps this separate from parent cursors. */
export type FeedCursor = Readonly<{
  epoch: string;
  sequence: number;
}>;

/** Native Pi transcript/session provenance for one semantic event. */
export type PiEventRef = Readonly<{
  sessionId: string;
  entryId?: string;
  toolCallId?: string;
  kind: 'message' | 'tool_call' | 'custom_message' | 'lifecycle';
}>;

export type SubagentEventKind =
  | 'node_added'
  | 'node_updated'
  | 'node_removed'
  | 'message_thread'
  | 'await_started'
  | 'child_settled'
  | 'await_interrupted'
  | 'await_released'
  | 'completion'
  | 'interrupt'
  | 'teardown'
  | 'resurrect';

/** A semantic overlay. Native Pi entries remain the transcript source. */
export type SubagentEvent = Readonly<{
  eventId: string;
  cursor: FeedCursor;
  path: AgentPath;
  kind: SubagentEventKind;
  relatedPiEvents: readonly PiEventRef[];
  data: unknown;
}>;

export type SubagentState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead';
export type SubagentNodeState = SubagentState;

export type SubagentCostBreakdown = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

/** Provider usage accumulated for one child runtime. */
export type SubagentUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costBreakdown?: SubagentCostBreakdown;
  turns: number;
}>;

/** Current public projection of one root-relative child path. */
export type SubagentNodeSnapshot = Readonly<{
  path: AgentPath;
  sessionId: string;
  task?: string;
  persona?: string;
  personaIcon?: string;
  model?: string;
  thinkingLevel?: string;
  state: SubagentState;
  activity?: string;
  usage: SubagentUsage;
  /** Context fill as a ratio or percentage chosen by the provider contract. */
  contextFill?: number;
  channels: readonly string[];
  waitingFor: readonly AgentPath[];
  pendingCorrelations: readonly string[];
  hasSubgroup: boolean;
  lastOutput?: string;
  lastError?: string;
}>;

/** Compatibility alias for consumers that call hierarchy rows nodes. */
export type SubagentNode = SubagentNodeSnapshot;

/** Snapshot boundary for the current provider epoch. */
export type SubagentSnapshot = Readonly<{
  cursor: FeedCursor;
  nodes: readonly SubagentNodeSnapshot[];
}>;

export type ReplayResult =
  | Readonly<{
      kind: 'events';
      cursor: FeedCursor;
      events: readonly SubagentEvent[];
    }>
  | Readonly<{
      kind: 'snapshot_required';
      reason: 'epoch_changed' | 'history_unavailable';
    }>;

/** Minimal session-manager projection exposed beside a borrowed native session. */
export type BorrowedSessionManager = Pick<AgentSession['sessionManager'], 'getEntries' | 'getBranch' | 'buildContextEntries' | 'getTree' | 'getLeafId'>;

/**
 * Structural projection of the native child runtime borrowed by a view.
 *
 * This type intentionally omits dispose, runtime replacement, session creation,
 * fork/switch/reload, extension binding, and unrestricted manager mutation.
 */
export type BorrowedAgentSession = Pick<
  AgentSession,
  | 'sessionId'
  | 'sessionFile'
  | 'messages'
  | 'model'
  | 'thinkingLevel'
  | 'isStreaming'
  | 'isIdle'
  | 'isCompacting'
  | 'subscribe'
  | 'prompt'
  | 'abort'
  | 'setModel'
  | 'setThinkingLevel'
  | 'compact'
  | 'navigateTree'
  | 'getContextUsage'
  | 'getSessionStats'
> & {
  readonly sessionManager: BorrowedSessionManager;
};

/** A borrowed child runtime. Release is idempotent and never disposes it. */
export interface SubagentLease {
  readonly path: AgentPath;
  readonly session: BorrowedAgentSession;
  release(): Promise<void>;
}

export type SubagentTeardownResult = Readonly<{
  path: AgentPath;
  removed: boolean;
  sessionId?: string;
  reason?: 'not_found' | 'already_removed' | 'removed';
}>;

/** Per-session provider feed and borrowed-runtime contract. */
export interface SubagentProvider {
  subscribe(listener: (event: SubagentEvent) => void): () => void;
  snapshot(): SubagentSnapshot;
  replay(after?: FeedCursor): ReplayResult;
  acquire(path: AgentPath): Promise<SubagentLease>;
  teardown(path: AgentPath): Promise<SubagentTeardownResult>;
}
