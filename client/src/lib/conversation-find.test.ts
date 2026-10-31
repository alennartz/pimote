import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage } from '@pimote/shared';
import { findInConversation } from './conversation-find.js';

function message(role: string, content: PimoteAgentMessage['content'], entryId?: string): PimoteAgentMessage {
  return { role, content, ...(entryId ? { entryId } : {}) };
}

describe('conversation search', () => {
  it('finds case-insensitive matches in user and assistant text blocks in transcript order', () => {
    const messages: PimoteAgentMessage[] = [
      message('user', [{ type: 'text', text: 'Fix the retry test.' }], 'u1'),
      message(
        'assistant',
        [
          { type: 'thinking', text: 'The retry path is not the root cause.' },
          { type: 'text', text: 'I will inspect the retry path.' },
          { type: 'tool_call', text: 'retry' },
          { type: 'text', text: 'The RETRY fixture needs an injected clock.' },
        ],
        'a1',
      ),
    ];

    expect(findInConversation(messages, 'retry')).toEqual([
      { messageKey: 'u1', blockIndex: 0, offset: 8, length: 5 },
      { messageKey: 'a1', blockIndex: 1, offset: 19, length: 5 },
      { messageKey: 'a1', blockIndex: 3, offset: 4, length: 5 },
    ]);
  });

  it('does not search thinking, tool, system, custom, or non-text content', () => {
    const messages: PimoteAgentMessage[] = [
      message('assistant', [
        { type: 'thinking', text: 'retry' },
        { type: 'tool_result', text: 'retry' },
      ]),
      message('system', [{ type: 'text', text: 'retry' }]),
      message('custom', [{ type: 'text', text: 'retry' }]),
      message('user', [{ type: 'tool_call', text: 'retry' }]),
    ];

    expect(findInConversation(messages, 'retry')).toEqual([]);
  });

  it('returns no matches for an empty query', () => {
    const messages: PimoteAgentMessage[] = [message('user', [{ type: 'text', text: 'Any message' }])];

    expect(findInConversation(messages, '')).toEqual([]);
  });
});
