import type { AgentPath, SubagentProviderControls, SubagentSettlementState, SubagentTopologyEvent, SubagentTopologySnapshot, SubagentUsage } from './types.js';

/**
 * Presentation is a pure function of native pi data.
 *
 * Tools stream progress through `onUpdate` details, tool results and custom
 * messages carry final details, and the provider's presenters map that data to
 * typed card data. Pimote calls the same presenters for live events and for
 * saved entries, so a live card and a reloaded card cannot differ.
 */

export type SubagentOperationKind = 'send' | 'message_received' | 'respond' | 'await' | 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect';

export type SubagentPresentationState = 'active' | 'complete' | 'error' | 'aborted';

/** Child state as an operation reports it. `held` and `removed` are outcomes, not registry states. */
export type SubagentAgentOutcome = 'running' | 'waiting' | SubagentSettlementState | 'held' | 'removed';

export type SubagentAgentStatus = Readonly<{
  path: AgentPath;
  state: SubagentAgentOutcome;
  output?: string;
  error?: string;
  sessionId?: string;
  usage?: SubagentUsage;
  /** A settlement that replaced a held one the parent never received. */
  replacedHeldResult?: boolean;
}>;

export type SubagentDelegatedAgent = Readonly<{
  id: string;
  task: string;
  persona?: string;
  model?: string;
  cwd?: string;
  channels?: ReadonlyArray<string>;
}>;

export type SubagentDelegatedChild = Readonly<{
  path: AgentPath;
  task: string;
  persona?: string;
  status?: SubagentAgentOutcome;
}>;

/** One agent affected by a teardown or resurrection. */
export type SubagentAffectedAgent = Readonly<{
  path: AgentPath;
  sessionId: string;
  incarnation?: string;
  state: SubagentAgentOutcome;
  usage?: SubagentUsage;
  task?: string;
  channels?: ReadonlyArray<string>;
  model?: string;
  output?: string;
  error?: string;
}>;

export type SubagentInterruptTarget = Readonly<{ path: AgentPath; output?: string; error?: string }>;

export type SubagentResurrectItem = Readonly<{
  sessionId: string;
  id: string;
  task: string;
  channels?: ReadonlyArray<string>;
  model?: string;
}>;

/** Who started a lifecycle operation: the model through a tool, or the user through Pimote. */
export type SubagentOperationSource = 'model' | 'user';

/** Typed card data, one variant per operation kind. */
export type SubagentPresentationData =
  | Readonly<{
      operation: 'delegation';
      parameters: Readonly<{ agents: ReadonlyArray<SubagentDelegatedAgent>; fork: boolean }>;
      result: Readonly<{ children: ReadonlyArray<SubagentDelegatedChild>; error?: string }>;
    }>
  | Readonly<{
      operation: 'send';
      parameters: Readonly<{ to: string; target?: AgentPath; message: string; expectResponse: boolean }>;
      result: Readonly<{ phase: 'sending' | 'waiting' | 'responding' | 'complete'; response?: string; error?: string }>;
    }>
  | Readonly<{
      operation: 'message_received';
      parameters: Readonly<{ from: AgentPath; message: string; expectResponse: boolean }>;
      result: Readonly<{ error?: string }>;
    }>
  | Readonly<{
      operation: 'respond';
      parameters: Readonly<{ to?: AgentPath; message: string }>;
      result: Readonly<{ error?: string }>;
    }>
  | Readonly<{
      operation: 'await';
      parameters: Readonly<{ agents?: ReadonlyArray<string> }>;
      result: Readonly<{ statuses: ReadonlyArray<SubagentAgentStatus>; interrupted?: boolean; error?: string }>;
    }>
  | Readonly<{
      operation: 'completion';
      parameters: Readonly<Record<never, never>>;
      result: SubagentAgentStatus;
    }>
  | Readonly<{
      operation: 'interrupt';
      parameters: Readonly<{ agents?: ReadonlyArray<string> }>;
      result: Readonly<{
        interrupted: ReadonlyArray<SubagentInterruptTarget>;
        pending: ReadonlyArray<SubagentInterruptTarget>;
        failed: ReadonlyArray<SubagentInterruptTarget>;
        error?: string;
      }>;
    }>
  | Readonly<{
      operation: 'teardown';
      parameters: Readonly<{ agent?: string; source: SubagentOperationSource }>;
      result: Readonly<{ affectedAgents: ReadonlyArray<SubagentAffectedAgent>; error?: string }>;
    }>
  | Readonly<{
      operation: 'resurrect';
      parameters: Readonly<{ agents: ReadonlyArray<SubagentResurrectItem>; source: SubagentOperationSource }>;
      result: Readonly<{ affectedAgents: ReadonlyArray<SubagentAffectedAgent>; error?: string }>;
    }>;

/** One card. `path` is the root-relative agent that performed the operation. */
export type SubagentPresentation = Readonly<{
  kind: SubagentOperationKind;
  state: SubagentPresentationState;
  path: AgentPath;
  data: SubagentPresentationData;
}>;

/** A JSON value: what tool arguments, progress, and details hold once saved. */
export type SubagentJsonValue = string | number | boolean | null | ReadonlyArray<SubagentJsonValue> | SubagentJsonObject;
export type SubagentJsonObject = { readonly [key: string]: SubagentJsonValue };

/** What Pimote knows about a tool call when it asks for its card. */
export type SubagentToolExecution =
  /** Arguments are still streaming or the call has not started. */
  | Readonly<{ state: 'pending' }>
  /** The call runs. `progress` is the latest `onUpdate` details, when any arrived. */
  | Readonly<{ state: 'running'; progress?: SubagentJsonValue }>
  /** The call finished. `text` is the result's text content. */
  | Readonly<{ state: 'complete' | 'error'; details?: SubagentJsonValue; text: string }>
  /** The assistant message ended without a result for this call. */
  | Readonly<{ state: 'aborted' }>;

export type SubagentToolCallInput = Readonly<{
  /** Root-relative path of the session that holds the call. */
  ownerPath: AgentPath;
  toolName: string;
  toolCallId: string;
  /** Partial while streaming, final once `argsComplete`. */
  args: SubagentJsonObject;
  argsComplete: boolean;
  execution: SubagentToolExecution;
}>;

export type SubagentMessageInput = Readonly<{
  ownerPath: AgentPath;
  customType: string;
  content: string;
  details?: SubagentJsonValue;
}>;

/**
 * Pure presenters. They read only their input, return the same output for the
 * same input, and never throw for malformed input: they return `undefined`,
 * and Pimote renders the native content instead.
 */
export interface SubagentPresenters {
  /** Tool names `presentToolCall` covers. */
  readonly toolNames: ReadonlyArray<string>;
  /** Custom message types `presentMessage` covers. */
  readonly customTypes: ReadonlyArray<string>;
  presentToolCall(input: SubagentToolCallInput): SubagentPresentation | undefined;
  /** One custom message can carry several operations, in order. */
  presentMessage(input: SubagentMessageInput): ReadonlyArray<SubagentPresentation> | undefined;
  /**
   * The latest `onUpdate` details of a call that still runs, for a surface
   * that attaches after the call started. `undefined` once the call ends.
   */
  runningToolProgress(input: Readonly<{ sessionId: string; toolCallId: string }>): SubagentJsonValue | undefined;
}

/** One provider per root session: topology, controls, and presenters. */
export interface SubagentPresentationProvider extends SubagentProviderControls {
  snapshot(): SubagentTopologySnapshot;
  /** Subscribe before reading the snapshot, then drop events at or below its sequence. */
  subscribe(listener: (event: SubagentTopologyEvent) => void): () => void;
  readonly presenters: SubagentPresenters;
}
