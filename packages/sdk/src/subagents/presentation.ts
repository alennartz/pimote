import type { AgentPath, BorrowedAgentSession, FeedCursor, SubagentEvent, SubagentNodeSnapshot, SubagentUsage } from './types.js';

/** Native renderers declared by a provider for one immutable provider epoch. */
export type SubagentPresentationManifest = Readonly<{
  hiddenToolNames: readonly string[];
  hiddenCustomTypes: readonly string[];
}>;

export type SubagentOperationKind = 'send' | 'respond' | 'await' | 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect';

/** Native assistant content slot occupied by one projected operation. */
export type SubagentPlacement = Readonly<{
  toolCallId: string;
  contentIndex: number;
  entryId?: string;
}>;

export type SubagentOperationTarget = Readonly<{
  operationId: string;
  kind: SubagentOperationKind;
  path: AgentPath;
  placement?: SubagentPlacement;
}>;

export type SubagentStartData =
  | Readonly<{ operation: 'send'; body: string }>
  | Readonly<{ operation: 'respond'; body: string }>
  | Readonly<{ operation: 'await'; requested: readonly AgentPath[] }>;

export type SubagentDeltaData =
  | Readonly<{ operation: 'send'; delta: string }>
  | Readonly<{ operation: 'respond'; delta: string }>
  | Readonly<{ operation: 'await'; statuses: readonly SubagentAwaitStatus[] }>;

export type SubagentEndData =
  | Readonly<{ operation: 'send'; result: SubagentCompletionResult }>
  | Readonly<{ operation: 'respond'; result: SubagentCompletionResult }>
  | Readonly<{ operation: 'await'; result: SubagentAwaitResult }>;

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

export type SubagentFinalData =
  | Readonly<{ operation: 'delegation'; children: readonly Readonly<{ path: AgentPath; task: string; persona?: string }>[] }>
  | Readonly<{ operation: 'completion'; result: SubagentCompletionResult }>
  | Readonly<{ operation: 'interrupt'; result: Readonly<{ path: AgentPath; status: 'interrupted' | 'already_idle'; output?: string; error?: string }> }>
  | Readonly<{
      operation: 'teardown';
      result: Readonly<{
        affectedAgents: readonly Readonly<{
          path: AgentPath;
          sessionId: string;
          incarnation: string;
          state: 'running' | 'waiting' | 'idle' | 'errored' | 'dead' | 'stopped';
          usage: SubagentUsage;
          output?: string;
          error?: string;
        }>[];
        status: 'removed' | 'already_removed' | 'not_found';
      }>;
    }>
  | Readonly<{ operation: 'resurrect'; result: Readonly<{ path: AgentPath; sessionId: string; incarnation: string; state: 'idle' | 'running' }> }>;

export type SubagentProtocolErrorData = Readonly<{
  operationId: string;
  operation: SubagentOperationKind;
  message: string;
}>;

export type SubagentSnapshotEvent = Readonly<{
  type: 'subagent_snapshot';
  eventId: string;
  cursor: FeedCursor;
  manifest: SubagentPresentationManifest;
  nodes: readonly SubagentNodeSnapshot[];
  activeOperations: readonly SubagentOperationTarget[];
}>;

export type SubagentStartEvent = Readonly<{
  type: 'subagent_start';
  eventId: string;
  cursor: FeedCursor;
  target: SubagentOperationTarget;
  data: SubagentStartData;
}>;

export type SubagentDeltaEvent = Readonly<{
  type: 'subagent_delta';
  eventId: string;
  cursor: FeedCursor;
  target: SubagentOperationTarget;
  data: SubagentDeltaData;
}>;

export type SubagentEndEvent = Readonly<{
  type: 'subagent_end';
  eventId: string;
  cursor: FeedCursor;
  target: SubagentOperationTarget;
  state: 'complete' | 'error' | 'aborted';
  data: SubagentEndData;
}>;

export type SubagentFiniteEvent = Readonly<{
  type: 'subagent_snapshot_event';
  eventId: string;
  cursor: FeedCursor;
  target: SubagentOperationTarget;
  state: 'complete' | 'error' | 'aborted';
  data: SubagentFinalData;
}>;

export type SubagentTopologyEvent = SubagentEvent;

export type SubagentProviderEvent = SubagentTopologyEvent | SubagentSnapshotEvent | SubagentStartEvent | SubagentDeltaEvent | SubagentEndEvent | SubagentFiniteEvent;

export type PersistedSubagentContent = Readonly<{
  operationId: string;
  kind: SubagentOperationKind;
  placement: SubagentPlacement;
  state: 'complete' | 'error' | 'aborted';
  data: SubagentFinalData;
}>;

export type SubagentProviderSnapshot = Readonly<{
  manifest: SubagentPresentationManifest;
  nodes: readonly SubagentNodeSnapshot[];
  cursor: FeedCursor;
  activeOperations: readonly SubagentOperationTarget[];
}>;

export type SubagentPresentationReplay =
  | Readonly<{ kind: 'events'; cursor: FeedCursor; events: readonly SubagentProviderEvent[] }>
  | Readonly<{ kind: 'snapshot_required'; reason: 'epoch_changed' | 'history_unavailable' }>;

export interface SubagentPresentationProvider {
  snapshot(): SubagentProviderSnapshot;
  subscribe(listener: (event: SubagentProviderEvent) => void): () => void;
  replay(after?: FeedCursor): SubagentPresentationReplay;
  rehydrate(input: { session: BorrowedAgentSession; path: AgentPath }): Promise<void>;
}

export interface SubagentPresentationProviderOptions {
  manifest: SubagentPresentationManifest;
}

/** Interface-only factory. The provider implementation belongs to a later phase. */
export function createSubagentPresentationProvider(_options: SubagentPresentationProviderOptions): SubagentPresentationProvider {
  throw new Error('not implemented');
}
