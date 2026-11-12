import type { PimoteAgentMessage, PimoteMessageContent } from '@pimote/shared';
import type { SemanticBlock, PiEventRef } from './subagent-semantic.js';

/** One native content block or semantic replacement in message order. */
export type SemanticContentItem = { readonly kind: 'native'; readonly content: PimoteMessageContent } | { readonly kind: 'semantic'; readonly block: SemanticBlock };

function matchesToolRef(ref: PiEventRef, message: PimoteAgentMessage, content: PimoteMessageContent, sessionId: string): boolean {
  if (ref.sessionId !== sessionId || (content.type !== 'tool_call' && content.type !== 'tool_result')) return false;
  if (ref.toolCallId !== undefined && ref.toolCallId === content.toolCallId) return ref.kind === 'tool_call';
  // Some older provider records only carried the Pi entry id. Keep this
  // fallback narrow so a whole assistant row is never replaced accidentally.
  return ref.toolCallId === undefined && ref.entryId !== undefined && ref.entryId === message.entryId && ref.kind === 'tool_call';
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
  return block.relatedPiEvents.some((ref) => ref.entryId !== undefined || ref.toolCallId !== undefined);
}

/** True when a semantic block is allowed to replace this native block. */
export function semanticBlockMatchesContent(block: SemanticBlock, message: PimoteAgentMessage, content: PimoteMessageContent, sessionId: string): boolean {
  return block.relatedPiEvents.some((ref) => matchesToolRef(ref, message, content, sessionId));
}

/** True when a semantic block replaces this whole custom-message entry. */
export function semanticBlockMatchesMessage(block: SemanticBlock, message: PimoteAgentMessage, sessionId: string): boolean {
  if (block.relatedPiEvents.some((ref) => matchesCustomRef(ref, message, sessionId))) return true;
  return message.role === 'custom' && containsSemanticEventId(message.details, block.eventId);
}

/** True when the block has a visible native anchor in this message. */
export function semanticBlockHasMessageAnchor(block: SemanticBlock, message: PimoteAgentMessage, sessionId: string): boolean {
  if (semanticBlockMatchesMessage(block, message, sessionId)) return true;
  return message.content.some((content) => semanticBlockMatchesContent(block, message, content, sessionId));
}

/** Assign each semantic block to its first visible native message. */
export function indexSemanticAnchors(
  messages: readonly PimoteAgentMessage[],
  blocks: readonly SemanticBlock[],
  sessionId: string,
): { readonly byMessage: ReadonlyMap<PimoteAgentMessage, readonly SemanticBlock[]>; readonly remaining: readonly SemanticBlock[] } {
  const customEntries = new Map<string, number>();
  const toolEntries = new Map<string, number>();
  const toolCalls = new Map<string, number>();
  const byMessage = new Map<PimoteAgentMessage, SemanticBlock[]>();
  const remaining: SemanticBlock[] = [];
  if (blocks.length === 0) return { byMessage, remaining };

  messages.forEach((message, index) => {
    if (message.display === false) return;
    if (message.role === 'custom' && message.entryId !== undefined && !customEntries.has(message.entryId)) customEntries.set(message.entryId, index);
    for (const content of message.content) {
      if (content.type !== 'tool_call' && content.type !== 'tool_result') continue;
      if (content.toolCallId !== undefined && !toolCalls.has(content.toolCallId)) toolCalls.set(content.toolCallId, index);
      if (message.entryId !== undefined && !toolEntries.has(message.entryId)) toolEntries.set(message.entryId, index);
    }
  });

  for (const block of blocks) {
    let first = Infinity;
    for (const ref of block.relatedPiEvents) {
      if (ref.sessionId !== sessionId) continue;
      let index: number | undefined;
      if (ref.kind === 'tool_call') {
        if (ref.toolCallId !== undefined) index = toolCalls.get(ref.toolCallId);
        else if (ref.entryId !== undefined) index = toolEntries.get(ref.entryId);
      } else if ((ref.kind === 'custom_message' || ref.kind === 'lifecycle') && ref.entryId !== undefined) {
        index = customEntries.get(ref.entryId);
      }
      if (index !== undefined) first = Math.min(first, index);
    }
    if (first === Infinity) {
      remaining.push(block);
      continue;
    }
    const message = messages[first];
    const assigned = byMessage.get(message) ?? [];
    assigned.push(block);
    byMessage.set(message, assigned);
  }
  return { byMessage, remaining };
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
export function projectSemanticMessage(message: PimoteAgentMessage, semanticBlocks: readonly SemanticBlock[], sessionId: string): readonly SemanticBlock[] {
  if (message.role !== 'custom') return [];
  return Object.freeze(semanticBlocks.filter((block) => semanticBlockMatchesMessage(block, message, sessionId)));
}
