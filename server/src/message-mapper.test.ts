import { describe, it, expect } from 'vitest';
import { mapAgentMessage, mapAgentMessages, extractMessageEntryIds, applyEntryIds, type SdkMessage, type SdkSessionEntry } from './message-mapper.js';

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

describe('extractMessageEntryIds', () => {
  function entry(overrides: Partial<SdkSessionEntry> & { type: string; id: string }): SdkSessionEntry {
    return { parentId: null, ...overrides };
  }

  it('extracts IDs from message entries in order', () => {
    const branch: SdkSessionEntry[] = [entry({ id: 'e1', type: 'message' }), entry({ id: 'e2', type: 'message' }), entry({ id: 'e3', type: 'message' })];
    expect(extractMessageEntryIds(branch)).toEqual(['e1', 'e2', 'e3']);
  });

  it('includes custom_message entries', () => {
    const branch: SdkSessionEntry[] = [entry({ id: 'e1', type: 'message' }), entry({ id: 'e2', type: 'custom_message' }), entry({ id: 'e3', type: 'message' })];
    expect(extractMessageEntryIds(branch)).toEqual(['e1', 'e2', 'e3']);
  });

  it('includes branch_summary entries with summary text', () => {
    const branch: SdkSessionEntry[] = [
      entry({ id: 'e1', type: 'message' }),
      entry({ id: 'bs1', type: 'branch_summary', summary: 'some summary' }),
      entry({ id: 'e2', type: 'message' }),
    ];
    expect(extractMessageEntryIds(branch)).toEqual(['e1', 'bs1', 'e2']);
  });

  it('skips branch_summary entries without summary', () => {
    const branch: SdkSessionEntry[] = [entry({ id: 'e1', type: 'message' }), entry({ id: 'bs1', type: 'branch_summary' }), entry({ id: 'e2', type: 'message' })];
    expect(extractMessageEntryIds(branch)).toEqual(['e1', 'e2']);
  });

  it('skips non-message entries (model_change, thinking_level_change, label)', () => {
    const branch: SdkSessionEntry[] = [
      entry({ id: 'e1', type: 'message' }),
      entry({ id: 'mc1', type: 'model_change' }),
      entry({ id: 'tl1', type: 'thinking_level_change' }),
      entry({ id: 'lb1', type: 'label' }),
      entry({ id: 'e2', type: 'message' }),
    ];
    expect(extractMessageEntryIds(branch)).toEqual(['e1', 'e2']);
  });

  it('handles compaction: compaction ID first, then kept messages, then post-compaction', () => {
    const branch: SdkSessionEntry[] = [
      entry({ id: 'e1', type: 'message' }),
      entry({ id: 'e2', type: 'message' }), // firstKeptEntryId
      entry({ id: 'e3', type: 'message' }),
      entry({ id: 'c1', type: 'compaction', firstKeptEntryId: 'e2' }),
      entry({ id: 'e4', type: 'message' }),
      entry({ id: 'e5', type: 'message' }),
    ];
    // compaction summary → kept (e2, e3) → post-compaction (e4, e5)
    expect(extractMessageEntryIds(branch)).toEqual(['c1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('returns empty array for empty branch', () => {
    expect(extractMessageEntryIds([])).toEqual([]);
  });
});

describe('applyEntryIds', () => {
  it('sets entryId on mapped messages by index', () => {
    const messages = [
      { role: 'user', content: [] },
      { role: 'assistant', content: [] },
    ];
    applyEntryIds(messages, ['id-1', 'id-2']);
    expect(messages[0].entryId).toBe('id-1');
    expect(messages[1].entryId).toBe('id-2');
  });

  it('handles more IDs than messages (extra IDs ignored)', () => {
    const messages = [{ role: 'user', content: [] }];
    applyEntryIds(messages, ['id-1', 'id-2']);
    expect(messages[0].entryId).toBe('id-1');
  });

  it('handles fewer IDs than messages (extra messages untouched)', () => {
    const messages = [
      { role: 'user', content: [] },
      { role: 'assistant', content: [] },
    ];
    applyEntryIds(messages, ['id-1']);
    expect(messages[0].entryId).toBe('id-1');
    expect(messages[1].entryId).toBeUndefined();
  });
});
