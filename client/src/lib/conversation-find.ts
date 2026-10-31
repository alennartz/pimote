import type { PimoteAgentMessage } from '@pimote/shared';

export interface FindMatch {
  messageKey: string;
  blockIndex: number;
  offset: number;
  length: number;
}

/** Find query matches in user and assistant text blocks. */
export function findInConversation(_messages: readonly PimoteAgentMessage[], _query: string): FindMatch[] {
  throw new Error('not implemented');
}
