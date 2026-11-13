import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, SubagentContentDeltaEvent, SubagentContentEndEvent, SubagentContentStartEvent } from '../../../shared/src/protocol.js';
import { applySubagentContentEvent, hydrateSubagentContent } from './subagent-content.js';

const assistant: PimoteAgentMessage = {
  role: 'assistant',
  entryId: 'assistant-entry',
  content: [
    { type: 'text', text: 'before' },
    { type: 'text', text: 'after' },
    { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
  ],
};
const target = { sessionId: 'root-session', parentMessageId: 'assistant-entry', contentIndex: 1, operationId: 'send-call', kind: 'send' } as const;
const start: SubagentContentStartEvent = {
  ...target,
  type: 'subagent_content_start',
  cursor: 1,
  placement: { toolCallId: 'send-call', contentIndex: 1 },
  content: {
    type: 'subagent',
    operationId: 'send-call',
    subagentKind: 'send',
    subagentState: 'active',
    data: { operation: 'send', to: ['worker'], request: 'Check', response: '', phase: 'sending' },
    streaming: true,
  },
};
const request: SubagentContentDeltaEvent = { ...target, type: 'subagent_content_delta', cursor: 2, data: { operation: 'send', field: 'request', delta: ' config' } };
const response: SubagentContentDeltaEvent = { ...target, type: 'subagent_content_delta', cursor: 3, data: { operation: 'send', field: 'response', delta: 'All present' } };
const end: SubagentContentEndEvent = {
  ...target,
  type: 'subagent_content_end',
  cursor: 4,
  state: 'complete',
  content: {
    type: 'subagent',
    operationId: 'send-call',
    subagentKind: 'send',
    subagentState: 'complete',
    data: { operation: 'send', to: ['worker'], request: 'Check config', response: 'All present' },
  },
};

describe('projected subagent content', () => {
  it('keeps one block and surrounding content through request, response, and completion', () => {
    let state = hydrateSubagentContent([assistant]);
    for (const event of [start, request, response]) state = applySubagentContentEvent(state, event);
    expect(state.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text', 'tool_call']);
    expect(state.messages[0]?.content[1]).toMatchObject({ operationId: 'send-call', data: { operation: 'send', request: 'Check config', response: 'All present' } });
    expect(state.messages[0]?.content[2]).toMatchObject({ text: 'after' });
    expect(state.messages[0]?.content[3]).toMatchObject({ toolName: 'read' });
    state = applySubagentContentEvent(state, end);
    expect(state.messages[0]?.content[1]).toMatchObject({ subagentState: 'complete', data: { operation: 'send', request: 'Check config', response: 'All present' } });
    expect(state.active).toEqual([]);
  });

  it('restores an active operation from a reconnect snapshot and continues its response', () => {
    const active = {
      parentMessageId: 'assistant-entry',
      contentIndex: 1,
      operationId: 'send-call',
      kind: 'send',
      data: { operation: 'send', to: ['worker'], request: 'Check config', response: '', phase: 'waiting' },
    } as const;
    const snapshot: PimoteAgentMessage = {
      ...assistant,
      content: [
        assistant.content[0],
        { type: 'subagent', operationId: 'send-call', subagentKind: 'send', subagentState: 'active', data: active.data },
        ...assistant.content.slice(1),
      ],
    };
    const state = applySubagentContentEvent(hydrateSubagentContent([snapshot], [active]), response);
    expect(state.messages[0]?.content[1]).toMatchObject({ data: { operation: 'send', request: 'Check config', response: 'All present' } });
    expect(state.active).toHaveLength(1);
  });

  it('keeps a visible protocol error in the replacement slot', () => {
    const state = applySubagentContentEvent(hydrateSubagentContent([assistant]), start);
    const error: SubagentContentEndEvent = {
      ...end,
      state: 'protocol_error',
      content: {
        type: 'subagent',
        operationId: 'send-call',
        subagentKind: 'send',
        subagentState: 'protocol_error',
        data: { operation: 'protocol_error', message: 'Missing subagent lifecycle' },
      },
    };
    const completed = applySubagentContentEvent(state, error);
    expect(completed.messages[0]?.content[1]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error', data: { message: 'Missing subagent lifecycle' } });
    expect(completed.active).toEqual([]);
  });
});
