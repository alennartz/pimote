import { describe, it, expect } from 'vitest';
import { mapAgentMessage, mapAgentMessages, type SdkMessage } from './message-mapper.js';

describe('mapAgentMessage', () => {
  describe('entryId pass-through', () => {
    it('preserves SDK message id as entryId for user messages', () => {
      const msg: SdkMessage = {
        id: 'entry-abc-123',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      };

      const result = mapAgentMessage(msg);

      expect(result.entryId).toBe('entry-abc-123');
      expect(result.role).toBe('user');
    });

    it('preserves SDK message id as entryId for assistant messages', () => {
      const msg: SdkMessage = {
        id: 'entry-def-456',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      };

      const result = mapAgentMessage(msg);

      expect(result.entryId).toBe('entry-def-456');
      expect(result.role).toBe('assistant');
    });

    it('omits entryId when SDK message has no id', () => {
      const msg: SdkMessage = {
        role: 'user',
        content: [{ type: 'text', text: 'No id' }],
      };

      const result = mapAgentMessage(msg);

      expect(result.entryId).toBeUndefined();
    });

    it('preserves entryId for custom messages', () => {
      const msg: SdkMessage = {
        id: 'entry-custom-789',
        role: 'custom',
        customType: 'agent-complete',
        display: true,
        content: [{ type: 'text', text: 'Done' }],
      };

      const result = mapAgentMessage(msg);

      expect(result.entryId).toBe('entry-custom-789');
      expect(result.customType).toBe('agent-complete');
    });

    it('preserves entryId for tool result messages', () => {
      const msg: SdkMessage = {
        id: 'entry-tool-999',
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
      };

      const result = mapAgentMessage(msg);

      expect(result.entryId).toBe('entry-tool-999');
      expect(result.role).toBe('toolResult');
    });
  });
});

describe('mapAgentMessages', () => {
  it('preserves entryId across all messages in the array', () => {
    const messages: SdkMessage[] = [
      { id: 'entry-1', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { id: 'entry-2', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'No id' }] },
    ];

    const results = mapAgentMessages(messages);

    expect(results).toHaveLength(3);
    expect(results[0].entryId).toBe('entry-1');
    expect(results[1].entryId).toBe('entry-2');
    expect(results[2].entryId).toBeUndefined();
  });
});
