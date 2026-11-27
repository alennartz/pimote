import type { AgentSession, EventBus } from '@earendil-works/pi-coding-agent';
import type { SubagentPresentationProvider } from './presentation.js';

/** Root-relative identity of a child runtime. The root session is the empty path. */
export type AgentPath = ReadonlyArray<string>;

/** Operational state of one live child. */
export type SubagentState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead';

/** The settled outcome of a child run. */
export type SubagentSettlementState = 'idle' | 'errored' | 'dead' | 'stopped';

export type SubagentCostBreakdown = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

/** Usage accumulated by one child runtime. */
export type SubagentUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costBreakdown?: SubagentCostBreakdown;
  turns: number;
}>;

/** One live child as the side panel shows it. */
export type SubagentNodeSnapshot = Readonly<{
  path: AgentPath;
  /** Unique for each spawn or resurrection at a path. Stable across runtime replacement. */
  incarnation: string;
  /** Current native session id. Changes on runtime replacement. */
  sessionId: string;
  /** Child runtime working directory. */
  cwd?: string;
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
  channels: ReadonlyArray<string>;
  waitingFor: ReadonlyArray<AgentPath>;
  hasSubgroup: boolean;
  lastError?: string;
  /** The user holds this child's settled results back from its parent. */
  held: boolean;
  /** Set while a hold keeps a settled result from the parent. */
  heldSettlement?: SubagentSettlementState;
}>;

/** Topology snapshot. Events with a sequence at or below `sequence` are already included. */
export type SubagentTopologySnapshot = Readonly<{
  sequence: number;
  /** False until the provider has restored every persisted child. Absence is not final until then. */
  ready: boolean;
  /** Root session working directory, used to identify children that override it. */
  rootCwd?: string;
  nodes: ReadonlyArray<SubagentNodeSnapshot>;
}>;

/** Ordered topology changes. `sequence` increases by one per event within one provider. */
export type SubagentTopologyEvent = Readonly<{ sequence: number }> &
  (
    | Readonly<{ kind: 'node_added' | 'node_updated'; node: SubagentNodeSnapshot }>
    | Readonly<{ kind: 'node_removed'; node: SubagentNodeSnapshot; reason: 'removed' | 'stale' }>
    | Readonly<{ kind: 'runtime_replaced'; path: AgentPath; incarnation: string; oldSessionId: string; newSessionId: string }>
    | Readonly<{ kind: 'ready' }>
  );

export type SubagentTeardownResult = Readonly<{
  path: AgentPath;
  removed: boolean;
  sessionId?: string;
  incarnation?: string;
  reason?: 'not_found' | 'already_removed' | 'removed';
}>;

/** Identifies one runtime of one child incarnation. Every guarded control carries it. */
export type SubagentRuntimeRef = Readonly<{
  path: AgentPath;
  incarnation: string;
}>;

/** Stop the current run of a child. Rejected when the runtime is not `expectedSessionId`. */
export type SubagentStopRequest = SubagentRuntimeRef & Readonly<{ expectedSessionId: string }>;

/** Set or clear the user hold on a child. */
export type SubagentHoldRequest = SubagentRuntimeRef & Readonly<{ held: boolean }>;

/** Input to the normal resurrection path. */
export type SubagentResurrectRequest = Readonly<{
  /** Saved child session id returned by teardown. */
  sessionId: string;
  /** Owning root-relative parent path. */
  parentPath: AgentPath;
  /** New local id under `parentPath`. */
  localId: string;
  task: string;
  channels: ReadonlyArray<string>;
  model?: string;
}>;

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

export type SubagentModel = Parameters<AgentSession['setModel']>[0];
export type SubagentBashResult = Awaited<ReturnType<AgentSession['executeBash']>>;

export interface SubagentBashOptions {
  id?: string;
  excludeFromContext?: boolean;
  signal?: AbortSignal;
}

export interface SubagentSettings {
  availableThinkingLevels: ReadonlyArray<string>;
  autoCompactionEnabled: boolean;
  sessionName?: string;
}

export interface SubagentCommandInfo {
  name: string;
  description: string;
  hasArgCompletions: boolean;
}

export interface SubagentAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/** Provider-owned child capabilities. It never exposes extension machinery. */
export interface SubagentCapabilities {
  /** Explicitly admitted identity-preserving operations. Absence admits no commands. */
  readonly operations?: ReadonlyArray<SubagentOperation>;
  /** Whether custom child entries render. */
  readonly renderer?: Readonly<{ visible?: boolean }>;
  readonly resolveModel?: (provider: string, modelId: string) => Promise<SubagentModel | undefined> | SubagentModel | undefined;
  readonly getSettings?: () => SubagentSettings;
  readonly nativeBash?: Readonly<{
    admitted?: boolean;
    execute?: (command: string, options: SubagentBashOptions) => Promise<SubagentBashResult> | SubagentBashResult;
    abort?: () => Promise<void> | void;
  }>;
  readonly getCommands?: () => Promise<ReadonlyArray<SubagentCommandInfo>> | ReadonlyArray<SubagentCommandInfo>;
  readonly completeArgs?: (commandName: string, prefix: string) => Promise<ReadonlyArray<SubagentAutocompleteItem>> | ReadonlyArray<SubagentAutocompleteItem>;
  readonly completeFileRefs?: (prefix: string) => Promise<ReadonlyArray<SubagentAutocompleteItem>> | ReadonlyArray<SubagentAutocompleteItem>;
}

export type BorrowedSessionManager = Pick<
  AgentSession['sessionManager'],
  'getEntries' | 'getBranch' | 'buildContextEntries' | 'getTree' | 'getLeafId' | 'getCwd' | 'getLabel' | 'appendLabelChange'
>;

/**
 * The native child runtime borrowed by a view.
 *
 * It omits dispose, abort, runtime replacement, session creation, fork, switch,
 * reload, extension binding, and unrestricted manager mutation. Stop goes
 * through `SubagentProviderControls.stop`.
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
  | 'isBashRunning'
  | 'clearQueue'
  | 'subscribe'
  | 'prompt'
  | 'steer'
  | 'followUp'
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
  readonly getSteeringMessages?: AgentSession['getSteeringMessages'];
  readonly getFollowUpMessages?: AgentSession['getFollowUpMessages'];
  readonly state: Pick<AgentSession['state'], 'streamingMessage' | 'pendingToolCalls' | 'errorMessage'>;
};

export type SubagentLeaseEvent =
  | Readonly<{ kind: 'rebound'; session: BorrowedAgentSession; capabilities: SubagentCapabilities }>
  | Readonly<{ kind: 'closed'; reason: 'removed' | 'unavailable' }>;

/**
 * A borrowed child runtime. A lease never changes orchestration: holding or
 * releasing one has no effect on what the parent agent receives.
 */
export interface SubagentLease {
  readonly path: AgentPath;
  readonly incarnation: string;
  /** Current native session. Reading it after the lease closes or releases throws. */
  readonly session: BorrowedAgentSession;
  readonly capabilities: SubagentCapabilities;
  subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
  /** Idempotent. Never disposes the child runtime. */
  release(): void;
}

/** Leases and guarded lifecycle controls. Every mutation validates path and incarnation inside the owner's mutation queue. */
export interface SubagentProviderControls {
  acquire(ref: SubagentRuntimeRef): Promise<SubagentLease>;
  teardown(ref: SubagentRuntimeRef): Promise<SubagentTeardownResult>;
  stop(request: SubagentStopRequest): Promise<void>;
  setHold(request: SubagentHoldRequest): Promise<void>;
  resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
}

/** EventBus response payload. `provider: undefined` reports that the provider went away. */
export type SubagentProviderResponse = Readonly<{
  provider: SubagentPresentationProvider | undefined;
}>;

/** A live discovery handle. Listeners receive every registration, replacement, and removal. */
export interface SubagentProviderDiscovery {
  readonly provider: SubagentPresentationProvider | undefined;
  subscribe(listener: (provider: SubagentPresentationProvider | undefined) => void): () => void;
  close(): void;
}

/** Either an ExtensionAPI or a bare EventBus. */
export type SubagentEventBusOwner = Pick<EventBus, 'on' | 'emit'> | { readonly events: Pick<EventBus, 'on' | 'emit'> };
