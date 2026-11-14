import type {
  AgentPath,
  BorrowedAgentSession,
  FeedCursor,
  PiEventRef,
  SubagentNodeEventData,
  SubagentNodeSnapshot,
  SubagentProviderControls,
  SubagentRuntimeReplacedData,
  SubagentUsage,
} from './types.js';

export type SubagentPresentationManifest = Readonly<{
  hiddenToolNames: readonly string[];
  hiddenCustomTypes: readonly string[];
}>;

export type SubagentOperationKind = 'send' | 'message_received' | 'respond' | 'await' | 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect';

/** Normalized public tool inputs. Final operations carry complete values. */
export type SubagentToolParameters = Readonly<Record<string, unknown>>;

export type SubagentPlacement = Readonly<{ toolCallId: string; contentIndex: number; entryId?: string }> | Readonly<{ entryId: string }>;

export type SubagentOperationTarget = Readonly<{
  operationId: string;
  kind: SubagentOperationKind;
  path: AgentPath;
  placement?: SubagentPlacement;
}>;

export type SubagentAwaitStatus = Readonly<{
  path: AgentPath;
  state: 'running' | 'waiting' | 'idle' | 'errored' | 'dead' | 'stopped';
  output?: string;
  error?: string;
  sessionId?: string;
}>;

export type SubagentCompletionResult = Readonly<{
  state: 'idle' | 'errored' | 'dead' | 'stopped';
  output?: string;
  error?: string;
  usage?: SubagentUsage;
}>;

export type SubagentAwaitResult = Readonly<{
  statuses: readonly SubagentAwaitStatus[];
  interrupted?: boolean;
  error?: string;
}>;

export type SubagentStartData =
  | Readonly<{
      operation: 'send';
      parameters: SubagentToolParameters;
      result: Readonly<{ response: string; phase: 'ready' | 'sending' | 'waiting' | 'responding' }>;
    }>
  | Readonly<{ operation: 'respond'; parameters: SubagentToolParameters; result: Readonly<Record<string, unknown>> }>
  | Readonly<{ operation: 'await'; parameters: SubagentToolParameters; result: SubagentAwaitResult }>;

export type SubagentDeltaData =
  | Readonly<{ operation: 'send'; field: 'request' | 'response'; delta: string }>
  | Readonly<{ operation: 'send'; phase: 'waiting' | 'responding' }>
  | Readonly<{ operation: 'respond'; delta: string }>
  | Readonly<{ operation: 'await'; statuses: readonly SubagentAwaitStatus[] }>;

export type SubagentEndData =
  | Readonly<{ operation: 'send'; parameters?: SubagentToolParameters; result: Readonly<Record<string, unknown>> }>
  | Readonly<{ operation: 'respond'; parameters?: SubagentToolParameters; result: Readonly<Record<string, unknown>> }>
  | Readonly<{ operation: 'await'; parameters: SubagentToolParameters; result: SubagentAwaitResult }>;

export type SubagentDelegatedChild = Readonly<{ path: AgentPath; task: string; persona?: string; status?: SubagentAwaitStatus['state'] }>;

export type SubagentInterruptTarget = Readonly<{
  path: AgentPath;
  output?: string;
  error?: string;
}>;

export type SubagentInterruptResult = Readonly<{
  interrupted: readonly SubagentInterruptTarget[];
  pending: readonly SubagentInterruptTarget[];
  failed: readonly SubagentInterruptTarget[];
}>;

export type SubagentResurrectedAgent = Readonly<{
  path: AgentPath;
  sessionId: string;
  incarnation: string;
  state: 'idle' | 'running';
  usage: SubagentUsage;
  output?: string;
  error?: string;
}>;

export type SubagentFiniteData =
  | Readonly<{ operation: 'delegation'; parameters: SubagentToolParameters; result: Readonly<{ children: readonly SubagentDelegatedChild[] }> }>
  | Readonly<{ operation: 'completion'; result: SubagentCompletionResult }>
  | Readonly<{ operation: 'interrupt'; parameters: SubagentToolParameters; result: SubagentInterruptResult }>
  | Readonly<{
      operation: 'teardown';
      parameters: SubagentToolParameters;
      result: Readonly<{
        affectedAgents: readonly Readonly<{
          path: AgentPath;
          sessionId: string;
          incarnation: string;
          state: SubagentAwaitStatus['state'];
          usage: SubagentUsage;
          output?: string;
          error?: string;
        }>[];
        status: 'removed' | 'already_removed' | 'not_found';
      }>;
    }>
  | Readonly<{ operation: 'resurrect'; parameters: SubagentToolParameters; result: Readonly<{ affectedAgents: readonly SubagentResurrectedAgent[] }> }>
  | Readonly<{ operation: 'protocol_error'; result: Readonly<{ error: string }> }>;

export type SubagentFinalData = SubagentEndData | SubagentFiniteData;
export type SubagentProtocolErrorData = Readonly<{ operationId: string; operation: SubagentOperationKind; message: string }>;
export type ActiveSubagentOperation = Readonly<{ target: SubagentOperationTarget; data: SubagentStartData }>;

type PresentationEventBase = Readonly<{ eventId: string; cursor: FeedCursor; target: SubagentOperationTarget }>;
export type SubagentStartEvent = PresentationEventBase & Readonly<{ type: 'subagent_start'; data: SubagentStartData }>;
export type SubagentDeltaEvent = PresentationEventBase & Readonly<{ type: 'subagent_delta'; data: SubagentDeltaData }>;
export type SubagentEndEvent = PresentationEventBase & Readonly<{ type: 'subagent_end'; state: 'complete' | 'error' | 'aborted'; data: SubagentEndData }>;
export type SubagentFiniteEvent = PresentationEventBase & Readonly<{ type: 'subagent_snapshot_event'; state: 'complete' | 'error' | 'aborted'; data: SubagentFinalData }>;
type SubagentTopologyData =
  | Readonly<{ kind: 'node_added' | 'node_updated'; data: SubagentNodeEventData }>
  | Readonly<{ kind: 'node_removed'; data: Readonly<{ node: SubagentNodeSnapshot; reason: string }> }>
  | Readonly<{ kind: 'runtime_replaced'; data: SubagentRuntimeReplacedData }>;

export type SubagentTopologyEvent = Readonly<{
  eventId: string;
  cursor: FeedCursor;
  path: AgentPath;
  relatedPiEvents: readonly PiEventRef[];
}> &
  SubagentTopologyData;
export type SubagentProviderEvent = SubagentTopologyEvent | SubagentStartEvent | SubagentDeltaEvent | SubagentEndEvent | SubagentFiniteEvent;

export type PersistedSubagentContent = Readonly<{
  operationId: string;
  kind: SubagentOperationKind;
  state: 'complete' | 'error' | 'aborted';
  data: SubagentFinalData;
}> &
  (
    | Readonly<{ source: 'tool'; placement: Extract<SubagentPlacement, { toolCallId: string }> }>
    | Readonly<{ source: 'custom_entry'; placement?: Extract<SubagentPlacement, { entryId: string }> }>
  );

export type SubagentProviderSnapshot = Readonly<{
  manifest: SubagentPresentationManifest;
  nodes: readonly SubagentNodeSnapshot[];
  cursor: FeedCursor;
  activeOperations: readonly ActiveSubagentOperation[];
}>;

export type SubagentPresentationReplay =
  | Readonly<{ kind: 'events'; cursor: FeedCursor; events: readonly SubagentProviderEvent[] }>
  | Readonly<{ kind: 'snapshot_required'; reason: 'epoch_changed' | 'history_unavailable' }>;

export interface SubagentPresentationProvider extends SubagentProviderControls {
  snapshot(): SubagentProviderSnapshot;
  subscribe(listener: (event: SubagentProviderEvent) => void): () => void;
  replay(after?: FeedCursor): SubagentPresentationReplay;
  rehydrate(input: { session: BorrowedAgentSession; path: AgentPath }): Promise<void>;
}
