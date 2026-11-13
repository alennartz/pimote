import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, SubagentContentDeltaEvent, SubagentContentEndEvent, SubagentContentStartEvent } from '../../../shared/src/protocol.js';
import { applySubagentContentEvent, hydrateSubagentContent, type SubagentContentState } from './subagent-content.js';

function assistant(): PimoteAgentMessage {
  return {
    role: 'assistant',
    entryId: 'assistant-entry',
    content: [
      { type: 'text', text: 'before' },
      { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
      { type: 'text', text: 'after' },
    ],
  };
}

function start(): SubagentContentStartEvent {
  return {
    type: 'subagent_content_start',
    sessionId: 'root-session',
    cursor: 1,
    parentMessageId: 'assistant-entry',
    contentIndex: 1,
    operationId: 'send-call',
    kind: 'send',
    placement: { toolCallId: 'send-call', contentIndex: 1 },
    content: {
      type: 'subagent',
      operationId: 'send-call',
      subagentKind: 'send',
      subagentState: 'active',
      placement: { toolCallId: 'send-call', contentIndex: 1 },
      data: { operation: 'send', body: '' },
      streaming: true,
    },
  };
}

function delta(): SubagentContentDeltaEvent {
  return {
    type: 'subagent_content_delta',
    sessionId: 'root-session',
    cursor: 2,
    parentMessageId: 'assistant-entry',
    contentIndex: 1,
    operationId: 'send-call',
    kind: 'send',
    data: { operation: 'send', delta: 'Inspect the configuration.' },
  };
}

function end(state: SubagentContentEndEvent['state'] = 'complete'): SubagentContentEndEvent {
  return {
    type: 'subagent_content_end',
    sessionId: 'root-session',
    cursor: 3,
    parentMessageId: 'assistant-entry',
    contentIndex: 1,
    operationId: 'send-call',
    kind: 'send',
    state,
    content: {
      type: 'subagent',
      operationId: 'send-call',
      subagentKind: 'send',
      subagentState: state,
      placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' },
      data: { operation: 'completion', result: { state: 'idle', output: 'done' } },
    },
  };
}

describe('projected subagent content', () => {
  it('inserts one stable block at its native content index without dropping surrounding content', () => {
    const state = hydrateSubagentContent([assistant()]);
    const next = applySubagentContentEvent(state, start());

    expect(next.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text']);
    expect(next.messages[0]?.content[1]).toMatchObject({ type: 'subagent', operationId: 'send-call', streaming: true });
    expect(next.active).toEqual([{ parentMessageId: 'assistant-entry', contentIndex: 1, operationId: 'send-call', kind: 'send' }]);
  });

  it('applies body deltas in place and keeps the same operation target', () => {
    const started = applySubagentContentEvent(hydrateSubagentContent([assistant()]), start());
    const updated = applySubagentContentEvent(started, delta());

    expect(updated.messages[0]?.content[1]).toMatchObject({
      type: 'subagent',
      operationId: 'send-call',
      data: { operation: 'send', body: 'Inspect the configuration.' },
    });
    expect(updated.active).toEqual(started.active);
  });

  it('replaces the active block with one complete final payload and clears only that active operation', () => {
    const started = applySubagentContentEvent(hydrateSubagentContent([assistant()]), start());
    const completed = applySubagentContentEvent(started, end());

    expect(completed.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text']);
    expect(completed.messages[0]?.content[1]).toMatchObject({ type: 'subagent', subagentState: 'complete', streaming: false });
    expect(completed.active).toEqual([]);
  });

  it('restores complete final blocks and active operation state from one reconnect snapshot', () => {
    const snapshot: PimoteAgentMessage = {
      role: 'assistant',
      entryId: 'assistant-entry',
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'subagent',
          operationId: 'send-call',
          subagentKind: 'send',
          subagentState: 'complete',
          placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' },
          data: { operation: 'completion', result: { state: 'idle', output: 'done' } },
        },
      ],
    };
    const active = [{ parentMessageId: 'another-message', contentIndex: 0, operationId: 'await-call', kind: 'await' }] as const;

    const state = hydrateSubagentContent([snapshot], active);
    expect(state.messages[0]?.content[1]).toMatchObject({ type: 'subagent', subagentState: 'complete' });
    expect(state.active).toEqual(active);
  });

  it('renders an explicit protocol-error payload instead of a blank replacement', () => {
    const errored = applySubagentContentEvent(hydrateSubagentContent([assistant()]), start());
    const result = applySubagentContentEvent(errored, end('protocol_error'));

    expect(result.messages[0]?.content[1]).toMatchObject({
      type: 'subagent',
      subagentState: 'protocol_error',
      data: expect.any(Object),
    });
    expect(result.active).toEqual([]);
  });

  it('does not replay historical delta events during hydration', () => {
    const state: SubagentContentState = hydrateSubagentContent([
      {
        role: 'assistant',
        content: [{ type: 'subagent', operationId: 'send-call', subagentKind: 'send', subagentState: 'complete', data: { operation: 'completion', result: { state: 'idle' } } }],
      },
    ]);

    expect(state.messages[0]?.content).toHaveLength(1);
    expect(state.active).toEqual([]);
  });
});
