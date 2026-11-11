import type { SubagentSemanticEvent as WireSubagentSemanticEvent } from '../../../shared/src/protocol.js';

export type SemanticBlockKind = 'delegation' | 'message_thread' | 'await_progress' | 'completion' | 'lifecycle';

export interface PiEventRef {
  readonly sessionId: string;
  readonly entryId?: string;
  readonly toolCallId?: string;
  readonly kind: 'message' | 'tool_call' | 'custom_message' | 'lifecycle';
}

export interface SemanticEventPlacement {
  readonly afterPiEvent?: PiEventRef;
  readonly sequence: number;
}

export type SemanticAgentPath = readonly string[];
export type SemanticChildState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead';

export interface SemanticChildResult {
  readonly path: SemanticAgentPath;
  readonly state: SemanticChildState;
  readonly output?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly contextPercent?: number;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface SemanticDelegationChild {
  readonly path: SemanticAgentPath;
  readonly prompt: string;
  readonly personaIcon?: string;
  readonly state?: SemanticChildState;
  readonly contextPercent?: number;
  readonly costUsd?: number;
}

type SemanticEventData =
  | { readonly kind: 'delegation'; readonly data: { readonly invocationId: string; readonly awaitsResult: boolean; readonly children: readonly SemanticDelegationChild[] } }
  | {
      readonly kind: 'message_thread';
      readonly data: {
        readonly correlationId?: string;
        readonly sourcePath: SemanticAgentPath;
        readonly targetPath: SemanticAgentPath;
        readonly request: string;
        readonly reply?: string;
        readonly failure?: string;
      };
    }
  | {
      readonly kind: 'await_progress';
      readonly data: {
        readonly phase: 'waiting' | 'interrupted' | 'completed';
        readonly children: readonly SemanticChildResult[];
        readonly interruption?: { readonly sourcePath: SemanticAgentPath; readonly text: string };
      };
    }
  | {
      readonly kind: 'completion';
      readonly data: { readonly result: SemanticChildResult } & (
        | { readonly delivery: 'awaited'; readonly invocationId: string }
        | { readonly delivery: 'asynchronous'; readonly invocationId?: string }
      );
    }
  | {
      readonly kind: 'lifecycle';
      readonly data: {
        readonly operation: 'interrupt' | 'teardown' | 'resurrect';
        readonly path: SemanticAgentPath;
        readonly outcome: 'succeeded' | 'failed';
        readonly output?: string;
        readonly error?: string;
      };
    };

export type SubagentSemanticEvent = SemanticEventData & {
  readonly eventId: string;
  readonly placement: SemanticEventPlacement;
  readonly relatedPiEvents: readonly PiEventRef[];
};

export interface SemanticBlockAction {
  readonly type: 'open_view' | 'retry' | 'resurrect';
  readonly path: SemanticAgentPath;
}

export type SemanticBlock = {
  readonly blockId: string;
  readonly eventId: string;
  readonly placement: SemanticEventPlacement;
  readonly relatedPiEvents: readonly PiEventRef[];
  readonly title: string;
  readonly transcriptText: string;
  readonly actions: readonly SemanticBlockAction[];
} & (
  | {
      readonly kind: 'delegation';
      readonly data: Extract<SemanticEventData, { kind: 'delegation' }>['data'] & { readonly results?: readonly SemanticChildResult[] };
    }
  | Exclude<SemanticEventData, { kind: 'delegation' }>
);

export interface SemanticReductionState {
  readonly blocks: readonly SemanticBlock[];
  readonly lastSequence: number;
}

export interface NativeTranscriptEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly kind: 'message' | 'tool_call' | 'tool_result' | 'custom_message' | 'lifecycle';
  readonly text?: string;
}

export type SemanticTranscriptItem = { readonly kind: 'native'; readonly entry: NativeTranscriptEntry } | { readonly kind: 'semantic'; readonly block: SemanticBlock };

export const EMPTY_SEMANTIC_REDUCTION: SemanticReductionState = {
  blocks: [],
  lastSequence: 0,
};

/** Reduce in feed order. Only awaited delegation results merge into their invocation block. */
export function reduceSubagentSemanticEvent(_state: SemanticReductionState, _event: SubagentSemanticEvent): SemanticReductionState {
  throw new Error('not implemented');
}

/** Replace referenced native rendering, retaining unreferenced entries as fallback. */
export function projectSubagentTranscript(_nativeEntries: readonly NativeTranscriptEntry[], _state: SemanticReductionState): readonly SemanticTranscriptItem[] {
  throw new Error('not implemented');
}

/** Project parent-stream semantic events and native entries into a user-facing transcript. */
export function projectSubagentWireTranscript(_nativeEntries: readonly NativeTranscriptEntry[], _events: readonly WireSubagentSemanticEvent[]): readonly SemanticTranscriptItem[] {
  throw new Error('not implemented');
}

/** Copy user-facing semantic transcript text without provider or attachment mechanics. */
export function copySubagentTranscript(_items: readonly SemanticTranscriptItem[]): string {
  throw new Error('not implemented');
}
