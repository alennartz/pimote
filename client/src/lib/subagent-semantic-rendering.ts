import type { PimoteAgentMessage, PimoteMessageContent } from '@pimote/shared';
import type { SemanticBlock, PiEventRef } from './subagent-semantic.js';

/** One native content block or semantic replacement in message order. */
export type SemanticContentItem = { readonly kind: 'native'; readonly content: PimoteMessageContent } | { readonly kind: 'semantic'; readonly block: SemanticBlock };

function matchesToolRef(ref: PiEventRef, message: PimoteAgentMessage, content: PimoteMessageContent, sessionId: string): boolean {
  if (ref.sessionId !== sessionId || (content.type !== 'tool_call' && content.type !== 'tool_result')) return false;
  if (ref.toolCallId !== undefined && ref.toolCallId === content.toolCallId) return ref.kind === 'tool_call' || ref.kind === 'lifecycle';
  // Some older provider records only carried the Pi entry id. Keep this
  // fallback narrow so a whole assistant row is never replaced accidentally.
  return ref.toolCallId === undefined && ref.entryId !== undefined && ref.entryId === message.entryId && (ref.kind === 'tool_call' || ref.kind === 'lifecycle');
}

function matchesCustomRef(ref: PiEventRef, message: PimoteAgentMessage, sessionId: string): boolean {
  if (message.role !== 'custom' || ref.sessionId !== sessionId || ref.entryId === undefined || ref.entryId !== message.entryId) return false;
  return ref.kind === 'custom_message' || ref.kind === 'lifecycle';
}

function containsSemanticEventId(value: unknown, eventId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSemanticEventId(item, eventId));
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.eventId === eventId && typeof record.kind === 'string') return true;
  return [record.semantic, record.semanticEvents, record.semanticEvent].some((candidate) => containsSemanticEventId(candidate, eventId));
}

/** True when a semantic block has a native entry or tool-call anchor. */
export function semanticBlockHasNativeAnchor(block: SemanticBlock): boolean {
  return block.nativeOccurrence !== undefined || block.relatedPiEvents.some((ref) => ref.entryId !== undefined || ref.toolCallId !== undefined);
}

/** True when a semantic block is allowed to replace this native block. */
export function semanticBlockMatchesContent(block: SemanticBlock, message: PimoteAgentMessage, content: PimoteMessageContent, sessionId: string): boolean {
  if (block.nativeOccurrence) return false;
  return block.relatedPiEvents.some((ref) => matchesToolRef(ref, message, content, sessionId));
}

function matchesMetadataId(block: SemanticBlock, details: unknown): boolean {
  if (block.eventKeys?.[0] !== undefined && block.eventKeys[0] !== block.eventId) return false;
  return (block.eventIds ?? [block.eventId]).some((eventId) => containsSemanticEventId(details, eventId));
}

/** True when a semantic block replaces this whole custom-message entry. */
export function semanticBlockMatchesMessage(block: SemanticBlock, message: PimoteAgentMessage, sessionId: string, messageIndex?: number): boolean {
  if (message.role !== 'custom') return false;
  const occurrence = block.nativeOccurrence;
  if (occurrence)
    return occurrence.sessionId === sessionId && (occurrence.entryId !== undefined ? occurrence.entryId === message.entryId : occurrence.messageIndex === messageIndex);
  if (block.relatedPiEvents.some((ref) => matchesCustomRef(ref, message, sessionId))) return true;
  return matchesMetadataId(block, message.details);
}

/** True when the block has a visible native anchor in this message. */
export function semanticBlockHasMessageAnchor(block: SemanticBlock, message: PimoteAgentMessage, sessionId: string, messageIndex?: number): boolean {
  if (block.nativeOccurrence) return semanticBlockMatchesMessage(block, message, sessionId, messageIndex);
  if (semanticBlockMatchesMessage(block, message, sessionId, messageIndex)) return true;
  return message.content.some((content) => semanticBlockMatchesContent(block, message, content, sessionId));
}

/** Keep replacements in their native message and tool-invocation scopes. */
export function indexSemanticAnchors(
  messages: readonly PimoteAgentMessage[],
  blocks: readonly SemanticBlock[],
  sessionId: string,
): {
  readonly byMessage: ReadonlyMap<PimoteAgentMessage, readonly SemanticBlock[]>;
  readonly hiddenMessages: ReadonlySet<PimoteAgentMessage>;
  readonly remaining: readonly SemanticBlock[];
} {
  const customEntries = new Map<string, number>();
  const customMessages: Array<{ message: PimoteAgentMessage; index: number }> = [];
  const toolEntries = new Map<string, number>();
  const toolCalls = new Map<string, number>();
  const byMessage = new Map<PimoteAgentMessage, SemanticBlock[]>();
  const hiddenMessages = new Set<PimoteAgentMessage>();
  const remaining: SemanticBlock[] = [];

  messages.forEach((message, index) => {
    if (message.display === false) return;
    if (message.role === 'custom') {
      customMessages.push({ message, index });
      if (message.entryId !== undefined && !customEntries.has(message.entryId)) customEntries.set(message.entryId, index);
    }
    for (const content of message.content) {
      if (content.type !== 'tool_call' && content.type !== 'tool_result') continue;
      if (content.toolCallId !== undefined && !toolCalls.has(content.toolCallId)) toolCalls.set(content.toolCallId, index);
      if (message.entryId !== undefined && !toolEntries.has(message.entryId)) toolEntries.set(message.entryId, index);
    }
  });

  for (const block of blocks) {
    const anchors = new Set<number>();
    const occurrence = block.nativeOccurrence;
    if (occurrence) {
      const index = occurrence.entryId !== undefined ? customEntries.get(occurrence.entryId) : occurrence.messageIndex;
      if (occurrence.sessionId === sessionId && index !== undefined && messages[index]?.role === 'custom' && messages[index].display !== false) anchors.add(index);
    } else {
      const customAnchors = new Set<number>();
      for (const ref of block.relatedPiEvents) {
        if (ref.sessionId !== sessionId) continue;
        if (ref.kind === 'tool_call' || (ref.kind === 'lifecycle' && ref.toolCallId !== undefined)) {
          const index = ref.toolCallId !== undefined ? toolCalls.get(ref.toolCallId) : ref.entryId !== undefined ? toolEntries.get(ref.entryId) : undefined;
          if (index !== undefined) anchors.add(index);
        } else if ((ref.kind === 'custom_message' || ref.kind === 'lifecycle') && ref.entryId !== undefined) {
          const index = customEntries.get(ref.entryId);
          if (index !== undefined) customAnchors.add(index);
          else if (ref.kind === 'lifecycle') {
            const toolIndex = toolEntries.get(ref.entryId);
            if (toolIndex !== undefined) anchors.add(toolIndex);
          }
        }
      }
      if (anchors.size === 0 && customAnchors.size > 0) anchors.add(Math.min(...customAnchors));
      if (anchors.size === 0) {
        const fallback = customMessages.find(({ message }) => matchesMetadataId(block, message.details));
        if (fallback) anchors.add(fallback.index);
      }
      for (const index of customAnchors) if (!anchors.has(index)) hiddenMessages.add(messages[index]);
    }
    if (anchors.size === 0) {
      remaining.push(block);
      continue;
    }
    for (const index of anchors) {
      const message = messages[index];
      const scoped = anchors.size > 1 ? { ...block, blockId: `${block.blockId}:native:${message.entryId ?? index}` } : block;
      const assigned = byMessage.get(message) ?? [];
      assigned.push(scoped);
      byMessage.set(message, assigned);
    }
  }
  for (const message of byMessage.keys()) hiddenMessages.delete(message);
  return { byMessage, hiddenMessages, remaining };
}

/** Index insertion-only facts without moving them behind later native messages. */
export function indexSemanticInsertions(
  messages: readonly PimoteAgentMessage[],
  blocks: readonly SemanticBlock[],
  sessionId: string,
): ReadonlyMap<number, readonly SemanticBlock[]> {
  const insertions = new Map<number, SemanticBlock[]>();
  for (const block of blocks) {
    const position = block.placement.transcriptPosition;
    if (!position || position.sessionId !== sessionId || semanticBlockHasNativeAnchor(block)) continue;
    if (block.relatedPiEvents.length > 0 && !block.relatedPiEvents.some((ref) => ref.sessionId === sessionId)) continue;
    const nativeIndex = position.afterEntryId === null ? -1 : messages.findLastIndex((message) => message.entryId === position.afterEntryId);
    const index = nativeIndex >= 0 ? nativeIndex + 1 : (position.messageIndex ?? (position.afterEntryId === null ? 0 : undefined));
    if (index === undefined || !Number.isInteger(index) || index < 0 || index > messages.length) continue;
    const at = insertions.get(index) ?? [];
    at.push(block);
    insertions.set(index, at);
  }
  return insertions;
}

/**
 * Build the content-level replacement plan. A semantic block is inserted at
 * its first referenced tool/result block and all of its referenced native
 * blocks are hidden. Unrelated blocks stay native and keep their order.
 */
export function projectSemanticContent(
  message: PimoteAgentMessage,
  content: readonly PimoteMessageContent[],
  semanticBlocks: readonly SemanticBlock[],
  sessionId: string,
): readonly SemanticContentItem[] {
  const matches = new Map<number, SemanticBlock[]>();
  const hidden = new Set<number>();

  for (const semantic of semanticBlocks) {
    const indices: number[] = [];
    content.forEach((block, index) => {
      if (semanticBlockMatchesContent(semantic, message, block, sessionId)) indices.push(index);
    });
    if (indices.length === 0) continue;
    for (const index of indices) {
      hidden.add(index);
      const at = matches.get(index) ?? [];
      at.push(semantic);
      matches.set(index, at);
    }
  }

  const items: SemanticContentItem[] = [];
  content.forEach((block, index) => {
    for (const semantic of matches.get(index) ?? []) {
      // A semantic event that references both a call and its result renders
      // once, at the first native block, rather than twice.
      if (items.some((item) => item.kind === 'semantic' && item.block.blockId === semantic.blockId)) continue;
      items.push({ kind: 'semantic', block: semantic });
    }
    if (!hidden.has(index)) items.push({ kind: 'native', content: block });
  });
  return Object.freeze(items);
}

/** Semantic blocks that replace a whole custom message. */
export function projectSemanticMessage(message: PimoteAgentMessage, semanticBlocks: readonly SemanticBlock[], sessionId: string, messageIndex?: number): readonly SemanticBlock[] {
  if (message.role !== 'custom') return [];
  return Object.freeze(semanticBlocks.filter((block) => semanticBlockMatchesMessage(block, message, sessionId, messageIndex)));
}
