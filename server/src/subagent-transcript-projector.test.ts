import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, PimoteSessionEvent } from '../../shared/dist/index.js';
import { createSubagentTranscriptProjector, type SubagentTranscriptProjector } from './subagent-transcript-projector.js';
import type { IncomingSdkEvent } from './event-buffer.js';

const manifest = Object.freeze({
  hiddenToolNames: Object.freeze(['send', 'respond', 'subagent']),
  hiddenCustomTypes: Object.freeze(['subagents']),
});

function projector(): SubagentTranscriptProjector {
  return createSubagentTranscriptProjector({ sessionId: 'root-session', manifest });
}

function assistant(content: PimoteAgentMessage['content'], entryId = 'assistant-entry'): PimoteAgentMessage {
  return { role: 'assistant', entryId, content };
}

function native(event: Record<string, unknown>): IncomingSdkEvent {
  return event as IncomingSdkEvent;
}

function providerEvent(event: Record<string, unknown>) {
  return event as never;
}

describe('SubagentTranscriptProjector', () => {
  it('keeps native text, a subagent replacement, later text, and unrelated tools in true content order', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: { to: 'worker' } },
        { type: 'text', text: 'after' },
        { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
      ]),
    ]);

    current.acceptProviderEvent(
      providerEvent({
        type: 'subagent_start',
        eventId: 'send-start',
        cursor: { epoch: 'epoch-1', sequence: 1 },
        target: { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 1 } },
        data: { operation: 'send', body: 'Inspect the config.' },
      }),
    );

    const snapshot = current.snapshot();
    expect(snapshot.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text', 'tool_call']);
    expect(snapshot.messages[0]?.content[1]).toMatchObject({
      type: 'subagent',
      operationId: 'send-call',
      subagentKind: 'send',
      placement: { toolCallId: 'send-call', contentIndex: 1 },
    });
    expect(snapshot.messages[0]?.content[1]).not.toMatchObject({ toolName: 'send' });
  });

  it('suppresses declared custom renderers before they cross the client wire', () => {
    const current = projector();
    current.rehydrate([
      {
        role: 'custom',
        customType: 'subagents',
        entryId: 'hidden-custom',
        content: [{ type: 'text', text: 'native fallback' }],
      },
      {
        role: 'custom',
        customType: 'note',
        entryId: 'visible-custom',
        content: [{ type: 'text', text: 'keep me' }],
      },
    ]);

    expect(current.snapshot().messages.map((message) => message.entryId)).toEqual(['visible-custom']);
  });

  it('updates one stable projected block in place and preserves typed delta order', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'text', text: 'before' }])]);

    const start = current.acceptProviderEvent(
      providerEvent({
        type: 'subagent_start',
        eventId: 'send-start',
        cursor: { epoch: 'epoch-1', sequence: 1 },
        target: { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 1 } },
        data: { operation: 'send', body: '' },
      }),
    );
    const delta = current.acceptProviderEvent(
      providerEvent({
        type: 'subagent_delta',
        eventId: 'send-delta',
        cursor: { epoch: 'epoch-1', sequence: 2 },
        target: { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 1 } },
        data: { operation: 'send', delta: 'partial body' },
      }),
    );

    expect(start).toContainEqual(expect.objectContaining({ type: 'subagent_content_start', contentIndex: 1 }));
    expect(delta).toContainEqual(expect.objectContaining({ type: 'subagent_content_delta', contentIndex: 1, data: { operation: 'send', delta: 'partial body' } }));
    expect(current.snapshot().messages[0]?.content.filter((block) => block.type === 'subagent')).toHaveLength(1);
  });

  it('emits a complete final block for finite operations without artificial delta events', () => {
    const current = projector();
    const events = current.acceptProviderEvent(
      providerEvent({
        type: 'subagent_snapshot_event',
        eventId: 'teardown',
        cursor: { epoch: 'epoch-1', sequence: 1 },
        target: { operationId: 'teardown', kind: 'teardown', path: ['worker'] },
        state: 'complete',
        data: {
          operation: 'teardown',
          result: {
            status: 'removed',
            affectedAgents: [
              {
                path: ['worker'],
                sessionId: 'worker-session',
                incarnation: 'worker-incarnation',
                state: 'idle',
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                output: 'done',
              },
            ],
          },
        },
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['subagent_content_start', 'subagent_content_end']);
    expect(events.some((event) => event.type === 'subagent_content_delta')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'subagent_content_end', state: 'complete' });
  });

  it('restores one complete persisted payload and active operations in a snapshot', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        {
          type: 'subagent',
          operationId: 'send-call',
          subagentKind: 'send',
          subagentState: 'complete',
          placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' },
          data: { operation: 'completion', result: { state: 'idle', output: 'done' } },
        },
      ]),
    ]);

    const snapshot = current.snapshot();
    expect(snapshot.messages[0]?.content[0]).toMatchObject({ type: 'subagent', subagentState: 'complete', data: expect.any(Object) });
    expect(snapshot.activeOperations).toEqual([]);
  });

  it('creates an explicit protocol-error block when a declared native replacement reaches its terminal boundary without lifecycle events', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: {} }])]);

    const events = current.acceptNativeEvent(
      native({
        type: 'tool_execution_end',
        toolCallId: 'send-call',
        result: 'native result',
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_content_end',
        state: 'protocol_error',
        content: expect.objectContaining({ type: 'subagent', subagentState: 'protocol_error' }),
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_execution_end' }));
  });

  it('rehydrates before the first snapshot and stages provider events without changing native order', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'text', text: 'after' },
      ]),
    ]);
    const event = current.acceptProviderEvent(
      providerEvent({
        type: 'subagent_start',
        eventId: 'send-start',
        cursor: { epoch: 'epoch-1', sequence: 1 },
        target: { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 1 } },
        data: { operation: 'send', body: '' },
      }),
    );

    expect(event.every((item): item is PimoteSessionEvent => typeof item === 'object' && item !== null)).toBe(true);
    expect(current.snapshot().messages[0]?.content.map((block) => block.text ?? block.type)).toEqual(['before', 'subagent']);
  });
});
