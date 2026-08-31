import { describe, it, expect } from 'vitest';
import { mapAgentMessage, mapAgentMessages, mapContextEntries, extractMessageEntryIds, applyEntryIds, type SdkSessionEntry } from './message-mapper.js';

describe('mapAgentMessage', () => {
  // AgentMessage is a discriminated union with many required fields per role;
  // the mapper only reads a subset, so tests construct minimal shapes and cast.
  const m = (o: Record<string, unknown>) => mapAgentMessage(o as never);

  describe('field mapping', () => {
    it('maps user message text content', () => {
      const result = m({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
      expect(result.role).toBe('user');
      expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('maps assistant message text content', () => {
      const result = m({ role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] });
      expect(result.role).toBe('assistant');
      expect(result.content).toEqual([{ type: 'text', text: 'Hi there' }]);
    });

    it('preserves customType and display for custom messages', () => {
      const result = m({ role: 'custom', customType: 'agent-complete', display: true, content: [{ type: 'text', text: 'Done' }] });
      expect(result.role).toBe('custom');
      expect(result.customType).toBe('agent-complete');
      expect(result.display).toBe(true);
    });

    it('maps tool result messages to a tool_result block', () => {
      const result = m({ role: 'toolResult', toolCallId: 'tc-1', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] });
      expect(result.role).toBe('toolResult');
      expect(result.content).toEqual([{ type: 'tool_result', toolCallId: 'tc-1', toolName: 'read', result: 'file contents', isError: undefined }]);
    });

    it('preserves native bash result metadata for a context-visible execution', () => {
      const result = m({
        role: 'bashExecution',
        command: 'git status --short',
        output: ' M src/index.ts\\n',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      });

      expect(result).toMatchObject({
        role: 'bashExecution',
        command: 'git status --short',
        output: ' M src/index.ts\\n',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      });
    });

    it('preserves cancellation, truncation, full-output path, and !! exclusion metadata', () => {
      const result = m({
        role: 'bashExecution',
        command: 'cat huge.log',
        output: 'partial',
        cancelled: true,
        truncated: true,
        fullOutputPath: '/tmp/pimote-bash-output.log',
        excludeFromContext: true,
      });

      expect(result).toMatchObject({
        role: 'bashExecution',
        command: 'cat huge.log',
        output: 'partial',
        cancelled: true,
        truncated: true,
        fullOutputPath: '/tmp/pimote-bash-output.log',
        excludeFromContext: true,
      });
    });

    it('preserves provider error text for failed assistant messages', () => {
      const result = m({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      });
      expect(result.role).toBe('assistant');
      expect(result.content).toEqual([]);
      expect(result.errorMessage).toBe('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      expect(result.aborted).toBeUndefined();
    });

    it('marks aborted assistant turns', () => {
      const result = m({ role: 'assistant', content: [], stopReason: 'aborted' });
      expect(result.aborted).toBe(true);
    });

    it('does not assign entryId (entry IDs are applied separately via applyEntryIds)', () => {
      const result = m({ role: 'user', content: [{ type: 'text', text: 'x' }] });
      expect(result.entryId).toBeUndefined();
    });
  });
});

describe('mapAgentMessages', () => {
  it('maps every message in the array preserving order and role', () => {
    const results = mapAgentMessages([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ] as never);

    expect(results).toHaveLength(2);
    expect(results[0].role).toBe('user');
    expect(results[1].role).toBe('assistant');
  });
});

describe('mapContextEntries', () => {
  it('uses SDK context semantics and attaches each source entry ID', () => {
    const messages = mapContextEntries([
      { id: 'user-1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        id: 'custom-1',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'custom_message',
        customType: 'agent-complete',
        content: [{ type: 'text', text: 'done' }],
        display: true,
      },
      {
        id: 'compact-1',
        parentId: 'custom-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'compaction',
        summary: 'Earlier context',
        firstKeptEntryId: 'user-1',
        tokensBefore: 100,
      },
      {
        id: 'bash-1',
        parentId: 'compact-1',
        timestamp: '2026-01-01T00:00:03.000Z',
        type: 'message',
        message: { role: 'bashExecution', command: 'pwd', output: '/tmp', timestamp: 0 },
      },
      { id: 'model-1', parentId: 'bash-1', timestamp: '2026-01-01T00:00:04.000Z', type: 'model_change', provider: 'test', modelId: 'test-model' },
    ] as never);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }], entryId: 'user-1' },
      { role: 'custom', customType: 'agent-complete', display: true, content: [{ type: 'text', text: 'done' }], entryId: 'custom-1' },
      { role: 'compactionSummary', content: [{ type: 'text', text: 'Earlier context' }], entryId: 'compact-1' },
      { role: 'bashExecution', content: [{ type: 'text', text: '$ pwd\n/tmp' }], entryId: 'bash-1' },
    ]);
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
