import type { AgentSession, EventBus } from '@earendil-works/pi-coding-agent';

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

/** One child state included in await progress and settlement facts. */
export type SubagentAwaitChildStatus = Readonly<{
  path: AgentPath;
  state: 'running' | 'waiting' | 'idle' | 'errored' | 'dead' | 'stopped';
  output?: string;
  error?: string;
  sessionId?: string;
}>;

/** A public node projection carried by topology events and snapshots. */
export type SubagentNodeSnapshot = Readonly<{
  path: AgentPath;
  /** Stable for runtime replacement. Changes when a path is removed or reused. */
  incarnation: string;
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
  hasSubgroup: boolean;
  lastOutput?: string;
  lastError?: string;
}>;

/** Compatibility alias for consumers that call hierarchy rows nodes. */
export type SubagentNode = SubagentNodeSnapshot;
export type SubagentUsageSnapshot = SubagentUsage;

/** Topology events accept the complete projection and old session-id facts. */
export type SubagentNodeEventData = SubagentNodeSnapshot | Readonly<{ sessionId: string }>;

export type SubagentRuntimeReplacedData = Readonly<{
  oldSessionId: string;
  newSessionId: string;
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

export type SubagentTeardownReason = 'not_found' | 'already_removed' | 'removed';

export type SubagentTeardownResult = Readonly<{
  path: AgentPath;
  removed: boolean;
  sessionId?: string;
  incarnation?: string;
  reason?: SubagentTeardownReason;
}>;

/** Guarded request to stop the child that owns one public path incarnation. */
export type SubagentStopRequest = Readonly<{
  path: AgentPath;
  incarnation: string;
  /** The host rejects a request for a replacement runtime at this path. */
  expectedSessionId: string;
}>;

/** Input to the normal my-pi resurrection path. */
export type SubagentResurrectRequest = Readonly<{
  /** Saved child session id returned by teardown. */
  sessionId: string;
  /** Owning root-relative parent path. */
  parentPath: AgentPath;
  /** New local id under `parentPath`. */
  localId: string;
  task: string;
  channels: readonly string[];
  model?: string;
}>;

/** Result of a normal resurrection operation. */
export type SubagentResurrectResult = Readonly<{
  path: AgentPath;
  node?: SubagentNodeSnapshot;
  sessionId?: string;
  incarnation?: string;
}>;

/** Operations that preserve the identity of the borrowed child runtime. */
export type SubagentOperation =
  | 'prompt'
  | 'steer'
  | 'follow_up'
  | 'stop'
  | 'bash'
  | 'abort_bash'
  | 'set_model'
  | 'cycle_model'
  | 'set_thinking_level'
  | 'cycle_thinking_level'
  | 'set_auto_compaction'
  | 'compact'
  | 'tree'
  | 'completion'
  | 'state'
  | 'meta';

/** Provider-owned child capabilities. It never exposes extension machinery. */
export interface SubagentCapabilities {
  /** Explicitly admitted identity-preserving operations. */
  readonly operations?: readonly SubagentOperation[];
  /** Whether the child renderer can expose a view. */
  readonly renderer?: Readonly<{ visible?: boolean; [key: string]: unknown }>;
  /** Child-local model resolution and settings. */
  readonly resolveModel?: (provider: string, modelId: string) => Promise<unknown> | unknown;
  readonly getSettings?: () => unknown;
  /** Native bash admission and dispatch. */
  readonly nativeBash?: Readonly<{
    admitted?: boolean;
    execute?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
    abort?: (...args: readonly unknown[]) => Promise<void> | void;
    [key: string]: unknown;
  }>;
  readonly executeBash?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
  /** Filtered command and argument-completion descriptors. */
  readonly getCommands?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
  readonly completeArgs?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
  readonly completeFileRefs?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
  readonly [key: string]: unknown;
}

/** Minimal session-manager projection exposed beside a borrowed native session. */
export type BorrowedSessionManager = Pick<
  AgentSession['sessionManager'],
  'getEntries' | 'getBranch' | 'buildContextEntries' | 'getTree' | 'getLeafId' | 'getCwd' | 'getLabel' | 'appendLabelChange'
>;

/**
 * Structural projection of the native child runtime borrowed by a view.
 *
 * The projection intentionally omits dispose, runtime replacement, session creation,
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
  /** Current native steering queue, when supported by the provider. */
  readonly getSteeringMessages?: AgentSession['getSteeringMessages'];
  /** Full-resync native state projection. */
  readonly state: Pick<AgentSession['state'], 'streamingMessage' | 'pendingToolCalls' | 'errorMessage'>;
};

export type SubagentLeaseEvent =
  | Readonly<{ kind: 'rebound'; session: BorrowedAgentSession; capabilities?: SubagentCapabilities }>
  | Readonly<{ kind: 'closed'; reason: 'removed' | 'unavailable' }>;

/** A borrowed child runtime. Release is idempotent and never disposes it. */
export interface SubagentLease {
  readonly path: AgentPath;
  /** Current native session; access throws after the lease closes or releases. */
  readonly session: BorrowedAgentSession;
  readonly capabilities: SubagentCapabilities;
  subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
  release(): Promise<void>;
}

/** Root-scoped lifecycle authority used by the provider. */
export interface SubagentOwnerControlPort {
  teardown(path: AgentPath, incarnation: string): Promise<SubagentTeardownResult>;
  stop(request: SubagentStopRequest): Promise<void>;
  resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
}

/** Provider-owned leases and guarded lifecycle controls shared by the presentation seam. */
export interface SubagentProviderControls {
  acquire(path: AgentPath): Promise<SubagentLease>;
  teardown(path: AgentPath, incarnation: string): Promise<SubagentTeardownResult>;
  stop(request: SubagentStopRequest): Promise<void>;
  resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
}

/** EventBus request payload used by provider discovery. */
export type SubagentProviderRequest = Readonly<{
  /** Reserved for future handshake versions. */
  version?: number;
}>;

/** EventBus response payload used by provider registration and discovery. */
export type SubagentProviderResponse = Readonly<{
  provider: import('./presentation.js').SubagentPresentationProvider;
}>;

/** A live discovery handle that tracks late registration and replacement. */
export interface SubagentProviderDiscovery {
  readonly provider: import('./presentation.js').SubagentPresentationProvider | undefined;
  /** Alias for callers that model discovery as a mutable current value. */
  readonly current: import('./presentation.js').SubagentPresentationProvider | undefined;
  subscribe(listener: (provider: import('./presentation.js').SubagentPresentationProvider | undefined) => void): () => void;
  /** Alias for subscribe, useful at the host event boundary. */
  onProvider(listener: (provider: import('./presentation.js').SubagentPresentationProvider | undefined) => void): () => void;
  close(): void;
}

/** Extract the EventBus from either ExtensionAPI or an EventBus itself. */
export type SubagentEventBusOwner = Pick<EventBus, 'on' | 'emit'> | { readonly events: Pick<EventBus, 'on' | 'emit'> };
