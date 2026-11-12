import type { SubagentSemanticEvent as WireSubagentSemanticEvent, SubagentTranscriptPosition, SubagentNativeOccurrence } from '../../../shared/src/protocol.js';
import { semanticEventIdentity } from '../../../shared/src/subagent-semantic-identity.js';

export type SemanticBlockKind = 'delegation' | 'message_thread' | 'await_progress' | 'completion' | 'lifecycle';

export interface PiEventRef {
  readonly sessionId: string;
  readonly entryId?: string;
  readonly toolCallId?: string;
  readonly kind: 'message' | 'tool_call' | 'custom_message' | 'lifecycle';
}

export interface SemanticEventPlacement {
  readonly afterPiEvent?: PiEventRef;
  readonly transcriptPosition?: SubagentTranscriptPosition;
  readonly sequence: number;
}

export type SemanticAgentPath = readonly string[];
export type SemanticChildState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead' | 'stopped';

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
  readonly persona?: string;
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
        readonly phase?: 'sent' | 'received' | 'response' | 'failure';
        readonly responseExpected?: boolean;
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
        readonly reason?: 'settled' | 'detach' | 'stop' | 'message';
        readonly invocationId?: string;
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
  readonly eventKey?: string;
  readonly nativeOccurrence?: SubagentNativeOccurrence;
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
  readonly eventIds?: readonly string[];
  readonly eventKeys?: readonly string[];
  readonly nativeOccurrence?: SubagentNativeOccurrence;
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

export interface SemanticTranscriptSurface {
  readonly sessionId: string;
  readonly path: SemanticAgentPath;
}

export interface SemanticReductionState {
  readonly blocks: readonly SemanticBlock[];
  readonly lastSequence: number;
}

export interface NativeTranscriptEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly messageIndex?: number;
  readonly semanticEventIds?: readonly string[];
  readonly kind: 'message' | 'tool_call' | 'tool_result' | 'custom_message' | 'lifecycle';
  readonly text?: string;
}

export type SemanticTranscriptItem = { readonly kind: 'native'; readonly entry: NativeTranscriptEntry } | { readonly kind: 'semantic'; readonly block: SemanticBlock };

export const EMPTY_SEMANTIC_REDUCTION: SemanticReductionState = {
  blocks: [],
  lastSequence: 0,
};

function copyPath(path: SemanticAgentPath): SemanticAgentPath {
  return Object.freeze([...path]);
}

function copyRef(ref: PiEventRef): PiEventRef {
  return Object.freeze({ ...ref });
}

function copyRefs(refs: readonly PiEventRef[]): readonly PiEventRef[] {
  return Object.freeze(refs.map(copyRef));
}

function pathText(path: SemanticAgentPath): string {
  return path.length > 0 ? path.join('/') : 'root';
}

function childActions(children: readonly { readonly path: SemanticAgentPath }[]): readonly SemanticBlockAction[] {
  const seen = new Set<string>();
  const actions: SemanticBlockAction[] = [];
  for (const child of children) {
    const path = copyPath(child.path);
    const key = JSON.stringify(path);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ type: 'open_view', path });
  }
  return Object.freeze(actions);
}

function resultAction(result: SemanticChildResult): readonly SemanticBlockAction[] {
  const actions: SemanticBlockAction[] = [{ type: 'open_view', path: copyPath(result.path) }];
  if (result.state === 'errored') actions.push({ type: 'retry', path: copyPath(result.path) });
  return Object.freeze(actions);
}

function usageText(result: SemanticChildResult): string {
  const parts: string[] = [];
  if (result.usage) parts.push(`↑${result.usage.inputTokens} · ↓${result.usage.outputTokens}`);
  if (result.contextPercent !== undefined) parts.push(`ctx${result.contextPercent}%`);
  if (result.costUsd !== undefined) parts.push(`$${result.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

function resultText(result: SemanticChildResult): string {
  const value = result.error ? `Error: ${result.error}` : result.output !== undefined ? `Output: ${result.output}` : `State: ${result.state}`;
  const usage = usageText(result);
  return usage ? `${value} · ${usage}` : value;
}

function delegationText(children: readonly SemanticDelegationChild[], results: readonly SemanticChildResult[] | undefined): string {
  const lines = children.map((child) => {
    const metadata = [
      child.persona ? `persona ${child.persona}` : undefined,
      child.state,
      child.contextPercent === undefined ? undefined : `ctx${child.contextPercent}%`,
      child.costUsd === undefined ? undefined : `$${child.costUsd.toFixed(2)}`,
    ].filter((part): part is string => part !== undefined);
    const suffix = metadata.length > 0 ? ` (${metadata.join(' · ')})` : '';
    return `${pathText(child.path)}: ${child.prompt}${suffix}`;
  });
  for (const result of results ?? []) {
    lines.push(`${pathText(result.path)} — ${resultText(result)}`);
  }
  return lines.join('\n');
}

function messageText(data: Extract<SemanticEventData, { kind: 'message_thread' }>['data']): string {
  const lines = [`${pathText(data.sourcePath)} → ${pathText(data.targetPath)}`, data.request];
  if (data.reply !== undefined) lines.push(`Reply: ${data.reply}`);
  if (data.failure !== undefined) lines.push(`Failure: ${data.failure}`);
  return lines.join('\n');
}

function awaitText(data: Extract<SemanticEventData, { kind: 'await_progress' }>['data']): string {
  const lines = data.children.map(
    (child) => `${pathText(child.path)} · ${child.state}${child.output ? ` · Output: ${child.output}` : ''}${child.error ? ` · Error: ${child.error}` : ''}`,
  );
  if (data.interruption) lines.push(`Interrupted by ${pathText(data.interruption.sourcePath)}: ${data.interruption.text}`);
  return lines.join('\n');
}

function awaitTitle(data: Extract<SemanticEventData, { kind: 'await_progress' }>['data']): string {
  if (data.phase === 'waiting') return 'Waiting for children';
  if (data.phase === 'completed') return 'Await completed';
  if (data.reason === 'stop') return 'Await stopped';
  return data.interruption ? 'Await interrupted by message' : 'Await interrupted';
}

function completionTitle(result: SemanticChildResult): string {
  switch (result.state) {
    case 'errored':
      return `${pathText(result.path)} errored`;
    case 'dead':
      return `${pathText(result.path)} ended`;
    case 'stopped':
      return `${pathText(result.path)} stopped`;
    default:
      return `${pathText(result.path)} completed`;
  }
}

function lifecycleTitle(data: Extract<SemanticEventData, { kind: 'lifecycle' }>['data']): string {
  const verb = data.operation === 'interrupt' ? 'interrupted' : data.operation === 'teardown' ? 'torn down' : 'resurrected';
  return `${pathText(data.path)} ${verb}`;
}

function lifecycleText(data: Extract<SemanticEventData, { kind: 'lifecycle' }>['data']): string {
  const outcome = data.outcome === 'succeeded' ? 'Succeeded' : 'Failed';
  const detail = data.error !== undefined ? `Error: ${data.error}` : data.output !== undefined ? data.output : '';
  return detail ? `${outcome}: ${detail}` : outcome;
}

function blockForEvent(event: SubagentSemanticEvent): SemanticBlock {
  const placement: SemanticEventPlacement = {
    sequence: event.placement.sequence,
    ...(event.placement.afterPiEvent ? { afterPiEvent: copyRef(event.placement.afterPiEvent) } : {}),
    ...(event.placement.transcriptPosition ? { transcriptPosition: Object.freeze({ ...event.placement.transcriptPosition }) } : {}),
  };
  const relatedPiEvents = copyRefs(event.relatedPiEvents);
  const base = {
    blockId: `subagent:${event.eventKey ?? event.eventId}`,
    eventId: event.eventId,
    eventIds: Object.freeze([event.eventId]),
    eventKeys: Object.freeze([event.eventKey ?? event.eventId]),
    ...(event.nativeOccurrence ? { nativeOccurrence: Object.freeze({ ...event.nativeOccurrence }) } : {}),
    placement,
    relatedPiEvents,
  };
  switch (event.kind) {
    case 'delegation': {
      const children = Object.freeze(
        event.data.children.map((child) => ({
          path: copyPath(child.path),
          prompt: child.prompt,
          ...(child.persona !== undefined ? { persona: child.persona } : {}),
          ...(child.personaIcon !== undefined ? { personaIcon: child.personaIcon } : {}),
          ...(child.state !== undefined ? { state: child.state } : {}),
          ...(child.contextPercent !== undefined ? { contextPercent: child.contextPercent } : {}),
          ...(child.costUsd !== undefined ? { costUsd: child.costUsd } : {}),
        })),
      );
      const data = {
        invocationId: event.data.invocationId,
        awaitsResult: event.data.awaitsResult,
        children,
      };
      return {
        ...base,
        title: 'Delegation started',
        transcriptText: delegationText(children, undefined),
        actions: childActions(children),
        kind: 'delegation',
        data,
      };
    }
    case 'message_thread':
      return {
        ...base,
        title:
          event.data.phase === 'failure' || event.data.failure !== undefined
            ? 'Message failed'
            : event.data.reply !== undefined
              ? 'Message thread'
              : event.data.phase === 'received'
                ? 'Message received'
                : 'Message sent',
        transcriptText: messageText(event.data),
        actions: [],
        kind: 'message_thread',
        data: {
          ...(event.data.correlationId !== undefined ? { correlationId: event.data.correlationId } : {}),
          ...(event.data.phase !== undefined ? { phase: event.data.phase } : {}),
          ...(event.data.responseExpected !== undefined ? { responseExpected: event.data.responseExpected } : {}),
          sourcePath: copyPath(event.data.sourcePath),
          targetPath: copyPath(event.data.targetPath),
          request: event.data.request,
          ...(event.data.reply !== undefined ? { reply: event.data.reply } : {}),
          ...(event.data.failure !== undefined ? { failure: event.data.failure } : {}),
        },
      };
    case 'await_progress':
      return {
        ...base,
        title: awaitTitle(event.data),
        transcriptText: awaitText(event.data),
        actions: childActions(event.data.children),
        kind: 'await_progress',
        data: {
          phase: event.data.phase,
          ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}),
          ...(event.data.invocationId !== undefined ? { invocationId: event.data.invocationId } : {}),
          children: Object.freeze(
            event.data.children.map((child) => ({
              path: copyPath(child.path),
              state: child.state,
              ...(child.output !== undefined ? { output: child.output } : {}),
              ...(child.error !== undefined ? { error: child.error } : {}),
              ...(child.costUsd !== undefined ? { costUsd: child.costUsd } : {}),
              ...(child.contextPercent !== undefined ? { contextPercent: child.contextPercent } : {}),
              ...(child.usage !== undefined ? { usage: { ...child.usage } } : {}),
            })),
          ),
          ...(event.data.interruption ? { interruption: { sourcePath: copyPath(event.data.interruption.sourcePath), text: event.data.interruption.text } } : {}),
        },
      };
    case 'completion': {
      const result = {
        path: copyPath(event.data.result.path),
        state: event.data.result.state,
        ...(event.data.result.output !== undefined ? { output: event.data.result.output } : {}),
        ...(event.data.result.error !== undefined ? { error: event.data.result.error } : {}),
        ...(event.data.result.costUsd !== undefined ? { costUsd: event.data.result.costUsd } : {}),
        ...(event.data.result.contextPercent !== undefined ? { contextPercent: event.data.result.contextPercent } : {}),
        ...(event.data.result.usage !== undefined ? { usage: { ...event.data.result.usage } } : {}),
      };
      return {
        ...base,
        title: completionTitle(result),
        transcriptText: resultText(result),
        actions: resultAction(result),
        kind: 'completion',
        data:
          event.data.delivery === 'awaited'
            ? { delivery: 'awaited', invocationId: event.data.invocationId, result }
            : { delivery: 'asynchronous', ...(event.data.invocationId ? { invocationId: event.data.invocationId } : {}), result },
      };
    }
    case 'lifecycle':
      return {
        ...base,
        title: lifecycleTitle(event.data),
        transcriptText: lifecycleText(event.data),
        actions:
          event.data.outcome === 'succeeded'
            ? event.data.operation === 'teardown'
              ? [{ type: 'resurrect', path: copyPath(event.data.path) }]
              : [{ type: 'open_view', path: copyPath(event.data.path) }]
            : [{ type: 'retry', path: copyPath(event.data.path) }],
        kind: 'lifecycle',
        data: {
          operation: event.data.operation,
          path: copyPath(event.data.path),
          outcome: event.data.outcome,
          ...(event.data.output !== undefined ? { output: event.data.output } : {}),
          ...(event.data.error !== undefined ? { error: event.data.error } : {}),
        },
      };
  }
}

function mergeRefs(left: readonly PiEventRef[], right: readonly PiEventRef[]): readonly PiEventRef[] {
  const merged: PiEventRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...left, ...right]) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(copyRef(ref));
  }
  return Object.freeze(merged);
}

function mergeAwaitedCompletion(state: SemanticReductionState, event: SubagentSemanticEvent): SemanticReductionState | undefined {
  if (event.kind !== 'completion' || event.data.delivery !== 'awaited') return undefined;
  const index = state.blocks.findIndex((block) => block.kind === 'delegation' && block.data.awaitsResult && block.data.invocationId === event.data.invocationId);
  if (index < 0) return undefined;

  const prior = state.blocks[index];
  if (prior.kind !== 'delegation') return undefined;
  const result = event.data.result;
  const results = [
    ...(prior.data.results ?? []).filter((item) => !samePath(item.path, result.path)),
    {
      path: copyPath(result.path),
      state: result.state,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.contextPercent !== undefined ? { contextPercent: result.contextPercent } : {}),
      ...(result.usage !== undefined ? { usage: { ...result.usage } } : {}),
    },
  ];
  const data = { ...prior.data, results: Object.freeze(results) };
  const block: SemanticBlock = {
    ...prior,
    eventIds: Object.freeze([...(prior.eventIds ?? [prior.eventId]), event.eventId]),
    eventKeys: Object.freeze([...(prior.eventKeys ?? [prior.eventId]), event.eventKey ?? event.eventId]),
    relatedPiEvents: mergeRefs(prior.relatedPiEvents, event.relatedPiEvents),
    transcriptText: delegationText(data.children, data.results),
    data,
  };
  const blocks = state.blocks.slice();
  blocks[index] = block;
  return {
    blocks: Object.freeze(blocks),
    lastSequence: Math.max(state.lastSequence, event.placement.sequence),
  };
}

function samePath(left: SemanticAgentPath, right: SemanticAgentPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function mergeToolMessageReply(state: SemanticReductionState, event: SubagentSemanticEvent): SemanticReductionState | undefined {
  if (event.kind !== 'message_thread' || event.nativeOccurrence || !event.data.correlationId || (event.data.reply === undefined && event.data.failure === undefined))
    return undefined;
  const index = state.blocks.findIndex(
    (block) =>
      block.kind === 'message_thread' &&
      !block.nativeOccurrence &&
      (block.data.phase === undefined || block.data.phase === 'sent') &&
      block.data.correlationId === event.data.correlationId &&
      block.data.reply === undefined &&
      block.data.failure === undefined &&
      block.relatedPiEvents.some(
        (prior) => prior.toolCallId !== undefined && event.relatedPiEvents.some((ref) => ref.sessionId === prior.sessionId && ref.toolCallId === prior.toolCallId),
      ),
  );
  const prior = state.blocks[index];
  if (!prior || prior.kind !== 'message_thread') return undefined;
  const updated = blockForEvent({
    ...event,
    data: {
      ...event.data,
      sourcePath: prior.data.sourcePath,
      targetPath: prior.data.targetPath,
      request: prior.data.request,
      responseExpected: prior.data.responseExpected ?? event.data.responseExpected,
    },
  });
  const blocks = state.blocks.slice();
  blocks[index] = {
    ...updated,
    blockId: prior.blockId,
    eventId: prior.eventId,
    eventIds: Object.freeze([...(prior.eventIds ?? [prior.eventId]), event.eventId]),
    eventKeys: Object.freeze([...(prior.eventKeys ?? [prior.eventId]), event.eventKey ?? event.eventId]),
    placement: prior.placement,
    relatedPiEvents: mergeRefs(prior.relatedPiEvents, event.relatedPiEvents),
  };
  return { blocks: Object.freeze(blocks), lastSequence: Math.max(state.lastSequence, event.placement.sequence) };
}

function mergeAwaitProgress(state: SemanticReductionState, event: SubagentSemanticEvent): SemanticReductionState | undefined {
  if (event.kind !== 'await_progress' || !event.data.invocationId) return undefined;
  const index = state.blocks.findIndex(
    (block) =>
      block.kind === 'await_progress' &&
      block.data.invocationId === event.data.invocationId &&
      block.relatedPiEvents.some((prior) => event.relatedPiEvents.some((ref) => ref.sessionId === prior.sessionId)),
  );
  const prior = state.blocks[index];
  if (!prior || prior.kind !== 'await_progress') return undefined;
  const children = [...prior.data.children];
  for (const child of event.data.children) {
    const childIndex = children.findIndex((item) => samePath(item.path, child.path));
    if (childIndex < 0) children.push(child);
    else children[childIndex] = child;
  }
  const updated = blockForEvent({ ...event, data: { ...event.data, children } });
  const blocks = state.blocks.slice();
  blocks[index] = {
    ...updated,
    blockId: prior.blockId,
    eventId: prior.eventId,
    eventIds: Object.freeze([...(prior.eventIds ?? [prior.eventId]), event.eventId]),
    eventKeys: Object.freeze([...(prior.eventKeys ?? [prior.eventId]), event.eventKey ?? event.eventId]),
    nativeOccurrence: prior.nativeOccurrence,
    placement: prior.placement,
    relatedPiEvents: mergeRefs(prior.relatedPiEvents, event.relatedPiEvents),
  };
  return { blocks: Object.freeze(blocks), lastSequence: Math.max(state.lastSequence, event.placement.sequence) };
}

/** Reduce in feed order while keeping invocation progress at its original anchor. */
export function reduceSubagentSemanticEvent(state: SemanticReductionState, event: SubagentSemanticEvent): SemanticReductionState {
  const duplicate = state.blocks.findIndex((block) => (block.eventKeys ?? [block.eventId]).includes(event.eventKey ?? event.eventId));
  if (duplicate >= 0) {
    const prior = state.blocks[duplicate];
    const refs = mergeRefs(prior.relatedPiEvents, event.relatedPiEvents);
    const blocks =
      refs.length > prior.relatedPiEvents.length ? state.blocks.map((block, index) => (index === duplicate ? { ...block, relatedPiEvents: refs } : block)) : state.blocks;
    return { blocks, lastSequence: Math.max(state.lastSequence, event.placement.sequence) };
  }

  const merged = mergeToolMessageReply(state, event) ?? mergeAwaitProgress(state, event) ?? mergeAwaitedCompletion(state, event);
  if (merged) return merged;

  const block = blockForEvent(event);
  return {
    blocks: Object.freeze([...state.blocks, block]),
    lastSequence: Math.max(state.lastSequence, event.placement.sequence),
  };
}

function refMatchesEntry(ref: PiEventRef, entry: NativeTranscriptEntry): boolean {
  if (ref.sessionId !== entry.sessionId) return false;
  if ((ref.kind === 'tool_call' || ref.kind === 'lifecycle') && (entry.kind === 'tool_call' || entry.kind === 'tool_result')) {
    return ref.toolCallId !== undefined ? ref.toolCallId === entry.toolCallId : ref.entryId !== undefined && ref.entryId === entry.id;
  }
  return (
    ref.toolCallId === undefined &&
    (ref.kind === 'custom_message' || ref.kind === 'lifecycle') &&
    (entry.kind === 'custom_message' || entry.kind === 'lifecycle') &&
    ref.entryId !== undefined &&
    ref.entryId === entry.id
  );
}

function matchingIndices(refs: readonly PiEventRef[], entries: readonly NativeTranscriptEntry[]): number[] {
  const indices: number[] = [];
  entries.forEach((entry, index) => {
    if (refs.some((ref) => refMatchesEntry(ref, entry))) indices.push(index);
  });
  return indices;
}

function projectableBlocks(
  entries: readonly NativeTranscriptEntry[],
  state: SemanticReductionState,
  surfaceSessionId?: string,
): readonly { readonly block: SemanticBlock; readonly anchor: number; readonly order: number; readonly consumed: readonly number[] }[] {
  const descriptors: { block: SemanticBlock; anchor: number; order: number; consumed: readonly number[] }[] = [];
  state.blocks.forEach((block, order) => {
    const occurrence = block.nativeOccurrence;
    if (occurrence) {
      if (surfaceSessionId !== undefined && occurrence.sessionId !== surfaceSessionId) return;
      const index = entries.findIndex(
        (entry, index) =>
          entry.sessionId === occurrence.sessionId &&
          entry.kind === 'custom_message' &&
          (occurrence.entryId !== undefined ? entry.id === occurrence.entryId : (entry.messageIndex ?? index) === occurrence.messageIndex),
      );
      if (index >= 0) descriptors.push({ block, anchor: index, order, consumed: [index] });
      return;
    }
    const refs = surfaceSessionId !== undefined ? block.relatedPiEvents.filter((ref) => ref.sessionId === surfaceSessionId) : block.relatedPiEvents;
    const relatedIndices = matchingIndices(refs, entries);
    if (!relatedIndices.some((index) => entries[index].kind === 'custom_message') && (block.eventKeys?.[0] ?? block.eventId) === block.eventId)
      entries.forEach((entry, index) => {
        if (
          (surfaceSessionId === undefined || entry.sessionId === surfaceSessionId) &&
          entry.kind === 'custom_message' &&
          (block.eventIds ?? [block.eventId]).some((id) => entry.semanticEventIds?.includes(id)) &&
          !relatedIndices.includes(index)
        )
          relatedIndices.push(index);
      });
    if (relatedIndices.length > 0) {
      const toolInvocations = new Map<string, number>();
      for (const index of relatedIndices) {
        const entry = entries[index];
        if (entry.kind === 'tool_call' || entry.kind === 'tool_result') {
          const key = JSON.stringify([entry.sessionId, entry.toolCallId ?? entry.id]);
          if (!toolInvocations.has(key)) toolInvocations.set(key, index);
        }
      }
      const messages = new Map<string, number>();
      for (const index of toolInvocations.values()) {
        const entry = entries[index];
        const key = JSON.stringify([entry.sessionId, entry.messageIndex ?? entry.id]);
        if (!messages.has(key)) messages.set(key, index);
      }
      const anchors = messages.size > 0 ? [...messages.values()] : [Math.min(...relatedIndices)];
      for (const anchor of anchors) {
        const scoped = anchors.length > 1 ? { ...block, blockId: `${block.blockId}:native:${entries[anchor].sessionId}:${entries[anchor].id}` } : block;
        descriptors.push({ block: scoped, anchor, order, consumed: relatedIndices });
      }
      return;
    }
    if (block.relatedPiEvents.some((ref) => ref.entryId !== undefined || ref.toolCallId !== undefined)) return;
    const position = block.placement.transcriptPosition;
    if (!position || (surfaceSessionId !== undefined && position.sessionId !== surfaceSessionId)) return;
    if (block.relatedPiEvents.length > 0 && !block.relatedPiEvents.some((ref) => ref.sessionId === position.sessionId)) return;
    const boundary = position.afterEntryId === null ? -1 : entries.findLastIndex((entry) => entry.sessionId === position.sessionId && entry.id === position.afterEntryId);
    let anchor = boundary >= 0 ? boundary : position.afterEntryId === null ? -1 : undefined;
    if (anchor === undefined && position.messageIndex !== undefined && Number.isInteger(position.messageIndex) && position.messageIndex >= 0) {
      const surfaceEntries = entries.filter((entry) => entry.sessionId === position.sessionId);
      const messageCount = Math.max(...surfaceEntries.map((entry) => entry.messageIndex ?? entries.indexOf(entry)), -1) + 1;
      if (position.messageIndex > messageCount) return;
      anchor = entries.findLastIndex((entry, index) => entry.sessionId === position.sessionId && (entry.messageIndex ?? index) < position.messageIndex!);
    }
    if (anchor === undefined || (entries.length > 0 && !entries.some((entry) => entry.sessionId === position.sessionId))) return;
    descriptors.push({ block, anchor, order, consumed: [] });
  });
  return Object.freeze(descriptors.sort((left, right) => left.anchor - right.anchor || left.block.placement.sequence - right.block.placement.sequence || left.order - right.order));
}

/** Replace referenced native rendering, retaining unreferenced entries as fallback. */
export function projectSubagentTranscript(
  nativeEntries: readonly NativeTranscriptEntry[],
  state: SemanticReductionState,
  surfaceSessionId?: string,
): readonly SemanticTranscriptItem[] {
  const descriptors = projectableBlocks(nativeEntries, state, surfaceSessionId);
  const hidden = new Set<number>();
  for (const descriptor of descriptors) {
    for (const index of descriptor.consumed) hidden.add(index);
  }

  const output: SemanticTranscriptItem[] = [];
  const appendAt = (anchor: number): void => {
    for (const descriptor of descriptors) {
      if (descriptor.anchor !== anchor) continue;
      output.push({ kind: 'semantic', block: descriptor.block });
    }
  };

  appendAt(-1);
  nativeEntries.forEach((entry, index) => {
    if (!hidden.has(index)) output.push({ kind: 'native', entry });
    appendAt(index);
  });
  return Object.freeze(output);
}

function wireRef(ref: { readonly sessionId: string; readonly entryId?: string; readonly toolCallId?: string; readonly kind: PiEventRef['kind'] }): PiEventRef {
  return copyRef(ref);
}

function wirePlacement(event: WireSubagentSemanticEvent): SemanticEventPlacement {
  const afterPiEvent = event.relatedPiEvents.length > 0 ? wireRef(event.relatedPiEvents[event.relatedPiEvents.length - 1]!) : undefined;
  return {
    sequence: event.cursor,
    ...(afterPiEvent ? { afterPiEvent } : {}),
    ...(event.transcriptPosition ? { transcriptPosition: Object.freeze({ ...event.transcriptPosition }) } : {}),
  };
}

function childResultFromWire(status: {
  readonly path: readonly string[];
  readonly state: 'running' | 'waiting' | 'idle' | 'errored' | 'dead' | 'stopped';
  readonly output?: string;
  readonly error?: string;
}): SemanticChildResult {
  return {
    path: copyPath(status.path),
    state: status.state,
    ...(status.output !== undefined ? { output: status.output } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
  };
}

function wireOutcome(value: string | undefined): 'succeeded' | 'failed' {
  return value === undefined || value === 'succeeded' || value === 'success' || value === 'ok' ? 'succeeded' : 'failed';
}

interface ThreadMemory {
  readonly sourcePath: SemanticAgentPath;
  readonly targetPath: SemanticAgentPath;
  readonly request: string;
}

function mapWireEvent(event: WireSubagentSemanticEvent, threads: Map<string, ThreadMemory>): SubagentSemanticEvent | undefined {
  const placement = wirePlacement(event);
  const relatedPiEvents = Object.freeze(event.relatedPiEvents.map(wireRef));
  switch (event.kind) {
    case 'delegation':
      return {
        eventId: event.eventId,
        placement,
        relatedPiEvents,
        kind: 'delegation',
        data: {
          invocationId: event.data.invocationId,
          awaitsResult: event.data.awaitsResult,
          children: Object.freeze(
            event.data.children.map((child) => ({
              path: copyPath(child.path),
              prompt: child.task,
              ...(child.persona !== undefined ? { persona: child.persona } : {}),
            })),
          ),
        },
      };
    case 'message_thread': {
      const data = event.data;
      const key = data.correlationId;
      const prior = key ? threads.get(key) : undefined;
      if (data.phase === 'sent' || data.phase === 'received') {
        const sourcePath = copyPath(data.from);
        const targetPath = copyPath(data.to);
        const request = data.text;
        if (key && (data.phase === 'sent' || !prior)) threads.set(key, { sourcePath, targetPath, request });
        return {
          eventId: event.eventId,
          placement,
          relatedPiEvents,
          kind: 'message_thread',
          data: {
            sourcePath,
            targetPath,
            request,
            ...(key ? { correlationId: key } : {}),
            phase: data.phase,
            responseExpected: data.responseExpected,
          },
        };
      }
      const sourcePath = prior?.sourcePath ?? copyPath(data.from);
      const targetPath = prior?.targetPath ?? copyPath(data.to);
      const request = prior?.request ?? (data.phase === 'response' ? '' : data.text);
      return {
        eventId: event.eventId,
        placement,
        relatedPiEvents,
        kind: 'message_thread',
        data: {
          sourcePath,
          targetPath,
          request,
          ...(key ? { correlationId: key } : {}),
          phase: data.phase,
          responseExpected: data.responseExpected,
          ...(data.phase === 'response' ? { reply: data.text } : { failure: data.phase === 'failure' ? data.error : undefined }),
        },
      };
    }
    case 'await_started':
    case 'child_settled':
    case 'await_interrupted':
    case 'await_released': {
      const statuses = event.data.statuses?.map(childResultFromWire) ?? event.data.requested?.map((path) => ({ path: copyPath(path), state: 'waiting' as const })) ?? [];
      const interruption =
        event.kind === 'await_interrupted' && event.data.message
          ? {
              sourcePath: copyPath(event.data.message.from),
              text: event.data.message.text,
            }
          : undefined;
      const interrupted = event.kind === 'await_interrupted' || (event.kind === 'await_released' && (event.data.reason === 'message' || event.data.reason === 'stop'));
      return {
        eventId: event.eventId,
        placement,
        relatedPiEvents,
        kind: 'await_progress',
        data: {
          phase: interrupted ? 'interrupted' : event.kind === 'await_released' ? 'completed' : 'waiting',
          ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}),
          ...(event.data.invocationId ? { invocationId: event.data.invocationId } : {}),
          children: Object.freeze(statuses),
          ...(interruption ? { interruption } : {}),
        },
      };
    }
    case 'completion': {
      const result: SemanticChildResult = {
        path: copyPath(event.path),
        state: event.data.status,
        ...(event.data.output !== undefined ? { output: event.data.output } : {}),
        ...(event.data.error !== undefined ? { error: event.data.error } : {}),
        ...(event.data.usage
          ? {
              usage: {
                inputTokens: event.data.usage.input,
                outputTokens: event.data.usage.output,
              },
              costUsd: event.data.usage.cost,
            }
          : {}),
      };
      return {
        eventId: event.eventId,
        placement,
        relatedPiEvents,
        kind: 'completion',
        data:
          event.data.delivery === 'awaited'
            ? { delivery: 'awaited', invocationId: event.data.invocationId, result }
            : { delivery: 'asynchronous', ...(event.data.invocationId ? { invocationId: event.data.invocationId } : {}), result },
      };
    }
    case 'interrupt':
    case 'teardown':
    case 'resurrect': {
      const path = event.data.path ? copyPath(event.data.path) : copyPath(event.path);
      return {
        eventId: event.eventId,
        placement,
        relatedPiEvents,
        kind: 'lifecycle',
        data: {
          operation: event.kind,
          path,
          outcome: wireOutcome(event.data.outcome),
          ...(event.data.output !== undefined ? { output: event.data.output } : {}),
          ...(event.data.error !== undefined ? { error: event.data.error } : {}),
        },
      };
    }
    case 'node_added':
    case 'node_updated':
    case 'node_removed':
    case 'runtime_replaced':
      return undefined;
  }
}

/** Reduce parent-stream wire facts into the semantic projection used by the client. */
export function reduceSubagentWireSemanticEvents(events: readonly WireSubagentSemanticEvent[], surface?: SemanticTranscriptSurface): SemanticReductionState {
  const identities = new Map<string, string>();
  const collidingIds = new Set<string>();
  for (const event of events) {
    const identity = semanticEventIdentity(event);
    const prior = identities.get(event.eventId);
    if (prior !== undefined && prior !== identity) collidingIds.add(event.eventId);
    identities.set(event.eventId, identity);
  }
  const threads = new Map<string, ThreadMemory>();
  let reduction = EMPTY_SEMANTIC_REDUCTION;
  for (const event of events) {
    let candidate = event;
    if (event.kind === 'child_settled') {
      const wait = reduction.blocks.find(
        (block) =>
          block.kind === 'await_progress' &&
          block.data.phase === 'waiting' &&
          block.relatedPiEvents.some(
            (prior) => prior.toolCallId !== undefined && event.relatedPiEvents.some((ref) => ref.sessionId === prior.sessionId && ref.toolCallId === prior.toolCallId),
          ),
      );
      if (!wait || wait.kind !== 'await_progress') continue;
      candidate = { ...event, data: { ...event.data, invocationId: wait.data.invocationId } };
    }
    const mapped = mapWireEvent(candidate, threads);
    if (!mapped) continue;
    if (surface && event.kind === 'message_thread') {
      const ownsFrom = samePath(surface.path, event.data.from);
      const ownsTo = samePath(surface.path, event.data.to);
      if (event.data.phase === 'sent' ? !ownsFrom : event.data.phase === 'received' ? !ownsTo : !ownsFrom && !ownsTo) continue;
    }
    const occurrence = event.nativeOccurrence;
    const eventKey = occurrence
      ? JSON.stringify([semanticEventIdentity(event), occurrence.sessionId, occurrence.entryId ?? occurrence.messageIndex])
      : collidingIds.has(event.eventId)
        ? semanticEventIdentity(event)
        : event.eventId;
    reduction = reduceSubagentSemanticEvent(reduction, { ...mapped, eventKey, ...(occurrence ? { nativeOccurrence: occurrence } : {}) });
  }
  return reduction;
}

/** Project parent-stream semantic events and native entries into a user-facing transcript. */
export function projectSubagentWireTranscript(
  nativeEntries: readonly NativeTranscriptEntry[],
  events: readonly WireSubagentSemanticEvent[],
  surface?: SemanticTranscriptSurface,
): readonly SemanticTranscriptItem[] {
  return projectSubagentTranscript(nativeEntries, reduceSubagentWireSemanticEvents(events, surface), surface?.sessionId);
}

/** Copy user-facing semantic transcript text without provider or attachment mechanics. */
export function copySubagentTranscript(items: readonly SemanticTranscriptItem[]): string {
  return items
    .map((item) => (item.kind === 'semantic' ? item.block.transcriptText : (item.entry.text ?? '')))
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}
