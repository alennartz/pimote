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
  | 'delegation'
  | 'message_thread'
  | 'await_started'
  | 'child_settled'
  | 'await_interrupted'
  | 'await_released'
  | 'completion'
  | 'interrupt'
  | 'teardown'
  | 'resurrect';

export type SubagentDelegationData = Readonly<{
  invocationId: string;
  awaitsResult: boolean;
  children: readonly Readonly<{ path: AgentPath; task: string; persona?: string }>[];
}>;

export type SubagentCompletionData = Readonly<{
  status: 'idle' | 'errored' | 'dead';
  output?: string;
  error?: string;
  usage?: SubagentUsage;
}> &
  (Readonly<{ delivery: 'awaited'; invocationId: string }> | Readonly<{ delivery: 'asynchronous'; invocationId?: string }>);

export type SubagentMessageData = Readonly<{
  from: AgentPath;
  to: AgentPath;
  text: string;
  correlationId?: string;
  responseExpected: boolean;
}> &
  (Readonly<{ phase: 'sent' | 'received' | 'response' }> | Readonly<{ phase: 'failure'; error: string }>);

/** A semantic overlay. Native Pi entries remain the transcript source. */
export type SubagentEvent = Readonly<{
  eventId: string;
  cursor: FeedCursor;
  path: AgentPath;
  relatedPiEvents: readonly PiEventRef[];
}> &
  (
    | Readonly<{ kind: 'node_updated'; data: Readonly<{ sessionId: string }> }>
    | Readonly<{ kind: 'delegation'; data: SubagentDelegationData }>
    | Readonly<{ kind: 'message_thread'; data: SubagentMessageData }>
    | Readonly<{ kind: 'completion'; data: SubagentCompletionData }>
    | Readonly<{ kind: Exclude<SubagentEventKind, 'node_updated' | 'delegation' | 'message_thread' | 'completion'>; data: unknown }>
  );

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
  /** Context fill as an integer percentage from 0 through 100. */
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
export type BorrowedSessionManager = Pick<
  AgentSession['sessionManager'],
  'getEntries' | 'getBranch' | 'buildContextEntries' | 'getTree' | 'getLeafId' | 'getCwd' | 'getLabel' | 'appendLabelChange'
>;

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
  | 'steer'
  | 'followUp'
  | 'abort'
  | 'executeBash'
  | 'abortBash'
  | 'setModel'
  | 'cycleModel'
  | 'setThinkingLevel'
  | 'cycleThinkingLevel'
  | 'setAutoCompactionEnabled'
  | 'compact'
  | 'navigateTree'
  | 'getContextUsage'
  | 'getSessionStats'
> & {
  readonly sessionManager: BorrowedSessionManager;
};

export type SubagentLeaseEvent = { kind: 'rebound'; session: BorrowedAgentSession } | { kind: 'closed'; reason: 'removed' | 'unavailable' };

/** A borrowed child runtime. Release is idempotent and never disposes it. */
export interface SubagentLease {
  readonly path: AgentPath;
  /** The current native session; throws after closure or release. */
  readonly session: BorrowedAgentSession;
  subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
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
