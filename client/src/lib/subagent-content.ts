import type {
  PimoteActiveSubagentContent,
  PimoteAgentMessage,
  PimoteMessageContent,
  PimoteSubagentDeltaData,
  PimoteSubagentStartData,
  SubagentContentDeltaEvent,
  SubagentContentEndEvent,
  SubagentContentStartEvent,
  StreamingMessage,
} from '../../../shared/src/protocol.js';

export type SubagentContentEvent = SubagentContentStartEvent | SubagentContentDeltaEvent | SubagentContentEndEvent;
export type ActiveSubagentContent = Readonly<PimoteActiveSubagentContent>;

export interface SubagentContentState {
  readonly messages: readonly PimoteAgentMessage[];
  readonly active: readonly ActiveSubagentContent[];
}

const cloneContent = (content: PimoteMessageContent): PimoteMessageContent => ({ ...content });
const cloneMessage = (message: PimoteAgentMessage): PimoteAgentMessage => ({ ...message, content: message.content.map(cloneContent) });
const cloneMessages = (messages: readonly PimoteAgentMessage[]): PimoteAgentMessage[] => messages.map(cloneMessage);

function operationBlock(message: PimoteAgentMessage, operationId: string): number {
  return message.content.findIndex((content) => content.type === 'subagent' && content.operationId === operationId);
}

function parentIndex(messages: readonly PimoteAgentMessage[], parentMessageId: string): number {
  const byEntry = messages.findIndex((message) => message.entryId === parentMessageId);
  if (byEntry >= 0) return byEntry;
  const match = /^message-(\d+)$/.exec(parentMessageId);
  if (match) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 0 && index < messages.length) return index;
  }
  return -1;
}

function operationMessageIndex(messages: readonly PimoteAgentMessage[], operationId: string): number {
  return messages.findIndex((message) => operationBlock(message, operationId) >= 0);
}

function applyDelta(data: PimoteSubagentStartData, delta: PimoteSubagentDeltaData): PimoteSubagentStartData {
  if (data.operation === 'delegation' && delta.operation === 'delegation') return { ...data, result: { children: delta.children } };
  if (data.operation === 'send' && delta.operation === 'send') {
    if ('field' in delta) {
      if (delta.field === 'request') {
        const message = typeof data.parameters.message === 'string' ? data.parameters.message : '';
        return { ...data, parameters: { ...data.parameters, message: message + delta.delta } };
      }
      return { ...data, result: { ...data.result, response: data.result.response + delta.delta } };
    }
    return { ...data, result: { ...data.result, phase: delta.phase } };
  }
  if (data.operation === 'respond' && delta.operation === 'respond') {
    const message = typeof data.parameters.message === 'string' ? data.parameters.message : '';
    return { ...data, parameters: { ...data.parameters, message: message + delta.delta } };
  }
  if (data.operation === 'await' && delta.operation === 'await') return { ...data, result: { ...data.result, statuses: delta.statuses } };
  return data;
}

function activeFromBlock(message: PimoteAgentMessage, parentMessageId: string, contentIndex: number): ActiveSubagentContent | undefined {
  const block = message.content[contentIndex];
  if (block?.type !== 'subagent' || block.subagentState !== 'active') return undefined;
  return {
    parentMessageId,
    contentIndex,
    operationId: block.operationId,
    kind: block.subagentKind,
    placement: block.placement ?? { entryId: parentMessageId },
    data: block.data as PimoteSubagentStartData,
  };
}

function replaceActive(active: readonly ActiveSubagentContent[], next: ActiveSubagentContent): ActiveSubagentContent[] {
  return [...active.filter((item) => item.operationId !== next.operationId), next];
}

/** Apply one projected lifecycle event to the in-flight assistant row. */
export function applySubagentContentToStreaming(streaming: StreamingMessage, event: SubagentContentEvent): StreamingMessage {
  const content = streaming.content.map(cloneContent);
  const existing = content.findIndex((candidate) => candidate.type === 'subagent' && candidate.operationId === event.operationId);
  if (event.type === 'subagent_content_start') {
    const block = cloneContent(event.content);
    if (existing >= 0) content[existing] = block;
    else content.splice(Math.min(event.contentIndex, content.length), 0, block);
    return { ...streaming, content };
  }
  const blockIndex = existing >= 0 ? existing : Math.min(event.contentIndex, content.length - 1);
  if (event.type === 'subagent_content_delta') {
    const block = content[blockIndex];
    if (block?.type !== 'subagent') return streaming;
    content[blockIndex] = { ...block, data: applyDelta(block.data as PimoteSubagentStartData, event.data), subagentState: 'active' };
    return { ...streaming, content };
  }
  const nextBlock = cloneContent(event.content);
  if (blockIndex >= 0 && blockIndex < content.length) content[blockIndex] = nextBlock;
  else content.splice(Math.min(event.contentIndex, content.length), 0, nextBlock);
  return { ...streaming, content };
}

/** Apply one projected content lifecycle event without native reconciliation.
 *
 * Copies only the message that carries the operation: untouched rows keep
 * their object identity, so callers can replace a single slot instead of
 * re-cloning the transcript on every streamed delta. */
export function applySubagentContentEvent(state: SubagentContentState, event: SubagentContentEvent): SubagentContentState {
  const source = state.messages;
  let messageIndex = operationMessageIndex(source, event.operationId);
  let appendedParent = false;
  if (messageIndex < 0) {
    const byParent = parentIndex(source, event.parentMessageId);
    if (byParent >= 0) {
      messageIndex = byParent;
    } else {
      appendedParent = true;
      messageIndex = source.length;
    }
  }
  const existingMessage = appendedParent ? undefined : source[messageIndex];
  const message: PimoteAgentMessage = existingMessage ?? {
    role: 'assistant',
    ...(event.parentMessageId.startsWith('message-') ? {} : { entryId: event.parentMessageId }),
    content: [],
  };
  const parentMessageId = message.entryId ?? `message-${messageIndex}`;
  const content = [...message.content];
  const existing = operationBlock(message, event.operationId);
  // The replacement array is built only when a change lands, so untouched
  // rows keep their identity and no-op events return the caller's state.
  let working: PimoteAgentMessage[] | null = null;
  const materialize = (): PimoteAgentMessage[] => {
    working ??= appendedParent ? [...source, message] : [...source];
    return working;
  };

  if (event.type === 'subagent_content_start') {
    const block = cloneContent(event.content);
    if (existing >= 0) content[existing] = block;
    else content.splice(Math.min(event.contentIndex, content.length), 0, block);
    const messages = materialize();
    messages[messageIndex] = { ...message, content };
    const next = activeFromBlock(messages[messageIndex], parentMessageId, existing >= 0 ? existing : Math.min(event.contentIndex, content.length - 1));
    return { messages, active: next ? replaceActive(state.active, next) : state.active };
  }

  const blockIndex = existing >= 0 ? existing : Math.min(event.contentIndex, content.length - 1);
  const block = content[blockIndex];
  if (event.type === 'subagent_content_delta') {
    if (!block || block.type !== 'subagent') return state;
    const nextData = applyDelta(block.data as PimoteSubagentStartData, event.data);
    const nextBlock = { ...block, data: nextData, subagentState: 'active' as const };
    content[blockIndex] = nextBlock;
    const messages = materialize();
    messages[messageIndex] = { ...message, content };
    const nextActive: ActiveSubagentContent = {
      parentMessageId,
      contentIndex: blockIndex,
      operationId: event.operationId,
      kind: event.kind,
      placement: nextBlock.placement ?? { entryId: event.parentMessageId },
      data: nextData,
    };
    return { messages: materialize(), active: replaceActive(state.active, nextActive) };
  }

  const nextBlock = cloneContent(event.content);
  if (blockIndex >= 0 && blockIndex < content.length) content[blockIndex] = nextBlock;
  else content.splice(Math.min(event.contentIndex, content.length), 0, nextBlock);
  const messages = materialize();
  messages[messageIndex] = { ...message, content };
  return { messages, active: state.active.filter((item) => item.operationId !== event.operationId) };
}

/** Load complete projected blocks and active operation snapshots together. */
export function hydrateSubagentContent(messages: readonly PimoteAgentMessage[], active: readonly ActiveSubagentContent[] = []): SubagentContentState {
  const hydratedMessages = cloneMessages(messages);
  const discovered: ActiveSubagentContent[] = [];
  hydratedMessages.forEach((message, messageIndex) => {
    message.content.forEach((content, contentIndex) => {
      if (content.type !== 'subagent' || content.subagentState !== 'active') return;
      discovered.push({
        parentMessageId: message.entryId ?? `message-${messageIndex}`,
        contentIndex,
        operationId: content.operationId,
        kind: content.subagentKind,
        placement: content.placement ?? { entryId: message.entryId ?? `message-${messageIndex}` },
        data: content.data as PimoteSubagentStartData,
      });
    });
  });
  const byOperation = new Map<string, ActiveSubagentContent>();
  for (const item of [...discovered, ...active]) byOperation.set(item.operationId, item);
  return { messages: hydratedMessages, active: [...byOperation.values()] };
}

/** Fold one finalized message's active subagent blocks into the projection
 *  state without rescanning the transcript. Ordering matches
 *  `hydrateSubagentContent`: blocks discovered in the message take their
 *  content order, existing active entries keep their values. */
export function projectMessage(state: SubagentContentState, message: PimoteAgentMessage, messageIndex: number, messages: readonly PimoteAgentMessage[]): SubagentContentState {
  const parentMessageId = message.entryId ?? `message-${messageIndex}`;
  const discovered: ActiveSubagentContent[] = [];
  message.content.forEach((content, contentIndex) => {
    if (content.type !== 'subagent' || content.subagentState !== 'active') return;
    discovered.push({
      parentMessageId,
      contentIndex,
      operationId: content.operationId,
      kind: content.subagentKind,
      placement: content.placement ?? { entryId: parentMessageId },
      data: content.data as PimoteSubagentStartData,
    });
  });
  if (discovered.length === 0) return { messages, active: state.active };
  const byOperation = new Map<string, ActiveSubagentContent>();
  for (const item of discovered) byOperation.set(item.operationId, item);
  for (const item of state.active) byOperation.set(item.operationId, item);
  return { messages, active: [...byOperation.values()] };
}

/** Narrow a session feed to dedicated projected-content lifecycle events. */
export function isSubagentContentEvent(event: unknown): event is SubagentContentEvent {
  if (event === null || typeof event !== 'object') return false;
  const type = (event as { type?: unknown }).type;
  return type === 'subagent_content_start' || type === 'subagent_content_delta' || type === 'subagent_content_end';
}
