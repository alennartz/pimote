import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, StreamingMessage, SubagentContentDeltaEvent, SubagentContentEndEvent, SubagentContentStartEvent } from '../../../shared/src/protocol.js';
import { applySubagentContentEvent, applySubagentContentToStreaming, hydrateSubagentContent } from './subagent-content.js';

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
    data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: '', phase: 'sending' } },
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
    data: { operation: 'send', parameters: { to: ['worker'], message: 'Check config' }, result: { response: 'All present' } },
  },
};

describe('projected subagent content', () => {
  it('keeps live projected content in one streaming row', () => {
    let streaming: StreamingMessage = { role: 'assistant', content: [{ type: 'text', text: 'before' }] };
    streaming = applySubagentContentToStreaming(streaming, start);
    streaming = applySubagentContentToStreaming(streaming, request);
    streaming = applySubagentContentToStreaming(streaming, end);
    expect(streaming.content).toHaveLength(2);
    expect(streaming.content[1]).toMatchObject({ type: 'subagent', operationId: 'send-call', subagentState: 'complete' });
  });

  it('keeps one block and surrounding content through request, response, and completion', () => {
    let state = hydrateSubagentContent([assistant]);
    for (const event of [start, request, response]) state = applySubagentContentEvent(state, event);
    expect(state.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text', 'tool_call']);
    expect(state.messages[0]?.content[1]).toMatchObject({
      operationId: 'send-call',
      data: { operation: 'send', parameters: { message: 'Check config' }, result: { response: 'All present' } },
    });
    expect(state.messages[0]?.content[2]).toMatchObject({ text: 'after' });
    expect(state.messages[0]?.content[3]).toMatchObject({ toolName: 'read' });
    state = applySubagentContentEvent(state, end);
    expect(state.messages[0]?.content[1]).toMatchObject({
      subagentState: 'complete',
      data: { operation: 'send', parameters: { message: 'Check config' }, result: { response: 'All present' } },
    });
    expect(state.active).toEqual([]);
  });

  it('restores an active operation from a reconnect snapshot and continues its response', () => {
    const active = {
      parentMessageId: 'assistant-entry',
      contentIndex: 1,
      operationId: 'send-call',
      kind: 'send',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check config' }, result: { response: '', phase: 'waiting' } },
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
    expect(state.messages[0]?.content[1]).toMatchObject({ data: { operation: 'send', parameters: { message: 'Check config' }, result: { response: 'All present' } } });
    expect(state.active).toHaveLength(1);
  });

  it('streams delegation tasks in the existing spawn block before replacing them with the final children', () => {
    const delegationTarget = { ...target, operationId: 'spawn-call', kind: 'delegation' as const };
    const delegationStart: SubagentContentStartEvent = {
      ...delegationTarget,
      type: 'subagent_content_start',
      cursor: 5,
      placement: { toolCallId: 'spawn-call', contentIndex: 1 },
      content: {
        type: 'subagent',
        operationId: 'spawn-call',
        subagentKind: 'delegation',
        subagentState: 'active',
        data: { operation: 'delegation', parameters: {}, result: { children: [{ path: ['owner', 'watcher'], task: 'Tail the log' }] } },
      },
    };
    const delegationDelta: SubagentContentDeltaEvent = {
      ...delegationTarget,
      type: 'subagent_content_delta',
      cursor: 6,
      data: {
        operation: 'delegation',
        children: [
          { path: ['owner', 'watcher'], task: 'Tail the log and ping me', persona: 'scout' },
          { path: ['owner', 'tracer'], task: 'Check ws ordering' },
        ],
      },
    };
    const delegationEnd: SubagentContentEndEvent = {
      ...delegationTarget,
      type: 'subagent_content_end',
      cursor: 7,
      state: 'complete',
      content: {
        type: 'subagent',
        operationId: 'spawn-call',
        subagentKind: 'delegation',
        subagentState: 'complete',
        data: {
          operation: 'delegation',
          parameters: { agents: [] },
          result: {
            children: [
              { path: ['owner', 'watcher'], task: 'Tail the log and ping me', persona: 'scout' },
              { path: ['owner', 'tracer'], task: 'Check ws ordering' },
            ],
          },
        },
      },
    };
    let state = applySubagentContentEvent(hydrateSubagentContent([assistant]), delegationStart);
    state = applySubagentContentEvent(state, delegationDelta);
    expect(state.messages[0]?.content[1]).toMatchObject({
      operationId: 'spawn-call',
      subagentState: 'active',
      data: {
        result: {
          children: [
            { path: ['owner', 'watcher'], task: 'Tail the log and ping me', persona: 'scout' },
            { path: ['owner', 'tracer'], task: 'Check ws ordering' },
          ],
        },
      },
    });
    state = applySubagentContentEvent(state, delegationEnd);
    expect(state.messages[0]?.content[1]).toMatchObject({ subagentState: 'complete', data: { operation: 'delegation' } });
    expect(state.active).toEqual([]);
  });

  it('updates a streamed spawn in its saved row when the synthetic parent index no longer matches', () => {
    const operationId = 'tree-spawn';
    const streamedMessage: PimoteAgentMessage = {
      role: 'assistant',
      entryId: 'saved-assistant',
      content: [
        { type: 'text', text: 'I will start the agents.' },
        {
          type: 'subagent',
          operationId,
          subagentKind: 'delegation',
          subagentState: 'active',
          data: { operation: 'delegation', parameters: { agents: [] }, result: { children: [{ path: ['tree'], task: '' }] } },
        },
      ],
    };
    const finished: SubagentContentEndEvent = {
      sessionId: 'root-session',
      parentMessageId: 'message-197',
      contentIndex: 1,
      operationId,
      kind: 'delegation',
      type: 'subagent_content_end',
      cursor: 8,
      state: 'complete',
      content: {
        type: 'subagent',
        operationId,
        subagentKind: 'delegation',
        subagentState: 'complete',
        data: {
          operation: 'delegation',
          parameters: { agents: [] },
          result: {
            children: [
              { path: ['tree-watcher'], task: 'Sleep.' },
              { path: ['tree-delegator'], task: 'Spawn a child.' },
            ],
          },
        },
      },
    };

    const state = applySubagentContentEvent(hydrateSubagentContent([streamedMessage]), finished);
    const cards = state.messages.flatMap((message) => message.content.filter((block) => block.type === 'subagent'));

    expect(state.messages).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      operationId,
      subagentState: 'complete',
      data: { operation: 'delegation', result: { children: [{ path: ['tree-watcher'] }, { path: ['tree-delegator'] }] } },
    });
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
        data: { operation: 'protocol_error', result: { error: 'Missing subagent lifecycle' } },
      },
    };
    const completed = applySubagentContentEvent(state, error);
    expect(completed.messages[0]?.content[1]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error', data: { result: { error: 'Missing subagent lifecycle' } } });
    expect(completed.active).toEqual([]);
  });
});
