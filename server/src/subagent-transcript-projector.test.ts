import { describe, expect, it } from 'vitest';
import type { SubagentProviderEvent } from '@pimote/sdk/subagents';
import type { PimoteAgentMessage } from '../../shared/dist/index.js';
import { createSubagentTranscriptProjector } from './subagent-transcript-projector.js';
import type { IncomingSdkEvent } from './event-buffer.js';

const manifest = { hiddenToolNames: ['send', 'teardown'], hiddenCustomTypes: ['subagents'] };
const target = { operationId: 'send-call', kind: 'send', path: [], placement: { toolCallId: 'send-call', contentIndex: 1 } } as const;
const cursor = (sequence: number) => ({ epoch: 'epoch-1', sequence });
const assistant = (content: PimoteAgentMessage['content']): PimoteAgentMessage => ({ role: 'assistant', entryId: 'assistant-entry', content });
const start: SubagentProviderEvent = {
  type: 'subagent_start',
  eventId: 'start',
  cursor: cursor(1),
  target,
  data: { operation: 'send', to: ['worker'], request: 'Check', response: '', phase: 'sending' },
};

function projector() {
  return createSubagentTranscriptProjector({ sessionId: 'root-session', manifest });
}

describe('subagent transcript projector', () => {
  it('preserves native content around a replacement and does not send hidden native content', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: { message: 'secret native argument' } },
        { type: 'text', text: 'after' },
        { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
      ]),
    ]);
    current.acceptProviderEvent(start);

    const content = current.snapshot().messages[0]!.content;
    expect(content.map((block) => block.type)).toEqual(['text', 'subagent', 'text', 'tool_call']);
    expect(content[0]).toMatchObject({ text: 'before' });
    expect(content[1]).toMatchObject({ operationId: 'send-call', data: { operation: 'send', request: 'Check' } });
    expect(content[2]).toMatchObject({ text: 'after' });
    expect(content[3]).toMatchObject({ toolName: 'read', toolCallId: 'read-call' });
    expect(JSON.stringify(current.snapshot())).not.toContain('secret native argument');
  });

  it('suppresses only declared custom entries and restores a replacement at the original entry position', () => {
    const current = projector();
    current.rehydrate([
      { role: 'custom', customType: 'subagents', entryId: 'hidden-custom', content: [{ type: 'text', text: 'hidden native content' }] },
      { role: 'custom', customType: 'note', entryId: 'visible-custom', content: [{ type: 'text', text: 'keep me' }] },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'completion',
      cursor: cursor(1),
      target: { operationId: 'completion', kind: 'completion', path: [], placement: { entryId: 'hidden-custom' } },
      state: 'complete',
      data: { operation: 'completion', result: { state: 'idle', output: 'finished' } },
    });

    const messages = current.snapshot().messages;
    expect(messages[0]?.content).toContainEqual(expect.objectContaining({ type: 'subagent', data: expect.objectContaining({ operation: 'completion' }) }));
    expect(messages[1]).toMatchObject({ entryId: 'visible-custom' });
    expect(JSON.stringify(messages)).not.toContain('hidden native content');
  });

  it('updates one stable slot and snapshots the accumulated active request and response', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'text', text: 'before' }])]);
    current.acceptProviderEvent(start);
    const request = current.acceptProviderEvent({
      type: 'subagent_delta',
      eventId: 'request',
      cursor: cursor(2),
      target,
      data: { operation: 'send', field: 'request', delta: ' config' },
    });
    const response = current.acceptProviderEvent({
      type: 'subagent_delta',
      eventId: 'response',
      cursor: cursor(3),
      target,
      data: { operation: 'send', field: 'response', delta: 'All present' },
    });

    expect(request).toContainEqual(expect.objectContaining({ type: 'subagent_content_delta', operationId: 'send-call' }));
    expect(response).toContainEqual(expect.objectContaining({ type: 'subagent_content_delta', operationId: 'send-call' }));
    const snapshot = current.snapshot();
    expect(snapshot.messages[0]?.content.filter((block) => block.type === 'subagent')).toHaveLength(1);
    expect(snapshot.messages[0]?.content[1]).toMatchObject({ data: { operation: 'send', request: 'Check config', response: 'All present' } });
    expect(snapshot.activeOperations).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ operationId: 'send-call' }),
        data: expect.objectContaining({ request: 'Check config', response: 'All present' }),
      }),
    );
  });

  it('projects a finite result without synthetic deltas', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'tool_call', toolCallId: 'teardown-call', toolName: 'teardown', args: {} }])]);
    const data = {
      operation: 'teardown',
      result: {
        status: 'removed',
        affectedAgents: [
          {
            path: ['worker'],
            sessionId: 'worker-session',
            incarnation: 'worker-incarnation',
            state: 'errored',
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            error: 'failed',
          },
        ],
      },
    } as const;
    const events = current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'teardown',
      cursor: cursor(1),
      target: { operationId: 'teardown-call', kind: 'teardown', path: [], placement: { toolCallId: 'teardown-call', contentIndex: 0 } },
      state: 'complete',
      data,
    });
    expect(events.some((event) => event.type === 'subagent_content_delta')).toBe(false);
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', subagentState: 'complete', data });
  });

  it('suppresses the native tool stream before transmission', () => {
    const current = projector();
    const events = current.acceptNativeEvent({ type: 'tool_execution_start', toolCallId: 'send-call', toolName: 'send', args: { message: 'hidden request' } } as IncomingSdkEvent);
    expect(JSON.stringify(events)).not.toContain('hidden request');
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_execution_start', toolCallId: 'send-call' }));
  });

  it('renders a protocol error when a hidden tool terminates without a lifecycle', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: { message: 'hidden' } }])]);
    const events = current.acceptNativeEvent({ type: 'tool_execution_end', toolCallId: 'send-call', result: 'hidden result' } as IncomingSdkEvent);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_content_end', state: 'protocol_error' }));
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error' });
    expect(JSON.stringify(events)).not.toContain('hidden result');
  });

  it('renders a protocol error if a started operation never ends', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: {} },
      ]),
    ]);
    current.acceptProviderEvent(start);
    current.acceptNativeEvent({ type: 'tool_execution_end', toolCallId: 'send-call', result: 'native result' } as IncomingSdkEvent);
    expect(current.snapshot().messages[0]?.content[1]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error' });
  });
});
