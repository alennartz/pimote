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

  it('projects persisted tool payloads into the originating assistant row', () => {
    const current = projector();
    current.rehydrate([
      assistant(
        [
          { type: 'text', text: 'before' },
          { type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: { message: 'hidden request' } },
          { type: 'text', text: 'after' },
        ],
        'assistant-entry',
      ),
      {
        role: 'toolResult',
        entryId: 'result-entry',
        content: [{ type: 'tool_result', toolCallId: 'send-call', toolName: 'send', result: 'hidden result' }],
      },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'persisted-send',
      cursor: cursor(1),
      target: { operationId: 'send-call', kind: 'send', path: [], placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'result-entry' } },
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'Check', response: 'Done' },
    });

    const snapshot = current.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({ role: 'assistant', entryId: 'assistant-entry' });
    expect(snapshot.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text']);
    expect(snapshot.messages[0]?.content[1]).toMatchObject({ operationId: 'send-call', subagentState: 'complete' });
  });

  it('stages source-less custom provider events until the hidden message_end row arrives', () => {
    const current = projector();
    const event = {
      type: 'subagent_snapshot_event',
      eventId: 'custom-before-native',
      cursor: cursor(1),
      target: { operationId: 'custom-send', kind: 'send', path: [] },
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'Incoming task', response: 'Done' },
    } as const;
    expect(current.acceptProviderEvent(event)).toEqual([]);
    const nativeEvents = current.acceptNativeEvent({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagents',
        content: [],
        details: {
          subagentContent: [
            {
              operationId: 'custom-send',
              kind: 'send',
              state: 'complete',
              source: 'custom_entry',
              data: event.data,
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    expect(nativeEvents).toContainEqual(expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ role: 'custom' }) }));
    expect(nativeEvents).toContainEqual(expect.objectContaining({ type: 'subagent_content_start', operationId: 'custom-send' }));
    expect(current.snapshot().messages[0]).toMatchObject({ role: 'custom', content: [expect.objectContaining({ operationId: 'custom-send', subagentState: 'complete' })] });

    const afterNative = projector();
    afterNative.acceptNativeEvent({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagents',
        content: [],
        details: {
          subagentContent: [
            {
              operationId: 'custom-after-native',
              kind: 'send',
              state: 'complete',
              source: 'custom_entry',
              data: { operation: 'send', to: ['worker'], request: 'Now', response: 'Done' },
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    afterNative.acceptProviderEvent({
      ...event,
      eventId: 'custom-after-native',
      target: { operationId: 'custom-after-native', kind: 'send', path: [] },
      data: { operation: 'send', to: ['worker'], request: 'Now', response: 'Done' },
    });
    expect(afterNative.snapshot().messages[0]).toMatchObject({ role: 'custom', content: [expect.objectContaining({ operationId: 'custom-after-native' })] });
  });

  it('stages placement-less active snapshots until their custom row arrives', () => {
    const current = projector();
    current.hydrateActiveOperations?.([
      {
        target: { operationId: 'active-custom', kind: 'send', path: [] },
        data: { operation: 'send', to: ['worker'], request: 'check', response: '', phase: 'sending' },
      },
    ]);
    expect(current.snapshot().messages).toEqual([]);
    current.acceptNativeEvent({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagents',
        content: [],
        details: {
          subagentContent: [
            {
              operationId: 'active-custom',
              kind: 'send',
              state: 'complete',
              source: 'custom_entry',
              data: { operation: 'send', to: ['worker'], request: 'check', response: 'done' },
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    expect(current.snapshot().messages[0]).toMatchObject({ role: 'custom', content: [expect.objectContaining({ operationId: 'active-custom', subagentState: 'active' })] });
  });

  it('replaces an incoming hidden custom entry with typed send content', () => {
    const current = projector();
    current.rehydrate([{ role: 'custom', customType: 'subagents', entryId: 'incoming-entry', content: [{ type: 'text', text: '<agent_message>hidden</agent_message>' }] }]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'incoming-send',
      cursor: cursor(1),
      target: { operationId: 'incoming-send', kind: 'send', path: ['worker'], placement: { entryId: 'incoming-entry' } },
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'Incoming task', response: '' },
    });

    const messages = current.snapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'custom', customType: 'subagents', entryId: 'incoming-entry' });
    expect(messages[0]?.content).toEqual([expect.objectContaining({ type: 'subagent', operationId: 'incoming-send', subagentKind: 'send' })]);
    expect(JSON.stringify(messages)).not.toContain('hidden');
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

  it('anchors a live replacement to its streaming assistant occurrence', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'text', text: 'earlier turn' }], 'earlier-entry')]);
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as unknown as IncomingSdkEvent);
    current.acceptNativeEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { role: 'assistant', content: [{ type: 'toolCall', id: 'live-call', name: 'send', arguments: {} }] },
      },
    } as unknown as IncomingSdkEvent);
    current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'live-start',
      cursor: cursor(1),
      target: { operationId: 'live-call', kind: 'send', path: [], placement: { toolCallId: 'live-call', contentIndex: 0 } },
      data: { operation: 'send', to: ['worker'], request: 'live', response: '', phase: 'sending' },
    });
    expect(current.snapshot().messages).toHaveLength(2);
    expect(current.snapshot().messages[1]?.content[0]).toMatchObject({ type: 'subagent', operationId: 'live-call' });
  });

  it('keeps multiple replacements in the original assistant content order', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'a' },
        { type: 'tool_call', toolCallId: 'first-call', toolName: 'send', args: {} },
        { type: 'text', text: 'b' },
        { type: 'tool_call', toolCallId: 'second-call', toolName: 'send', args: {} },
        { type: 'text', text: 'c' },
      ]),
    ]);
    for (const [operationId, toolCallId, sequence] of [
      ['first', 'first-call', 1],
      ['second', 'second-call', 2],
    ] as const) {
      current.acceptProviderEvent({
        type: 'subagent_snapshot_event',
        eventId: operationId,
        cursor: cursor(sequence),
        target: { operationId, kind: 'send', path: [], placement: { toolCallId, contentIndex: toolCallId === 'first-call' ? 1 : 3 } },
        state: 'complete',
        data: { operation: 'send', to: ['worker'], request: operationId, response: '' },
      });
    }
    expect(current.snapshot().messages[0]?.content.map((block) => (block.type === 'subagent' ? block.operationId : block.type === 'text' ? block.text : block.type))).toEqual([
      'a',
      'first',
      'b',
      'second',
      'c',
    ]);
  });

  it('retains completed and active projected blocks across native rehydration', () => {
    const current = projector();
    const native = [assistant([{ type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: {} }])];
    current.rehydrate(native);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'complete-send',
      cursor: cursor(1),
      target,
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'check', response: 'done' },
    });
    current.rehydrate(native);
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', operationId: 'send-call', subagentState: 'complete' });

    const active = projector();
    active.rehydrate(native);
    active.hydrateActiveOperations?.([{ target, data: start.data }]);
    active.rehydrate(native);
    expect(active.snapshot().activeOperations).toContainEqual(expect.objectContaining({ target: expect.objectContaining({ operationId: 'send-call' }) }));
  });

  it('seeds hidden IDs and slots from a mid-run streaming snapshot', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'text', text: 'prior' }])]);
    const projected = current.projectStreamingMessage?.({
      role: 'assistant',
      content: [
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'mid-run', toolName: 'send', args: { message: 'secret' } },
        { type: 'tool_result', toolCallId: 'mid-run', toolName: 'send', result: 'secret result' },
        { type: 'text', text: 'after' },
      ],
    });
    expect(projected?.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);

    current.acceptProviderEvent({
      ...start,
      eventId: 'mid-run-start',
      target: { operationId: 'mid-run', kind: 'send', path: [], placement: { toolCallId: 'mid-run', contentIndex: 1 } },
    });
    expect(current.snapshot().messages[1]?.content[0]).toMatchObject({ type: 'subagent', operationId: 'mid-run' });
  });

  it('restores completed and active projections on a fresh projector', () => {
    const source = projector();
    const native = [assistant([{ type: 'tool_call', toolCallId: 'send-call', toolName: 'send', args: {} }])];
    source.rehydrate(native);
    source.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'complete-send',
      cursor: cursor(1),
      target,
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'check', response: 'done' },
    });
    const saved = source.snapshot();
    const fresh = projector();
    fresh.rehydrate(native);
    fresh.restoreProjection?.(saved);
    expect(fresh.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', operationId: 'send-call', subagentState: 'complete' });

    const active = projector();
    active.rehydrate(native);
    active.acceptProviderEvent(start);
    const activeSaved = active.snapshot();
    const freshActive = projector();
    freshActive.rehydrate(native);
    freshActive.restoreProjection?.(activeSaved);
    expect(freshActive.snapshot().activeOperations).toContainEqual(expect.objectContaining({ target: expect.objectContaining({ operationId: 'send-call' }) }));
  });

  it('shows a protocol error for a hidden custom entry without a typed lifecycle', () => {
    const current = projector();
    const events = current.acceptNativeEvent({
      type: 'entry_appended',
      entry: { id: 'hidden-custom', type: 'custom', customType: 'subagents', data: { text: 'native fallback' } },
    } as unknown as IncomingSdkEvent);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_content_end', state: 'protocol_error' }));
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error' });

    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'custom-completion',
      cursor: cursor(1),
      target: { operationId: 'completion', kind: 'completion', path: [], placement: { entryId: 'hidden-custom' } },
      state: 'complete',
      data: { operation: 'completion', result: { state: 'idle', output: 'finished' } },
    });
    expect(current.snapshot().messages[0]?.content).toEqual([expect.objectContaining({ type: 'subagent', operationId: 'completion', subagentState: 'complete' })]);
  });

  it('reports malformed hidden custom payloads as protocol errors', () => {
    const current = projector();
    const events = current.acceptNativeEvent({
      type: 'entry_appended',
      entry: {
        id: 'malformed-custom',
        type: 'custom',
        customType: 'subagents',
        details: { subagentContent: [{ operationId: 'bad', kind: 'send' }, 'not-an-object'] },
      },
    } as unknown as IncomingSdkEvent);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_content_end', state: 'protocol_error' }));
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', subagentState: 'protocol_error' });
  });

  it('suppresses the native tool stream before transmission', () => {
    const current = projector();
    const events = current.acceptNativeEvent({ type: 'tool_execution_start', toolCallId: 'send-call', toolName: 'send', args: { message: 'hidden request' } } as IncomingSdkEvent);
    expect(JSON.stringify(events)).not.toContain('hidden request');
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_execution_start', toolCallId: 'send-call' }));
  });

  it('sanitizes message_end replacements instead of forwarding hidden native details', () => {
    const current = projector();
    current.rehydrate([assistant([{ type: 'text', text: 'saved' }], 'assistant-end')]);
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as unknown as IncomingSdkEvent);
    current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'hidden-start',
      cursor: cursor(1),
      target: { operationId: 'send-call', kind: 'send', path: [], placement: { toolCallId: 'send-call', contentIndex: 1 } },
      data: { operation: 'send', to: ['worker'], request: 'hidden', response: '', phase: 'sending' },
    });
    const events = current.acceptNativeEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        entryId: 'assistant-end',
        content: [
          { type: 'text', text: 'before' },
          { type: 'toolCall', id: 'send-call', name: 'send', arguments: { message: 'hidden message' } },
          { type: 'text', text: 'after' },
        ],
        details: { secret: 'hidden details' },
      },
    } as unknown as IncomingSdkEvent);
    expect(JSON.stringify(events)).not.toContain('hidden message');
    expect(JSON.stringify(events)).not.toContain('hidden details');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message_end',
        message: expect.objectContaining({
          content: expect.arrayContaining([
            { type: 'text', text: 'before' },
            expect.objectContaining({ type: 'subagent', operationId: 'send-call' }),
            { type: 'text', text: 'after' },
          ]),
        }),
      }),
    );
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
