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
  /** True when the native event is a declared replacement. */
  isNativeEventSuppressed?(event: IncomingSdkEvent): boolean;
}

type Slot = Readonly<{ messageIndex: number; contentIndex: number; parentMessageId: string }>;
type MutableSlot = { messageIndex: number; contentIndex: number; parentMessageId: string };
type NativeBlock = { sourceIndex: number; content: PimoteMessageContent };
type OperationRecord = { target: SubagentOperationTarget; data: SubagentStartData; slot: MutableSlot };
type ProtocolErrorData = Readonly<{ operation: 'protocol_error'; message: string }>;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
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
  const seenProviderEvents = new Set<string>();
  const operationSlots = new Map<string, MutableSlot>();

  const messageId = (message: PimoteAgentMessage, index: number): string => message.entryId ?? `message-${index}`;

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
          hiddenToolSlots.set(block.toolCallId, { messageIndex, contentIndex: sourceIndex, parentMessageId: messageId(message, messageIndex) });
        }
        return;
      }
      if (block.type === 'subagent') {
        content.push(cloneContent(block));
        slots.push({ sourceIndex, content: content[content.length - 1] });
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
    }
    if (placement && 'toolCallId' in placement) {
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

  const outputIndexForSource = (messageIndex: number, sourceIndex: number): number => {
    const slots = nativeBlocks[messageIndex] ?? [];
    const before = slots.findIndex((slot) => slot.sourceIndex >= sourceIndex);
    return before >= 0 ? before : (messages[messageIndex]?.content.length ?? 0);
  };

  const placeBlock = (target: SubagentOperationTarget, block: PimoteMessageContent): MutableSlot => {
    const located = messageForTarget(target);
    const message = messages[located.messageIndex] ?? { role: 'assistant', content: [] };
    if (!messages[located.messageIndex]) {
      messages[located.messageIndex] = message;
      nativeBlocks[located.messageIndex] = [];
    }
    const content = [...message.content];
    const sourceIndex = target.placement && 'toolCallId' in target.placement ? target.placement.contentIndex : located.contentIndex;
    const existingProjected = content.findIndex((candidate) => isSubagentContent(candidate) && candidate.operationId === target.operationId);
    const index = existingProjected >= 0 ? existingProjected : outputIndexForSource(located.messageIndex, sourceIndex);
    if (existingProjected < 0) content.splice(Math.min(index, content.length), 0, block);
    else content[index] = block;
    messages[located.messageIndex] = { ...message, content };
    const slots = nativeBlocks[located.messageIndex] ?? [];
    if (existingProjected < 0) nativeBlocks[located.messageIndex] = slots;
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
    const block = mapSubagentBlock(key, target.kind, 'active', data, target.placement);
    const slot = placeBlock(target, block);
    const record: OperationRecord = { target: cloneTarget(target), data, slot };
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

  const endEvent = (target: SubagentOperationTarget, state: 'complete' | 'error' | 'aborted', data: SubagentEndData | ProtocolErrorData, slot: MutableSlot): PimoteSessionEvent => {
    const block = mapSubagentBlock(target.operationId, target.kind, stateFromEnd(state), data, target.placement);
    if (!replaceOperationBlock(target.operationId, block)) placeBlock(target, block);
    return {
      ...emitBase(),
      type: 'subagent_content_end',
      parentMessageId: slot.parentMessageId,
      contentIndex: slot.contentIndex,
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
    return [endEvent(record.target, event.state, event.data, record.slot)];
  };

  const finite = (event: Extract<SubagentProviderEvent, { type: 'subagent_snapshot_event' }>): readonly PimoteSessionEvent[] => {
    const state = event.state;
    const target = cloneTarget(event.target);
    const block = mapSubagentBlock(target.operationId, target.kind, stateFromEnd(state), event.data, target.placement);
    const slot = placeBlock(target, block);
    operationSlots.set(target.operationId, slot);
    completedOperations.add(target.operationId);
    const startRecord: OperationRecord = { target, data: event.data as unknown as SubagentStartData, slot };
    return [startEvent(startRecord, block), endEvent(target, state, event.data as unknown as SubagentEndData, slot)];
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

  const rehydrate = (nextMessages: readonly PimoteAgentMessage[]): void => {
    const active = [...operations.values()].map((record) => ({ target: record.target, data: record.data }));
    messages = [];
    nativeBlocks = [];
    hiddenToolCalls.clear();
    hiddenToolSlots.clear();
    hiddenCustomEntries.clear();
    for (const source of nextMessages) {
      if (source.role === 'custom' && source.customType && hiddenCustomTypes.has(source.customType)) {
        const { details: _details, ...withoutDetails } = cloneMessage(source);
        void _details;
        const hidden = { ...withoutDetails, content: [] };
        if (hidden.entryId) hiddenCustomEntries.add(hidden.entryId);
        messages.push(hidden);
        nativeBlocks.push([]);
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
      for (const block of visible.content) {
        if (!isSubagentContent(block)) continue;
        if (block.subagentState === 'active' && block.data && isObject(block.data)) {
          const target: SubagentOperationTarget = {
            operationId: block.operationId,
            kind: block.subagentKind,
            path: [],
            placement: block.placement,
          };
          operations.set(block.operationId, {
            target,
            data: block.data as SubagentStartData,
            slot: { messageIndex: index, contentIndex: filtered.content.indexOf(block), parentMessageId: messageId(filtered, index) },
          });
          operationSlots.set(block.operationId, { messageIndex: index, contentIndex: filtered.content.indexOf(block), parentMessageId: messageId(filtered, index) });
        }
      }
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
    if (event.type === 'entry_appended') {
      if (event.entry.type === 'custom' && hiddenCustomTypes.has(event.entry.customType)) {
        if (typeof event.entry.id === 'string') hiddenCustomEntries.add(event.entry.id);
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
      if (toolCallId) hiddenToolCalls.add(toolCallId);
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
      const mapped = cloneMessage(mapAgentMessage(event.message));
      const existing = mapped.entryId ? messages.findIndex((message) => message.entryId === mapped.entryId) : -1;
      if (existing >= 0) {
        const projected = messages[existing].content.filter(isSubagentContent);
        const visible = visibleContentFor(mapped, existing);
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
        nativeBlocks[existing] = messages[existing].content.map((content, sourceIndex) => ({ sourceIndex, content }));
      } else {
        const visible = visibleContentFor(mapped, messages.length);
        if (mapped.role === 'toolResult' && visible.content.length === 0) return [];
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
    }
    return [];
  };

  const isNativeEventSuppressed = (event: IncomingSdkEvent): boolean => {
    if (event.type === 'entry_appended') return event.entry.type === 'custom' && hiddenCustomTypes.has(event.entry.customType);
    const toolName = nativeToolName(event);
    const toolCallId = nativeToolCallId(event);
    return (toolName !== undefined && hiddenTools.has(toolName)) || (toolCallId !== undefined && hiddenToolCalls.has(toolCallId));
  };

  const projectStreamingMessage = (message: StreamingMessage): StreamingMessage => {
    const content = message.content
      .filter((block) => {
        if (block.type === 'tool_call') return !(block.toolName !== undefined && hiddenTools.has(block.toolName));
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
      createStart(operation.target, operation.data, false);
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
  for (const block of projected) {
    if (!isSubagentContent(block)) continue;
    const existing = result.findIndex((candidate) => isSubagentContent(candidate) && candidate.operationId === block.operationId);
    if (existing >= 0) {
      result[existing] = block;
      continue;
    }
    const placement = block.placement;
    if (placement && 'toolCallId' in placement) {
      const sourceIndex = sourceMessage.content.findIndex((candidate) => candidate.toolCallId === placement.toolCallId);
      if (sourceIndex >= 0) {
        let outputIndex = 0;
        for (let index = 0; index < sourceIndex; index += 1) {
          const candidate = sourceMessage.content[index];
          if (candidate.type === 'subagent') continue;
          const hidden =
            (candidate.type === 'tool_call' && candidate.toolName !== undefined && hiddenTools.has(candidate.toolName)) ||
            (candidate.type === 'tool_result' && candidate.toolCallId !== undefined && hiddenToolCalls.has(candidate.toolCallId));
          if (!hidden) outputIndex += 1;
        }
        result.splice(Math.min(outputIndex, result.length), 0, block);
        continue;
      }
    }
    result.push(block);
  }
  return result;
}
