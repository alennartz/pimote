import { describe, it, expect } from 'vitest';
import {
  mapAgentMessage,
  mapAgentMessages,
  mapContextEntries,
  extractMessageEntryIds,
  mapCustomEntry,
  customEntryDisplayText,
  rendererRegisteredVisibility,
  type SdkSessionEntry,
} from './message-mapper.js';

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

    it('maps system prompt-section delta messages (pi 0.87+)', () => {
      const result = m({ role: 'system', content: '', sections: { voice: 'You are a voice interpreter…', legacy: null } });
      expect(result.role).toBe('system');
      expect(result.content).toEqual([]);
      expect(result.sections).toEqual({ voice: 'You are a voice interpreter…', legacy: null });
    });

    it('does not assign entryId (the client assigns entry IDs from agent_end messageEntryIds)', () => {
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

  it('omits the leading system message and keeps later section deltas', () => {
    const results = mapAgentMessages([
      { role: 'system', content: '', sections: { preamble: 'base prompt' } },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'system', content: '', sections: { voice: 'interpreter prompt' } },
    ] as never);

    expect(results).toHaveLength(2);
    expect(results[0].role).toBe('user');
    expect(results[1]).toMatchObject({ role: 'system', sections: { voice: 'interpreter prompt' } });
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
        message: {
          role: 'bashExecution',
          command: 'pwd',
          output: '/tmp',
          exitCode: 1,
          cancelled: false,
          truncated: true,
          fullOutputPath: '/tmp/pimote-bash-output.log',
          excludeFromContext: true,
          timestamp: 0,
        },
      },
      { id: 'model-1', parentId: 'bash-1', timestamp: '2026-01-01T00:00:04.000Z', type: 'model_change', provider: 'test', modelId: 'test-model' },
    ] as never);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }], entryId: 'user-1' },
      { role: 'custom', customType: 'agent-complete', display: true, content: [{ type: 'text', text: 'done' }], entryId: 'custom-1' },
      { role: 'compactionSummary', content: [{ type: 'text', text: 'Earlier context' }], entryId: 'compact-1' },
      {
        role: 'bashExecution',
        content: [{ type: 'text', text: '$ pwd\n/tmp' }],
        command: 'pwd',
        output: '/tmp',
        exitCode: 1,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/pimote-bash-output.log',
        excludeFromContext: true,
        entryId: 'bash-1',
      },
    ]);
  });

  it('omits the leading system entry but maps later system deltas, keeping IDs aligned', () => {
    const systemEntry = (id: string, sections: Record<string, string | null>) => ({
      id,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message' as const,
      message: { role: 'system' as const, content: '', sections },
    });
    const entries = [
      systemEntry('sys-1', { preamble: 'base prompt' }),
      {
        id: 'user-1',
        parentId: 'sys-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'message' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
      },
      systemEntry('sys-2', { voice: 'interpreter prompt' }),
    ];

    const messages = mapContextEntries(entries as never);
    const ids = extractMessageEntryIds(entries as never);

    expect(messages.map((msg) => msg.role)).toEqual(['user', 'system']);
    expect(messages[1]).toMatchObject({ entryId: 'sys-2', sections: { voice: 'interpreter prompt' } });
    expect(ids).toEqual(['user-1', 'sys-2']);
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

  it('skips the leading system message entry but keeps later ones (mirrors mapContextEntries)', () => {
    const branch: SdkSessionEntry[] = [
      entry({ id: 'sys1', type: 'message', message: { role: 'system', content: '' } }),
      entry({ id: 'u1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      entry({ id: 'sys2', type: 'message', message: { role: 'system', content: '' } }),
    ];
    expect(extractMessageEntryIds(branch)).toEqual(['u1', 'sys2']);
  });

  it('returns empty array for empty branch', () => {
    expect(extractMessageEntryIds([])).toEqual([]);
  });
});

describe('custom entries (pi.appendEntry)', () => {
  const customEntry = (overrides: Partial<Record<string, unknown>> & { id: string }): SdkSessionEntry =>
    ({ parentId: null, timestamp: '2026-01-01T00:00:00.000Z', type: 'custom', customType: 'print-prompt', data: { text: 'the prompt' }, ...overrides }) as never;
  const visible = (customType: string) => customType === 'print-prompt';

  describe('customEntryDisplayText', () => {
    it('uses a string payload directly', () => {
      expect(customEntryDisplayText('raw body')).toBe('raw body');
    });

    it('prefers string text/markdown/content fields', () => {
      expect(customEntryDisplayText({ text: 'a' })).toBe('a');
      expect(customEntryDisplayText({ markdown: 'b' })).toBe('b');
      expect(customEntryDisplayText({ content: 'c' })).toBe('c');
      expect(customEntryDisplayText({ text: 'a', markdown: 'b' })).toBe('a');
    });

    it('falls back to pretty JSON for other shapes', () => {
      expect(customEntryDisplayText({ count: 42 })).toBe('{\n  "count": 42\n}');
    });

    it('returns undefined for empty payloads, JSON fallback for empty string fields', () => {
      expect(customEntryDisplayText(undefined)).toBeUndefined();
      expect(customEntryDisplayText('')).toBeUndefined();
      expect(customEntryDisplayText({})).toBeUndefined();
      expect(customEntryDisplayText({ text: '' })).toBe('{\n  "text": ""\n}');
    });
  });

  describe('mapCustomEntry', () => {
    it('maps to a display-only custom message with entry id', () => {
      expect(mapCustomEntry(customEntry({ id: 'ce-1' }) as never)).toEqual({
        role: 'custom',
        content: [{ type: 'text', text: 'the prompt' }],
        customType: 'print-prompt',
        display: true,
        fromEntry: true,
        entryId: 'ce-1',
      });
    });
  });

  describe('rendererRegisteredVisibility', () => {
    it('is true only for customTypes with a registered entry renderer', () => {
      const session = { extensionRunner: { getEntryRenderer: (ct: string) => (ct === 'print-prompt' ? {} : undefined) } };
      const isVisible = rendererRegisteredVisibility(session);
      expect(isVisible('print-prompt')).toBe(true);
      expect(isVisible('idle-marker')).toBe(false);
    });

    it('reads the runner at call time so extension reloads are picked up', () => {
      const session: { extensionRunner?: { getEntryRenderer?: (ct: string) => unknown } } = {};
      const isVisible = rendererRegisteredVisibility(session);
      expect(isVisible('print-prompt')).toBe(false);
      session.extensionRunner = { getEntryRenderer: () => ({}) };
      expect(isVisible('print-prompt')).toBe(true);
    });
  });

  describe('mapContextEntries + extractMessageEntryIds alignment', () => {
    it('surfaces visible custom entries in order, in both messages and ids', () => {
      const branch: SdkSessionEntry[] = [
        { id: 'e1', parentId: null, timestamp: 't', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } as never,
        customEntry({ id: 'ce-1', parentId: 'e1' }),
        customEntry({ id: 'ce-2', parentId: 'ce-1', customType: 'idle-marker', data: { at: 'now' } }),
        { id: 'e2', parentId: 'ce-2', timestamp: 't', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } } as never,
      ];

      const messages = mapContextEntries(branch, visible);
      expect(messages.map((m) => [m.role, m.entryId])).toEqual([
        ['user', 'e1'],
        ['custom', 'ce-1'],
        ['assistant', 'e2'],
      ]);
      expect(messages[1]).toMatchObject({ customType: 'print-prompt', fromEntry: true, display: true });

      expect(extractMessageEntryIds(branch, visible)).toEqual(['e1', 'ce-1', 'e2']);
    });

    it('keeps the compaction walk aligned too', () => {
      const branch: SdkSessionEntry[] = [
        { id: 'e1', parentId: null, timestamp: 't', type: 'message', message: { role: 'user', content: [] } } as never,
        { id: 'e2', parentId: 'e1', timestamp: 't', type: 'message', message: { role: 'assistant', content: [] } } as never,
        customEntry({ id: 'ce-1', parentId: 'e2' }),
        { id: 'c1', parentId: 'ce-1', timestamp: 't', type: 'compaction', summary: 's', firstKeptEntryId: 'e2' } as never,
        { id: 'e3', parentId: 'c1', timestamp: 't', type: 'message', message: { role: 'user', content: [] } } as never,
      ];
      // What ws-handler feeds each side: buildContextEntries() output to the
      // mapper (compaction-aware), the raw branch to the id extractor (which
      // performs its own compaction walk).
      const contextEntries: SdkSessionEntry[] = [branch[3], branch[1], branch[2], branch[4]];

      const messages = mapContextEntries(contextEntries, visible);
      expect(messages.map((m) => m.entryId)).toEqual(['c1', 'e2', 'ce-1', 'e3']);
      expect(extractMessageEntryIds(branch, visible)).toEqual(['c1', 'e2', 'ce-1', 'e3']);
    });

    it('excludes custom entries entirely without a predicate', () => {
      const branch: SdkSessionEntry[] = [customEntry({ id: 'ce-1' })];
      expect(mapContextEntries(branch)).toEqual([]);
      expect(extractMessageEntryIds(branch)).toEqual([]);
    });
  });
});
