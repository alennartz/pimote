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

export interface SubagentSemanticEvent {
  readonly eventId: string;
  readonly kind: SemanticBlockKind;
  readonly placement: SemanticEventPlacement;
  readonly relatedPiEvents: readonly PiEventRef[];
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SemanticBlock {
  readonly blockId: string;
  readonly eventId: string;
  readonly kind: SemanticBlockKind;
  readonly placement: SemanticEventPlacement;
  readonly relatedPiEvents: readonly PiEventRef[];
  readonly title: string;
  readonly transcriptText: string;
}

export interface SemanticReductionState {
  readonly blocks: readonly SemanticBlock[];
  readonly lastSequence: number;
}

export interface NativeTranscriptEntry {
  readonly id: string;
  readonly kind: 'message' | 'tool_call' | 'tool_result' | 'custom_message' | 'lifecycle';
  readonly text?: string;
}

export type SemanticTranscriptItem = { readonly kind: 'native'; readonly entry: NativeTranscriptEntry } | { readonly kind: 'semantic'; readonly block: SemanticBlock };

export const EMPTY_SEMANTIC_REDUCTION: SemanticReductionState = {
  blocks: [],
  lastSequence: 0,
};

/** Apply one semantic event in feed order. Later events never rewrite prior blocks. */
export function reduceSubagentSemanticEvent(_state: SemanticReductionState, _event: SubagentSemanticEvent): SemanticReductionState {
  throw new Error('not implemented');
}

/** Place semantic blocks beside their native provenance while preserving native transcript order. */
export function projectSubagentTranscript(_nativeEntries: readonly NativeTranscriptEntry[], _state: SemanticReductionState): readonly SemanticTranscriptItem[] {
  throw new Error('not implemented');
}

/** Copy user-facing semantic transcript text without provider or attachment mechanics. */
export function copySubagentTranscript(_items: readonly SemanticTranscriptItem[]): string {
  throw new Error('not implemented');
}
