import type { PimoteAgentMessage } from '@pimote/shared';

export interface FindMatch {
  messageKey: string;
  blockIndex: number;
  offset: number;
  length: number;
}

/** Find query matches in user and assistant text blocks. */
export function findInConversation(messages: readonly PimoteAgentMessage[], query: string): FindMatch[] {
  if (query.length === 0) return [];

  const normalizedQuery = query.toLowerCase();
  const matches: FindMatch[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    // Persisted messages carry their pi entry identity. The positional fallback
    // keeps matches addressable for transient messages that have no entryId.
    const messageKey = message.entryId ?? `message-${messageIndex}`;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      if (block.type !== 'text' || typeof block.text !== 'string') continue;

      const normalizedText = block.text.toLowerCase();
      let offset = normalizedText.indexOf(normalizedQuery);
      while (offset !== -1) {
        matches.push({ messageKey, blockIndex, offset, length: query.length });
        offset = normalizedText.indexOf(normalizedQuery, offset + query.length);
      }
    }
  }

  return matches;
}
