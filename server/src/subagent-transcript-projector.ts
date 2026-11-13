import type { PimoteAgentMessage, PimoteMessageContent, PimoteSessionEvent, StreamingMessage } from '../../shared/dist/index.js';
import type {
  ActiveSubagentOperation,
  SubagentDeltaData,
  SubagentEndData,
  SubagentOperationTarget,
  SubagentPresentationManifest,
  SubagentProviderEvent,
  SubagentStartData,
} from '@pimote/sdk/subagents';
import { mapAgentMessage, mapCustomEntry } from './message-mapper.js';
import type { IncomingSdkEvent } from './event-buffer.js';

export interface SubagentProjectionSnapshot {
  readonly messages: readonly PimoteAgentMessage[];
  readonly activeOperations: readonly ActiveSubagentOperation[];
}

export interface SubagentTranscriptProjectorOptions {
  readonly sessionId: string;
  readonly manifest: SubagentPresentationManifest;
}

/** Server-side transcript projection seam for native and semantic events. */
export interface SubagentTranscriptProjector {
  acceptNativeEvent(event: IncomingSdkEvent): readonly PimoteSessionEvent[];
  acceptProviderEvent(event: SubagentProviderEvent): readonly PimoteSessionEvent[];
  snapshot(): SubagentProjectionSnapshot;
  rehydrate(messages: readonly PimoteAgentMessage[]): void;
  /** Remove declared native replacement blocks from an in-flight message. */
  projectStreamingMessage?(message: StreamingMessage): StreamingMessage;
  /** Restore provider active state without replaying its live deltas. */
  hydrateActiveOperations?(operations: readonly ActiveSubagentOperation[]): void;
  /** Preserve projected blocks when a fresh surface replaces its provider. */
  restoreProjection?(snapshot: SubagentProjectionSnapshot): void;
  /** Remap visible streaming content indexes after hidden slots are removed. */
  projectNativeEvent?(event: IncomingSdkEvent): IncomingSdkEvent | undefined;
  /** True when the native event is a declared replacement. */
  isNativeEventSuppressed?(event: IncomingSdkEvent): boolean;
}

type Slot = Readonly<{ messageIndex: number; contentIndex: number; parentMessageId: string }>;
type MutableSlot = { messageIndex: number; contentIndex: number; parentMessageId: string };
type NativeBlock = { sourceIndex: number; content: PimoteMessageContent };
type ProjectedSource = { messageIndex: number; sourceIndex: number; order: number };
type OperationRecord = { target: SubagentOperationTarget; data: SubagentStartData; slot: MutableSlot };
type ProtocolErrorData = Readonly<{ operation: 'protocol_error'; message: string }>;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const PRESENTATION_KINDS = new Set<SubagentOperationKindLike>(['send', 'respond', 'await', 'delegation', 'completion', 'interrupt', 'teardown', 'resurrect']);
const FINAL_STATES = new Set(['complete', 'error', 'aborted']);

function isPersistedSubagentContent(value: unknown): boolean {
  if (!isObject(value) || typeof value.operationId !== 'string' || value.operationId.length === 0) return false;
  if (typeof value.kind !== 'string' || !PRESENTATION_KINDS.has(value.kind as SubagentOperationKindLike)) return false;
  if (typeof value.state !== 'string' || !FINAL_STATES.has(value.state)) return false;
  if (!isObject(value.data)) return false;
  const operation = value.data.operation;
  if (operation !== value.kind && operation !== 'protocol_error') return false;
  if (value.source !== 'tool' && value.source !== 'custom_entry') return false;
  if (value.source === 'tool') {
    if (!isObject(value.placement) || typeof value.placement.toolCallId !== 'string' || !Number.isInteger(value.placement.contentIndex)) return false;
    if (value.placement.entryId !== undefined && typeof value.placement.entryId !== 'string') return false;
  } else if (value.placement !== undefined && (!isObject(value.placement) || typeof value.placement.entryId !== 'string')) {
    return false;
  }
  return true;
}

const cloneContent = (content: PimoteMessageContent): PimoteMessageContent => ({ ...content });
const cloneMessage = (message: PimoteAgentMessage): PimoteAgentMessage => ({ ...message, content: message.content.map(cloneContent) });
const clonePath = (path: readonly string[]): readonly string[] => Object.freeze([...path]);
const cloneTarget = (target: SubagentOperationTarget): SubagentOperationTarget => ({
  ...target,
  path: clonePath(target.path),
  placement: target.placement ? { ...target.placement } : undefined,
});
const operationKey = (target: SubagentOperationTarget): string => target.operationId;

function operationState(state: 'complete' | 'error' | 'aborted'): 'complete' | 'error' | 'aborted' {
  return state;
}

function nativeToolName(event: IncomingSdkEvent): string | undefined {
  if (event.type === 'tool_execution_start') return event.toolName;
  if (event.type !== 'message_update') return undefined;
  const update = event.assistantMessageEvent;
  if (!update.type.startsWith('toolcall_')) return undefined;
  if ('partial' in update && 'contentIndex' in update) {
    const block = update.partial.content[update.contentIndex];
    if (block?.type === 'toolCall') return block.name;
  }
  return undefined;
}

function nativeToolCallId(event: IncomingSdkEvent): string | undefined {
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') return event.toolCallId;
  if (event.type !== 'message_update') return undefined;
  const update = event.assistantMessageEvent;
  if (!update.type.startsWith('toolcall_') || !('partial' in update) || !('contentIndex' in update)) return undefined;
  const block = update.partial.content[update.contentIndex];
  return block?.type === 'toolCall' ? block.id : undefined;
}

function isToolLifecycleEnd(event: IncomingSdkEvent): boolean {
  return event.type === 'tool_execution_end';
}

function dataForProtocolError(operation: SubagentOperationKindLike, message: string): ProtocolErrorData {
  void operation;
  return { operation: 'protocol_error', message };
}

type SubagentOperationKindLike = SubagentOperationTarget['kind'];

function mapSubagentBlock(
  operationId: string,
  kind: SubagentOperationKindLike,
  state: PimoteMessageContent['subagentState'],
  data: unknown,
  placement: SubagentOperationTarget['placement'],
): PimoteMessageContent {
  return {
    type: 'subagent',
    operationId,
    subagentKind: kind,
    subagentState: state ?? 'active',
    ...(placement ? { placement: { ...placement } } : {}),
    data: data as never,
  } as unknown as PimoteMessageContent;
}

function stateFromEnd(state: 'complete' | 'error' | 'aborted'): 'complete' | 'error' | 'aborted' {
  return operationState(state);
}

function isSubagentContent(content: PimoteMessageContent): content is Extract<PimoteMessageContent, { type: 'subagent' }> {
  return content.type === 'subagent';
}

/**
 * Project the declared native replacements into one ordered transcript.
 * Native Pi arguments and results never enter projected messages.
 */
export function createSubagentTranscriptProjector(options: SubagentTranscriptProjectorOptions): SubagentTranscriptProjector {
  const hiddenTools = new Set(options.manifest.hiddenToolNames);
  const hiddenCustomTypes = new Set(options.manifest.hiddenCustomTypes);
  let messages: PimoteAgentMessage[] = [];
  let nativeBlocks: NativeBlock[][] = [];
  const hiddenToolCalls = new Set<string>();
  const hiddenToolSlots = new Map<string, MutableSlot>();
  const hiddenCustomEntries = new Set<string>();
  const operations = new Map<string, OperationRecord>();
  const completedOperations = new Set<string>();
  const completedTargets = new Map<string, SubagentOperationTarget>();
  const seenProviderEvents = new Set<string>();
  const operationSlots = new Map<string, MutableSlot>();
  const projectedSources = new Map<string, ProjectedSource>();
  const customProtocolErrors = new Map<string, string>();
  let nextProjectedOrder = 0;
  let streamingAssistantSlot: MutableSlot | undefined;
  const hiddenStreamingIndexes = new Set<number>();

  const messageId = (message: PimoteAgentMessage, index: number): string => message.entryId ?? `message-${index}`;

  const seedStreamingHiddenState = (message: StreamingMessage): void => {
    if (message.role !== 'assistant') return;
    const messageIndex = streamingAssistantSlot?.messageIndex ?? messages.length;
    const parentMessageId = streamingAssistantSlot?.parentMessageId ?? `message-${messageIndex}`;
    streamingAssistantSlot = {
      messageIndex,
      contentIndex: streamingAssistantSlot?.contentIndex ?? 0,
      parentMessageId,
    };
    for (const [contentIndex, block] of message.content.entries()) {
      const hidden =
        (block.type === 'tool_call' &&
          ((block.toolName !== undefined && hiddenTools.has(block.toolName)) || (block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId)))) ||
        (block.type === 'tool_result' &&
          ((block.toolName !== undefined && hiddenTools.has(block.toolName)) || (block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId))));
      if (hidden) hiddenStreamingIndexes.add(contentIndex);
      if (block.type === 'tool_call' && block.toolCallId && ((block.toolName !== undefined && hiddenTools.has(block.toolName)) || hiddenToolCalls.has(block.toolCallId))) {
        hiddenToolCalls.add(block.toolCallId);
        if (!hiddenToolSlots.has(block.toolCallId)) {
          hiddenToolSlots.set(block.toolCallId, { messageIndex, contentIndex, parentMessageId });
        }
      }
    }
  };

  const visibleContentFor = (message: PimoteAgentMessage, messageIndex: number): { content: PimoteMessageContent[]; slots: NativeBlock[] } => {
    const content: PimoteMessageContent[] = [];
    const slots: NativeBlock[] = [];
    message.content.forEach((block, sourceIndex) => {
      const hiddenTool =
        (block.type === 'tool_call' && block.toolName !== undefined && hiddenTools.has(block.toolName)) ||
        (block.type === 'tool_result' &&
          ((block.toolName !== undefined && hiddenTools.has(block.toolName)) || (block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId))));
      if (hiddenTool) {
        if (block.toolCallId) {
          hiddenToolCalls.add(block.toolCallId);
          if (!hiddenToolSlots.has(block.toolCallId))
            hiddenToolSlots.set(block.toolCallId, { messageIndex, contentIndex: sourceIndex, parentMessageId: messageId(message, messageIndex) });
        }
        return;
      }
      if (block.type === 'subagent') {
        content.push(cloneContent(block));
        return;
      }
      content.push(cloneContent(block));
      slots.push({ sourceIndex, content: content[content.length - 1] });
    });
    return { content, slots };
  };

  const findMessageByEntry = (entryId: string): number => messages.findIndex((message) => message.entryId === entryId);

  const messageForTarget = (target: SubagentOperationTarget): Slot => {
    const placement = target.placement;
    if (placement && 'entryId' in placement && !('toolCallId' in placement)) {
      const byEntry = findMessageByEntry(placement.entryId);
      if (byEntry >= 0) return { messageIndex: byEntry, contentIndex: 0, parentMessageId: messageId(messages[byEntry], byEntry) };
      const messageIndex = messages.push({ role: 'custom', entryId: placement.entryId, content: [] }) - 1;
      nativeBlocks.push([]);
      hiddenCustomEntries.add(placement.entryId);
      return { messageIndex, contentIndex: 0, parentMessageId: placement.entryId };
    }
    if (placement && 'toolCallId' in placement) {
      const hiddenSlot = hiddenToolSlots.get(placement.toolCallId);
      if (hiddenSlot) return { ...hiddenSlot };
      if (streamingAssistantSlot) {
        const streamingSlot = { ...streamingAssistantSlot, contentIndex: placement.contentIndex };
        return streamingSlot;
      }
      for (const [messageIndex, blocks] of nativeBlocks.entries()) {
        const match = blocks.find((block) => block.content.toolCallId === placement.toolCallId);
        if (match) return { messageIndex, contentIndex: match.sourceIndex, parentMessageId: messageId(messages[messageIndex], messageIndex) };
      }
      for (const [messageIndex, message] of messages.entries()) {
        const match = message.content.findIndex((block) => block.toolCallId === placement.toolCallId);
        if (match >= 0) return { messageIndex, contentIndex: match, parentMessageId: messageId(message, messageIndex) };
      }
      // A streamed tool call can start before its persisted assistant message.
      const assistantIndex = messages.findIndex((message) => message.role === 'assistant');
      if (assistantIndex >= 0) return { messageIndex: assistantIndex, contentIndex: placement.contentIndex, parentMessageId: messageId(messages[assistantIndex], assistantIndex) };
    }
    const assistantIndex = messages.findIndex((message) => message.role === 'assistant');
    if (assistantIndex >= 0)
      return {
        messageIndex: assistantIndex,
        contentIndex: placement && 'toolCallId' in placement ? placement.contentIndex : messages[assistantIndex].content.length,
        parentMessageId: messageId(messages[assistantIndex], assistantIndex),
      };
    const messageIndex = messages.push({ role: 'assistant', content: [] }) - 1;
    nativeBlocks.push([]);
    return { messageIndex, contentIndex: 0, parentMessageId: messageId(messages[messageIndex], messageIndex) };
  };

  const outputIndexForSource = (messageIndex: number, sourceIndex: number, order: number): number => {
    const nativeBefore = (nativeBlocks[messageIndex] ?? []).filter((slot) => slot.sourceIndex < sourceIndex).length;
    const projectedBefore = [...projectedSources.values()]
      .filter((slot) => slot.messageIndex === messageIndex)
      .filter((slot) => slot.sourceIndex < sourceIndex || (slot.sourceIndex === sourceIndex && slot.order < order)).length;
    return nativeBefore + projectedBefore;
  };

  const shiftSlots = (messageIndex: number, fromIndex: number): void => {
    for (const [operationId, slot] of operationSlots) {
      if (slot.messageIndex !== messageIndex || slot.contentIndex < fromIndex) continue;
      slot.contentIndex += 1;
      const record = operations.get(operationId);
      if (record) record.slot = slot;
    }
  };

  const rememberProjectedSource = (operationId: string, messageIndex: number, sourceIndex: number, order = nextProjectedOrder++): void => {
    projectedSources.set(operationId, { messageIndex, sourceIndex, order });
  };

  const refreshOperationSlots = (messageIndex: number): void => {
    const message = messages[messageIndex];
    if (!message) return;
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
      const block = message.content[contentIndex];
      if (!isSubagentContent(block)) continue;
      const slot = operationSlots.get(block.operationId) ?? { messageIndex, contentIndex, parentMessageId: messageId(message, messageIndex) };
      slot.messageIndex = messageIndex;
      slot.contentIndex = contentIndex;
      slot.parentMessageId = messageId(message, messageIndex);
      operationSlots.set(block.operationId, slot);
      const target = operations.get(block.operationId)?.target ?? completedTargets.get(block.operationId);
      if (target) {
        rememberProjectedSource(
          block.operationId,
          messageIndex,
          target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : 0,
          projectedSources.get(block.operationId)?.order,
        );
      }
    }
  };

  const clearCustomProtocolError = (entryId: string): void => {
    const operationId = customProtocolErrors.get(entryId);
    if (!operationId) return;
    const slot = operationSlots.get(operationId);
    if (slot) {
      const message = messages[slot.messageIndex];
      if (message) {
        messages[slot.messageIndex] = { ...message, content: message.content.filter((content) => !(content.type === 'subagent' && content.operationId === operationId)) };
        refreshOperationSlots(slot.messageIndex);
      }
    }
    operationSlots.delete(operationId);
    completedOperations.delete(operationId);
    completedTargets.delete(operationId);
    projectedSources.delete(operationId);
    customProtocolErrors.delete(entryId);
  };

  const placeBlock = (target: SubagentOperationTarget, block: PimoteMessageContent): MutableSlot => {
    if (target.placement && 'entryId' in target.placement && !('toolCallId' in target.placement)) clearCustomProtocolError(target.placement.entryId);
    const located = messageForTarget(target);
    const message = messages[located.messageIndex] ?? { role: 'assistant', content: [] };
    if (!messages[located.messageIndex]) {
      messages[located.messageIndex] = message;
      nativeBlocks[located.messageIndex] = [];
    }
    const content = [...message.content];
    const sourceIndex = target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : located.contentIndex;
    const existingProjected = content.findIndex((candidate) => isSubagentContent(candidate) && candidate.operationId === target.operationId);
    const existingSource = projectedSources.get(target.operationId);
    const order = existingSource?.order ?? nextProjectedOrder++;
    const index = existingProjected >= 0 ? existingProjected : outputIndexForSource(located.messageIndex, sourceIndex, order);
    if (existingProjected < 0) {
      shiftSlots(located.messageIndex, index);
      content.splice(Math.min(index, content.length), 0, block);
    } else content[index] = block;
    messages[located.messageIndex] = { ...message, content };
    rememberProjectedSource(target.operationId, located.messageIndex, sourceIndex, order);
    return { messageIndex: located.messageIndex, contentIndex: index, parentMessageId: located.parentMessageId };
  };

  const replaceOperationBlock = (operationId: string, block: PimoteMessageContent): MutableSlot | undefined => {
    const slot = operationSlots.get(operationId);
    if (!slot) return undefined;
    const message = messages[slot.messageIndex];
    if (!message) return undefined;
    const content = [...message.content];
    if (slot.contentIndex >= content.length) return undefined;
    content[slot.contentIndex] = block;
    messages[slot.messageIndex] = { ...message, content };
    return slot;
  };

  const emitBase = (cursor = 0): { sessionId: string; cursor: number; timestamp: string } => ({ sessionId: options.sessionId, cursor, timestamp: new Date().toISOString() });

  const startEvent = (record: OperationRecord, block: PimoteMessageContent): PimoteSessionEvent => ({
    ...emitBase(),
    type: 'subagent_content_start',
    parentMessageId: record.slot.parentMessageId,
    contentIndex: record.slot.contentIndex,
    operationId: record.target.operationId,
    kind: record.target.kind,
    placement: record.target.placement ?? ({ entryId: record.slot.parentMessageId } as const),
    content: block,
  });

  const createStart = (target: SubagentOperationTarget, data: SubagentStartData, emit: boolean): readonly PimoteSessionEvent[] => {
    const key = operationKey(target);
    if (operations.has(key) && operationSlots.has(key)) return [];
    const clonedTarget = cloneTarget(target);
    const block = mapSubagentBlock(key, clonedTarget.kind, 'active', data, clonedTarget.placement);
    const slot = placeBlock(clonedTarget, block);
    const record: OperationRecord = { target: clonedTarget, data, slot };
    operations.set(key, record);
    operationSlots.set(key, slot);
    return emit ? [startEvent(record, block)] : [];
  };

  const deltaData = (record: OperationRecord, delta: SubagentDeltaData): SubagentStartData => {
    const current = record.data;
    if (delta.operation === 'send' && current.operation === 'send') {
      if ('field' in delta) {
        if (delta.field === 'request') return { ...current, request: current.request + delta.delta };
        return { ...current, response: current.response + delta.delta };
      }
      return { ...current, phase: delta.phase };
    }
    if (delta.operation === 'respond' && current.operation === 'respond') return { ...current, body: current.body + delta.delta };
    if (delta.operation === 'await' && current.operation === 'await') return { ...current, statuses: delta.statuses };
    return current;
  };

  const applyDelta = (event: Extract<SubagentProviderEvent, { type: 'subagent_delta' }>): readonly PimoteSessionEvent[] => {
    const record = operations.get(event.target.operationId);
    if (!record) return [];
    record.data = deltaData(record, event.data);
    const block = mapSubagentBlock(record.target.operationId, record.target.kind, 'active', record.data, record.target.placement);
    const slot = replaceOperationBlock(record.target.operationId, block) ?? record.slot;
    record.slot = slot;
    const delta = {
      ...emitBase(),
      type: 'subagent_content_delta' as const,
      parentMessageId: slot.parentMessageId,
      contentIndex: slot.contentIndex,
      operationId: record.target.operationId,
      kind: record.target.kind,
      data: event.data,
    };
    return [delta];
  };

  const endEvent = (target: SubagentOperationTarget, state: 'complete' | 'error' | 'aborted', data: SubagentEndData | ProtocolErrorData): PimoteSessionEvent => {
    const block = mapSubagentBlock(target.operationId, target.kind, stateFromEnd(state), data, target.placement);
    const replaced = replaceOperationBlock(target.operationId, block);
    const effectiveSlot = replaced ?? placeBlock(target, block);
    operationSlots.set(target.operationId, effectiveSlot);
    return {
      ...emitBase(),
      type: 'subagent_content_end',
      parentMessageId: effectiveSlot.parentMessageId,
      contentIndex: effectiveSlot.contentIndex,
      operationId: target.operationId,
      kind: target.kind,
      state,
      content: block,
    };
  };

  const finish = (event: Extract<SubagentProviderEvent, { type: 'subagent_end' }>): readonly PimoteSessionEvent[] => {
    const record = operations.get(event.target.operationId);
    if (!record) return [];
    operations.delete(event.target.operationId);
    completedOperations.add(event.target.operationId);
    completedTargets.set(event.target.operationId, cloneTarget(record.target));
    return [endEvent(record.target, event.state, event.data)];
  };

  const finite = (event: Extract<SubagentProviderEvent, { type: 'subagent_snapshot_event' }>): readonly PimoteSessionEvent[] => {
    const existing = operationSlots.get(event.target.operationId);
    if (completedOperations.has(event.target.operationId) && existing) return [];
    const state = event.state;
    const target = cloneTarget(event.target);
    const block = mapSubagentBlock(target.operationId, target.kind, stateFromEnd(state), event.data, target.placement);
    const slot = placeBlock(target, block);
    operationSlots.set(target.operationId, slot);
    completedOperations.add(target.operationId);
    completedTargets.set(target.operationId, target);
    const startRecord: OperationRecord = { target, data: event.data as unknown as SubagentStartData, slot };
    return [startEvent(startRecord, block), endEvent(target, state, event.data as unknown as SubagentEndData)];
  };

  const protocolError = (toolCallId: string, message: string): readonly PimoteSessionEvent[] => {
    const sourceSlot = hiddenToolSlots.get(toolCallId);
    const target: SubagentOperationTarget = {
      operationId: toolCallId,
      kind: 'send',
      path: [],
      placement: { toolCallId, contentIndex: sourceSlot?.contentIndex ?? 0, ...(sourceSlot?.parentMessageId ? { entryId: sourceSlot.parentMessageId } : {}) },
    };
    const existing = operationSlots.get(toolCallId);
    const slot = existing ?? placeBlock(target, mapSubagentBlock(toolCallId, 'send', 'protocol_error', dataForProtocolError('send', message), target.placement));
    const data = dataForProtocolError('send', message);
    const content = mapSubagentBlock(toolCallId, 'send', 'protocol_error', data, target.placement);
    if (!replaceOperationBlock(toolCallId, content)) placeBlock(target, content);
    completedOperations.add(toolCallId);
    completedTargets.set(toolCallId, target);
    operationSlots.set(toolCallId, slot);
    return [
      {
        ...emitBase(),
        type: 'subagent_content_end',
        parentMessageId: slot.parentMessageId,
        contentIndex: slot.contentIndex,
        operationId: toolCallId,
        kind: 'send',
        state: 'protocol_error',
        content,
      },
    ];
  };

  const protocolErrorForEntry = (entryId: string, message: string): readonly PimoteSessionEvent[] => {
    const operationId = `protocol-error:${entryId}`;
    const target: SubagentOperationTarget = { operationId, kind: 'completion', path: [], placement: { entryId } };
    const data: ProtocolErrorData = { operation: 'protocol_error', message };
    const content = mapSubagentBlock(operationId, 'completion', 'protocol_error', data, target.placement);
    const slot = placeBlock(target, content);
    operationSlots.set(operationId, slot);
    completedOperations.add(operationId);
    completedTargets.set(operationId, target);
    customProtocolErrors.set(entryId, operationId);
    return [
      {
        ...emitBase(),
        type: 'subagent_content_end',
        parentMessageId: slot.parentMessageId,
        contentIndex: slot.contentIndex,
        operationId,
        kind: 'completion',
        state: 'protocol_error',
        content,
      },
    ];
  };

  const rehydrate = (nextMessages: readonly PimoteAgentMessage[]): void => {
    const active = [...operations.values()].map((record) => ({ target: cloneTarget(record.target), data: record.data }));
    const preserved = messages.flatMap((message) =>
      message.content.flatMap((block) => {
        if (!isSubagentContent(block)) return [];
        const target = operations.get(block.operationId)?.target ?? completedTargets.get(block.operationId);
        if (!target) return [];
        return [{ target: cloneTarget(target), block: cloneContent(block) }];
      }),
    );
    operations.clear();
    operationSlots.clear();
    projectedSources.clear();
    messages = [];
    nativeBlocks = [];
    hiddenToolCalls.clear();
    hiddenToolSlots.clear();
    hiddenCustomEntries.clear();
    customProtocolErrors.clear();
    streamingAssistantSlot = undefined;
    hiddenStreamingIndexes.clear();
    for (const source of nextMessages) {
      if (source.role === 'custom' && source.customType && hiddenCustomTypes.has(source.customType)) {
        const { details: _details, ...withoutDetails } = cloneMessage(source);
        void _details;
        const hidden = { ...withoutDetails, content: [] };
        if (hidden.entryId) hiddenCustomEntries.add(hidden.entryId);
        messages.push(hidden);
        nativeBlocks.push([]);
        if (hidden.entryId) {
          const payload = isObject(_details) ? _details.subagentContent : undefined;
          if (!Array.isArray(payload) || payload.length === 0 || payload.some((item) => !isPersistedSubagentContent(item))) {
            protocolErrorForEntry(hidden.entryId, `Hidden custom entry ${source.customType} contains malformed subagent content.`);
          }
        }
        continue;
      }
      const mapped = cloneMessage(source);
      const index = messages.length;
      const visible = visibleContentFor(mapped, index);
      if (mapped.role === 'toolResult' && visible.content.length === 0) continue;
      const filtered =
        visible.content.length === mapped.content.length
          ? { ...mapped, content: visible.content }
          : (() => {
              const { details: _details, ...withoutDetails } = mapped;
              void _details;
              return { ...withoutDetails, content: visible.content };
            })();
      messages.push(filtered);
      nativeBlocks.push(visible.slots);
      for (let contentIndex = 0; contentIndex < filtered.content.length; contentIndex += 1) {
        const block = filtered.content[contentIndex];
        if (!isSubagentContent(block)) continue;
        const target: SubagentOperationTarget = {
          operationId: block.operationId,
          kind: block.subagentKind,
          path: [],
          placement: block.placement,
        };
        completedTargets.set(block.operationId, completedTargets.get(block.operationId) ?? target);
        operationSlots.set(block.operationId, { messageIndex: index, contentIndex, parentMessageId: messageId(filtered, index) });
        rememberProjectedSource(block.operationId, index, target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : 0);
        if (block.subagentState !== 'active') completedOperations.add(block.operationId);
        if (block.subagentState === 'active' && block.data && isObject(block.data)) {
          operations.set(block.operationId, {
            target,
            data: block.data as SubagentStartData,
            slot: operationSlots.get(block.operationId)!,
          });
        }
      }
    }
    // Reapply completed projected blocks that were already in this projector.
    // This keeps a full branch refresh from erasing cards when provider history
    // is live-only and hydration is idempotent.
    for (const item of preserved) {
      if (messages.some((message) => message.content.some((block) => isSubagentContent(block) && block.operationId === item.block.operationId))) continue;
      const placement = item.target.placement;
      const placementPresent =
        placement && 'toolCallId' in placement
          ? hiddenToolSlots.has(placement.toolCallId) || messages.some((message) => message.content.some((block) => block.toolCallId === placement.toolCallId))
          : placement && 'entryId' in placement
            ? findMessageByEntry(placement.entryId) >= 0
            : false;
      if (item.block.subagentState !== 'active' && !placementPresent) continue;
      const block = item.block as Extract<PimoteMessageContent, { type: 'subagent' }>;
      const slot = placeBlock(item.target, block);
      operationSlots.set(block.operationId, slot);
      completedTargets.set(block.operationId, item.target);
    }
    // Provider hydration is authoritative for active state, but existing active
    // blocks from a reconnect must survive a native branch refresh.
    for (const record of active) {
      if (!operations.has(record.target.operationId)) createStart(record.target, record.data, false);
    }
  };

  const acceptNativeEvent = (event: IncomingSdkEvent): readonly PimoteSessionEvent[] => {
    const toolName = nativeToolName(event);
    const toolCallId = nativeToolCallId(event);
    if (event.type === 'message_start') {
      hiddenStreamingIndexes.clear();
      streamingAssistantSlot = event.message.role === 'assistant' ? { messageIndex: messages.length, contentIndex: 0, parentMessageId: `message-${messages.length}` } : undefined;
      return [];
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type.startsWith('toolcall_') && 'contentIndex' in event.assistantMessageEvent) {
      const index = event.assistantMessageEvent.contentIndex;
      if (toolName !== undefined && hiddenTools.has(toolName)) hiddenStreamingIndexes.add(index);
      if (toolCallId && hiddenTools.has(toolName ?? '')) {
        const slot = streamingAssistantSlot;
        if (slot) hiddenToolSlots.set(toolCallId, { ...slot, contentIndex: index });
      }
    }
    if (event.type === 'entry_appended') {
      if (event.entry.type === 'custom' && hiddenCustomTypes.has(event.entry.customType)) {
        const entryId = typeof event.entry.id === 'string' ? event.entry.id : undefined;
        if (entryId !== undefined) {
          hiddenCustomEntries.add(entryId);
          const existing = findMessageByEntry(entryId);
          const projected = existing >= 0 ? messages[existing].content.filter(isSubagentContent) : [];
          if (existing >= 0) {
            messages[existing] = { ...messages[existing], content: projected };
            nativeBlocks[existing] = [];
            refreshOperationSlots(existing);
          } else {
            messages.push({ role: 'custom', entryId, content: [] });
            nativeBlocks.push([]);
          }
          const details = (event.entry as unknown as { details?: unknown; data?: unknown }).details ?? (event.entry as unknown as { data?: unknown }).data;
          const payload = isObject(details) ? details.subagentContent : undefined;
          const hasValidPersistedContent = Array.isArray(payload) && payload.length > 0 && payload.every((item) => isPersistedSubagentContent(item));
          return hasValidPersistedContent ? [] : protocolErrorForEntry(entryId, `Hidden custom entry ${event.entry.customType} contains malformed subagent content.`);
        }
        return [];
      }
      if (event.entry.type === 'custom') {
        const mapped = mapCustomEntry(event.entry);
        messages = [...messages, mapped];
        nativeBlocks = [...nativeBlocks, mapped.content.map((content, sourceIndex) => ({ sourceIndex, content }))];
      }
      return [];
    }
    if (toolName && hiddenTools.has(toolName)) {
      if (toolCallId) {
        hiddenToolCalls.add(toolCallId);
        if (!hiddenToolSlots.has(toolCallId) && streamingAssistantSlot)
          hiddenToolSlots.set(toolCallId, { ...streamingAssistantSlot, contentIndex: streamingAssistantSlot.contentIndex });
      }
      if (isToolLifecycleEnd(event) && toolCallId && !completedOperations.has(toolCallId)) {
        const operation = operations.get(toolCallId);
        if (operation) operations.delete(toolCallId);
        return protocolError(toolCallId, `Hidden tool ${toolName} ended without a complete subagent lifecycle.`);
      }
      return [];
    }
    if (toolCallId && hiddenToolCalls.has(toolCallId)) {
      if (isToolLifecycleEnd(event) && !completedOperations.has(toolCallId)) return protocolError(toolCallId, 'A declared subagent tool ended without a complete lifecycle.');
      return [];
    }
    if (event.type === 'message_end') {
      if (event.message.role === 'custom' && typeof event.message.customType === 'string' && hiddenCustomTypes.has(event.message.customType)) {
        if (typeof (event.message as unknown as { entryId?: unknown }).entryId === 'string') hiddenCustomEntries.add((event.message as unknown as { entryId: string }).entryId);
        return [];
      }
      const mapped = cloneMessage(mapAgentMessage(event.message));
      const existing = mapped.entryId
        ? messages.findIndex((message) => message.entryId === mapped.entryId)
        : streamingAssistantSlot && messages[streamingAssistantSlot.messageIndex]?.role === 'assistant'
          ? streamingAssistantSlot.messageIndex
          : -1;
      const visible = visibleContentFor(mapped, existing >= 0 ? existing : messages.length);
      if (existing >= 0) {
        const projected = messages[existing].content.filter(isSubagentContent);
        const merged = visible.content;
        const base =
          visible.content.length === mapped.content.length
            ? { ...mapped, content: merged }
            : (() => {
                const { details: _details, ...withoutDetails } = mapped;
                void _details;
                return { ...withoutDetails, content: merged };
              })();
        messages[existing] = { ...base, content: projected.length > 0 ? mergeNativeContent(merged, projected, mapped, hiddenTools, hiddenToolCalls) : merged };
        nativeBlocks[existing] = visible.slots;
        refreshOperationSlots(existing);
      } else if (!(mapped.role === 'toolResult' && visible.content.length === 0)) {
        const base =
          visible.content.length === mapped.content.length
            ? { ...mapped, content: visible.content }
            : (() => {
                const { details: _details, ...withoutDetails } = mapped;
                void _details;
                return { ...withoutDetails, content: visible.content };
              })();
        messages = [...messages, base];
        nativeBlocks = [...nativeBlocks, visible.slots];
      }
      const hidden = visible.content.length !== mapped.content.length || (mapped.role === 'custom' && mapped.customType !== undefined && hiddenCustomTypes.has(mapped.customType));
      streamingAssistantSlot = undefined;
      hiddenStreamingIndexes.clear();
      if (hidden) {
        const projected = existing >= 0 ? messages[existing] : mapped.role === 'toolResult' && visible.content.length === 0 ? undefined : messages[messages.length - 1];
        if (!projected?.content.some(isSubagentContent)) return [];
        return [{ type: 'message_end', message: projected } as PimoteSessionEvent];
      }
    }
    return [];
  };

  const isNativeEventSuppressed = (event: IncomingSdkEvent): boolean => {
    if (event.type === 'entry_appended') return event.entry.type === 'custom' && hiddenCustomTypes.has(event.entry.customType);
    if (event.type === 'message_end') {
      if (event.message.role === 'custom' && typeof event.message.customType === 'string' && hiddenCustomTypes.has(event.message.customType)) return true;
      if (!('content' in event.message) || !Array.isArray(event.message.content)) return false;
      return mapAgentMessage(event.message).content.some(
        (block) =>
          (block.type === 'tool_call' && block.toolName !== undefined && hiddenTools.has(block.toolName)) ||
          (block.type === 'tool_result' &&
            ((block.toolName !== undefined && hiddenTools.has(block.toolName)) || (block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId)))),
      );
    }
    if (event.type === 'message_update' && 'contentIndex' in event.assistantMessageEvent && hiddenStreamingIndexes.has(event.assistantMessageEvent.contentIndex)) return true;
    const toolName = nativeToolName(event);
    const toolCallId = nativeToolCallId(event);
    return (toolName !== undefined && hiddenTools.has(toolName)) || (toolCallId !== undefined && hiddenToolCalls.has(toolCallId));
  };

  const projectNativeEvent = (event: IncomingSdkEvent): IncomingSdkEvent | undefined => {
    if (event.type !== 'message_update' || !('contentIndex' in event.assistantMessageEvent)) return event;
    if (isNativeEventSuppressed(event)) return undefined;
    const update = event.assistantMessageEvent;
    const content = 'partial' in update && Array.isArray(update.partial.content) ? update.partial.content : undefined;
    let denseIndex = 0;
    if (content) {
      for (let index = 0; index < update.contentIndex; index += 1) {
        const block = content[index];
        const hidden = block?.type === 'toolCall' && (hiddenTools.has(block.name) || hiddenToolCalls.has(block.id));
        if (!hidden) denseIndex += 1;
      }
    } else {
      denseIndex = update.contentIndex - [...hiddenStreamingIndexes].filter((index) => index < update.contentIndex).length;
    }
    const projectedPartial =
      content && 'partial' in update
        ? {
            ...update.partial,
            content: content.filter((block) => block?.type !== 'toolCall' || (!hiddenTools.has(block.name) && !hiddenToolCalls.has(block.id))),
          }
        : undefined;
    return {
      ...event,
      assistantMessageEvent: {
        ...update,
        contentIndex: Math.max(0, denseIndex),
        ...(projectedPartial ? { partial: projectedPartial } : {}),
      },
    } as IncomingSdkEvent;
  };

  const projectStreamingMessage = (message: StreamingMessage): StreamingMessage => {
    seedStreamingHiddenState(message);
    const content = message.content
      .filter((block) => {
        if (block.type === 'tool_call')
          return !(block.toolName !== undefined && hiddenTools.has(block.toolName)) && !(block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId));
        if (block.type === 'tool_result')
          return !(block.toolName !== undefined && hiddenTools.has(block.toolName)) && !(block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId));
        return true;
      })
      .map(cloneContent);
    if (content.length === message.content.length) return { ...message, content };
    const { details: _details, ...withoutDetails } = message;
    void _details;
    return { ...withoutDetails, content };
  };

  const hydrateActiveOperations = (active: readonly ActiveSubagentOperation[]): void => {
    for (const operation of active) {
      operations.delete(operation.target.operationId);
      completedOperations.delete(operation.target.operationId);
      createStart(operation.target, operation.data, false);
    }
  };

  const restoreProjection = (projection: SubagentProjectionSnapshot): void => {
    const activeByOperation = new Map(projection.activeOperations.map((operation) => [operation.target.operationId, operation]));
    for (const [messageIndex, source] of projection.messages.entries()) {
      for (const block of source.content) {
        if (!isSubagentContent(block)) continue;
        const active = activeByOperation.get(block.operationId);
        const target: SubagentOperationTarget = cloneTarget(
          active?.target ?? {
            operationId: block.operationId,
            kind: block.subagentKind,
            path: [],
            ...(block.placement ? { placement: block.placement } : {}),
          },
        );
        const existingMessageIndex = source.entryId ? findMessageByEntry(source.entryId) : messages[messageIndex]?.role === source.role ? messageIndex : -1;
        let slot: MutableSlot;
        if (existingMessageIndex >= 0) {
          const existing = messages[existingMessageIndex];
          const existingBlock = existing.content.findIndex((candidate) => isSubagentContent(candidate) && candidate.operationId === block.operationId);
          if (existingBlock >= 0) {
            messages[existingMessageIndex] = {
              ...existing,
              content: existing.content.map((candidate, index) => (index === existingBlock ? cloneContent(block) : candidate)),
            };
            slot = { messageIndex: existingMessageIndex, contentIndex: existingBlock, parentMessageId: messageId(existing, existingMessageIndex) };
          } else {
            const content = [...existing.content];
            const sourceIndex = target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : content.length;
            const index = outputIndexForSource(existingMessageIndex, sourceIndex, projectedSources.get(block.operationId)?.order ?? nextProjectedOrder++);
            shiftSlots(existingMessageIndex, index);
            content.splice(Math.min(index, content.length), 0, cloneContent(block));
            messages[existingMessageIndex] = { ...existing, content };
            slot = { messageIndex: existingMessageIndex, contentIndex: index, parentMessageId: messageId(existing, existingMessageIndex) };
          }
          rememberProjectedSource(
            block.operationId,
            existingMessageIndex,
            target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : 0,
            projectedSources.get(block.operationId)?.order,
          );
        } else {
          const synthetic = cloneMessage(source);
          synthetic.content = [];
          messages.push(synthetic);
          nativeBlocks.push([]);
          const placement = target.placement && 'toolCallId' in target.placement ? target.placement : source.entryId ? { entryId: source.entryId } : target.placement;
          const syntheticTarget = placement === target.placement ? target : { ...target, placement };
          slot = placeBlock(syntheticTarget, cloneContent(block));
        }
        operationSlots.set(block.operationId, slot);
        completedTargets.set(block.operationId, target);
        if (active) {
          completedOperations.delete(block.operationId);
          operations.set(block.operationId, { target, data: active.data, slot });
        } else {
          operations.delete(block.operationId);
          completedOperations.add(block.operationId);
        }
      }
    }
  };

  return {
    acceptNativeEvent,
    acceptProviderEvent(event) {
      const wireEvent = event as unknown as Record<string, unknown>;
      if (typeof wireEvent.type !== 'string') return [];
      const eventId = typeof wireEvent.eventId === 'string' ? wireEvent.eventId : undefined;
      const cursor = isObject(wireEvent.cursor) ? `${String(wireEvent.cursor.epoch)}:${String(wireEvent.cursor.sequence)}` : '';
      if (eventId) {
        const identity = `${eventId}:${cursor}`;
        if (seenProviderEvents.has(identity)) return [];
        seenProviderEvents.add(identity);
      }
      switch (wireEvent.type) {
        case 'subagent_start': {
          const start = event as Extract<SubagentProviderEvent, { type: 'subagent_start' }>;
          return createStart(start.target, start.data, true);
        }
        case 'subagent_delta':
          return applyDelta(event as Extract<SubagentProviderEvent, { type: 'subagent_delta' }>);
        case 'subagent_end':
          return finish(event as Extract<SubagentProviderEvent, { type: 'subagent_end' }>);
        case 'subagent_snapshot_event':
          return finite(event as Extract<SubagentProviderEvent, { type: 'subagent_snapshot_event' }>);
        default:
          // Topology events are consumed by SubagentHost. They carry no
          // transcript content and must never reach the client row.
          return [];
      }
    },
    projectStreamingMessage,
    restoreProjection,
    snapshot() {
      return {
        messages: messages
          .filter((message) => !(message.role === 'custom' && message.entryId && hiddenCustomEntries.has(message.entryId) && !message.content.some(isSubagentContent)))
          .map(cloneMessage),
        activeOperations: [...operations.values()].map((record) => ({ target: cloneTarget(record.target), data: record.data })),
      };
    },
    rehydrate,
    hydrateActiveOperations,
    projectNativeEvent,
    isNativeEventSuppressed,
  };
}

function mergeNativeContent(
  native: readonly PimoteMessageContent[],
  projected: readonly PimoteMessageContent[],
  sourceMessage: PimoteAgentMessage,
  hiddenTools: ReadonlySet<string>,
  hiddenToolCalls: ReadonlySet<string>,
): PimoteMessageContent[] {
  const result = [...native];
  const inserted: Array<{ block: Extract<PimoteMessageContent, { type: 'subagent' }>; sourceIndex: number; order: number }> = [];
  for (const [order, candidate] of projected.entries()) {
    if (!isSubagentContent(candidate)) continue;
    const existing = result.findIndex((block) => isSubagentContent(block) && block.operationId === candidate.operationId);
    if (existing >= 0) {
      result[existing] = candidate;
      continue;
    }
    const placement = candidate.placement;
    const sourceIndex = placement && 'toolCallId' in placement ? sourceMessage.content.findIndex((block) => block.toolCallId === placement.toolCallId) : Number.MAX_SAFE_INTEGER;
    if (sourceIndex < 0) {
      result.push(candidate);
      continue;
    }
    let nativeBefore = 0;
    for (let index = 0; index < sourceIndex; index += 1) {
      const block = sourceMessage.content[index];
      if (block.type === 'subagent') continue;
      const hidden =
        (block.type === 'tool_call' && block.toolName !== undefined && hiddenTools.has(block.toolName)) ||
        (block.type === 'tool_result' && block.toolCallId !== undefined && hiddenToolCalls.has(block.toolCallId));
      if (!hidden) nativeBefore += 1;
    }
    const projectedBefore = inserted.filter((item) => item.sourceIndex < sourceIndex || (item.sourceIndex === sourceIndex && item.order < order)).length;
    result.splice(Math.min(nativeBefore + projectedBefore, result.length), 0, candidate);
    inserted.push({ block: candidate, sourceIndex, order });
  }
  return result;
}
