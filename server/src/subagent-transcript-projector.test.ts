import { describe, expect, it } from 'vitest';
import type { SubagentProviderEvent } from '@pimote/sdk/subagents';
import type { PimoteAgentMessage } from '../../shared/dist/index.js';
import { createSubagentTranscriptProjector } from './subagent-transcript-projector.js';
import type { IncomingSdkEvent } from './event-buffer.js';

const manifest = { hiddenToolNames: ['send', 'teardown', 'await_agents'], hiddenCustomTypes: ['subagents'] };
const target = { operationId: 'send-call', kind: 'send', path: [], placement: { toolCallId: 'send-call', contentIndex: 1 } } as const;
const cursor = (sequence: number) => ({ epoch: 'epoch-1', sequence });
const assistant = (content: PimoteAgentMessage['content']): PimoteAgentMessage => ({ role: 'assistant', entryId: 'assistant-entry', content });
const start: SubagentProviderEvent = {
  type: 'subagent_start',
  eventId: 'start',
  cursor: cursor(1),
  target,
  data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: '', phase: 'sending' } },
};

function projector() {
  return createSubagentTranscriptProjector({ sessionId: 'root-session', manifest });
}

describe('subagent transcript projector', () => {
  it.each(['subagent', 'fork'] as const)('keeps a model %s spawn in the parent transcript on replay', (toolName) => {
    const makeProjector = () => createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: [toolName], hiddenCustomTypes: ['subagents'] } });
    const native = [assistant([{ type: 'tool_call', toolCallId: 'spawn-call', toolName, args: {} }])];
    const event = {
      type: 'subagent_snapshot_event',
      eventId: 'spawn',
      cursor: cursor(1),
      target: { operationId: 'spawn-call', kind: 'delegation', path: [], placement: { toolCallId: 'spawn-call', contentIndex: 0 } },
      state: 'complete',
      data: { operation: 'delegation', parameters: {}, result: { children: [{ path: ['worker'], task: 'inspect' }] } },
    } as const;
    const live = makeProjector();
    live.rehydrate(native);
    live.acceptProviderEvent(event);
    const restored = makeProjector();
    restored.rehydrate(native);
    restored.acceptProviderEvent(event);
    for (const current of [live, restored]) {
      expect(current.snapshot().messages[0]?.content).toContainEqual(expect.objectContaining({ subagentKind: 'delegation', data: event.data }));
    }
  });

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
    expect(content[1]).toMatchObject({ operationId: 'send-call', data: { operation: 'send', parameters: { message: 'Check' }, result: {} } });
    expect(content[2]).toMatchObject({ text: 'after' });
    expect(content[3]).toMatchObject({ toolName: 'read', toolCallId: 'read-call' });
    expect(JSON.stringify(current.snapshot())).not.toContain('secret native argument');
  });

  it('anchors an interrupting message to its hidden await tool placement', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'await-call', toolName: 'await_agents', args: {} },
      ]),
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'await-complete',
      cursor: cursor(1),
      target: { operationId: 'await-call', kind: 'await', path: [], placement: { toolCallId: 'await-call', contentIndex: 1 } },
      state: 'complete',
      data: { operation: 'await', parameters: {}, result: { statuses: [], interrupted: true } },
    });
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'await-message',
      cursor: cursor(2),
      target: { operationId: 'incoming-message', kind: 'message_received', path: [], placement: { toolCallId: 'await-call', contentIndex: 1 } },
      state: 'complete',
      data: { operation: 'send', result: { from: ['worker'], to: [], message: 'Please inspect the failure.' } },
    });

    const incoming = current.snapshot().messages[0]?.content.find((block) => block.type === 'subagent' && block.operationId === 'incoming-message');
    expect(incoming).toMatchObject({ placement: { toolCallId: 'await-call', contentIndex: 1 } });
  });

  it('projects an interrupting message attached to a hidden await result into the assistant row', () => {
    const current = projector();
    current.rehydrate([
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'await-call', toolName: 'await_agents', args: {} },
        { type: 'text', text: 'after' },
      ]),
      {
        role: 'toolResult',
        entryId: 'await-result-entry',
        content: [{ type: 'tool_result', toolCallId: 'await-call', toolName: 'await_agents', result: 'hidden' }],
      },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'await-message',
      cursor: cursor(1),
      target: { operationId: 'incoming-message', kind: 'send', path: [], placement: { entryId: 'await-result-entry' } },
      state: 'complete',
      data: { operation: 'send', parameters: { to: [], message: 'Please inspect the failure.' }, result: { response: '' } },
    });
    const messages = current.snapshot().messages;
    expect(messages[0]?.content.map((block) => block.type)).toEqual(['text', 'subagent', 'text']);
    expect(messages[0]?.content[1]).toMatchObject({ data: { operation: 'send', parameters: { message: 'Please inspect the failure.' }, result: {} } });
    expect(messages).not.toContainEqual(expect.objectContaining({ entryId: 'await-result-entry' }));
  });

  it.each([false, true])('keeps returned child results in one await block across completion and replay, interrupted=%s', (interrupted) => {
    const current = projector();
    const nativeMessages: PimoteAgentMessage[] = [
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_call', toolCallId: 'await-call', toolName: 'await_agents', args: { agents: ['worker'] } },
        { type: 'text', text: 'after' },
      ]),
    ];
    current.rehydrate(nativeMessages);
    const awaitTarget = { operationId: 'await-call', kind: 'await', path: [], placement: { toolCallId: 'await-call', contentIndex: 1 } } as const;
    current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'await-start',
      cursor: cursor(1),
      target: awaitTarget,
      data: { operation: 'await', parameters: { agents: [['worker']] }, result: { statuses: [] } },
    });
    const statuses = interrupted
      ? ([
          { path: ['worker'], state: 'running' },
          { path: ['scout'], state: 'errored', output: 'Partial findings.', error: 'Connection lost.' },
        ] as const)
      : ([{ path: ['worker'], state: 'idle', output: 'Work completed.' }] as const);
    const data = { operation: 'await', result: { statuses, ...(interrupted ? { interrupted: true } : {}) }, parameters: {} } as const;
    current.acceptProviderEvent({ type: 'subagent_end', eventId: 'await-end', cursor: cursor(2), target: awaitTarget, state: 'complete', data });
    const saved = { type: 'subagent_snapshot_event', eventId: 'await-saved', cursor: cursor(3), target: awaitTarget, state: 'complete', data } as const;
    current.acceptProviderEvent(saved);
    const restored = projector();
    restored.rehydrate(nativeMessages);
    restored.acceptProviderEvent(saved);

    for (const snapshot of [current.snapshot(), restored.snapshot()]) {
      const content = snapshot.messages[0]?.content ?? [];
      expect(content.filter((block) => block.type === 'subagent')).toEqual([expect.objectContaining({ operationId: 'await-call', subagentKind: 'await', data })]);
      expect(content[0]).toMatchObject({ text: 'before' });
      expect(content.at(-1)).toMatchObject({ text: 'after' });
    }
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: 'Done' } },
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Incoming task' }, result: { response: 'Done' } },
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
              data: { operation: 'send', parameters: { to: ['worker'], message: 'Now' }, result: { response: 'Done' } },
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    afterNative.acceptProviderEvent({
      ...event,
      eventId: 'custom-after-native',
      target: { operationId: 'custom-after-native', kind: 'send', path: [] },
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Now' }, result: { response: 'Done' } },
    });
    expect(afterNative.snapshot().messages[0]).toMatchObject({ role: 'custom', content: [expect.objectContaining({ operationId: 'custom-after-native' })] });
  });

  it('stages placement-less active snapshots until their custom row arrives', () => {
    const current = projector();
    current.hydrateActiveOperations?.([
      {
        target: { operationId: 'active-custom', kind: 'send', path: [] },
        data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: '', phase: 'sending' } },
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
              data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } },
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    expect(current.snapshot().messages[0]).toMatchObject({ role: 'custom', content: [expect.objectContaining({ operationId: 'active-custom', subagentState: 'active' })] });
  });

  it.each(['message_received', 'send'] as const)('projects %s incoming entries after rehydration', (persistedKind) => {
    const current = projector();
    const data = { operation: 'send', result: { from: ['worker'], to: [], message: 'Report', responseExpected: false } } as const;
    current.rehydrate([
      {
        role: 'custom',
        customType: 'subagents',
        entryId: 'incoming-entry',
        content: [],
        details: {
          subagentContent: [{ operationId: 'received', kind: persistedKind, source: 'custom_entry', state: 'complete', data }],
        },
      },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'received',
      cursor: cursor(1),
      target: { operationId: 'received', kind: persistedKind, path: [], placement: { entryId: 'incoming-entry' } },
      state: 'complete',
      data,
    });
    expect(current.snapshot().messages).toEqual([
      expect.objectContaining({
        entryId: 'incoming-entry',
        content: [expect.objectContaining({ subagentKind: 'message_received', data })],
      }),
    ]);
  });

  it.each([
    { operation: 'send', result: { to: ['worker'], message: 'Task' } },
    { operation: 'send', parameters: { to: ['worker'] }, result: { from: ['worker'], message: 'Task' } },
  ] as const)('keeps ambiguous historical custom sends as outgoing sends', (data) => {
    const current = projector();
    current.rehydrate([
      {
        role: 'custom',
        customType: 'subagents',
        entryId: 'send-entry',
        content: [],
        details: {
          subagentContent: [{ operationId: 'send', kind: 'send', source: 'custom_entry', state: 'complete', data }],
        },
      },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'send',
      cursor: cursor(1),
      target: { operationId: 'send', kind: 'send', path: [], placement: { entryId: 'send-entry' } },
      state: 'complete',
      data,
    });
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ subagentKind: 'send' });
  });

  it('rehydrates a received message saved with a hidden await result', () => {
    const current = projector();
    const data = { operation: 'send', result: { from: [], to: ['worker'], message: 'Continue', responseExpected: false } } as const;
    current.rehydrate([
      assistant([{ type: 'tool_call', toolCallId: 'await-call', toolName: 'await_agents' }]),
      {
        role: 'toolResult',
        entryId: 'await-result',
        content: [{ type: 'tool_result', toolCallId: 'await-call', toolName: 'await_agents' }],
        details: {
          subagentContent: [{ operationId: 'received', kind: 'send', source: 'custom_entry', state: 'complete', data }],
        },
      },
    ]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'received',
      cursor: cursor(1),
      target: { operationId: 'received', kind: 'send', path: ['worker'], placement: { entryId: 'await-result' } },
      state: 'complete',
      data,
    });
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ subagentKind: 'message_received', data });
  });

  it('accepts live incoming custom entries without a protocol error', () => {
    const current = projector();
    const data = { operation: 'send', result: { from: ['worker'], to: [], message: 'Done', responseExpected: false } } as const;
    const nativeEvents = current.acceptNativeEvent({
      type: 'entry_appended',
      entry: {
        type: 'custom',
        id: 'incoming',
        customType: 'subagents',
        data: {
          subagentContent: [{ operationId: 'incoming', kind: 'message_received', source: 'custom_entry', state: 'complete', data }],
        },
      },
    } as unknown as IncomingSdkEvent);
    expect(nativeEvents).toEqual([]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'incoming',
      cursor: cursor(1),
      target: { operationId: 'incoming', kind: 'message_received', path: [], placement: { entryId: 'incoming' } },
      state: 'complete',
      data,
    });
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ subagentKind: 'message_received', subagentState: 'complete', data });
  });

  it('keeps native custom entries failing the visibility predicate out of the projection', () => {
    const current = createSubagentTranscriptProjector({
      sessionId: 'root-session',
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      customEntryVisible: (customType) => customType !== 'session-idle',
    });
    current.acceptNativeEvent({
      type: 'entry_appended',
      entry: { id: 'idle-1', type: 'custom', customType: 'session-idle', data: { at: '2026-04-05T01:11:44.135Z' } },
    } as unknown as IncomingSdkEvent);
    expect(current.snapshot().messages).toEqual([]);
  });

  it('renders native custom entries that pass the visibility predicate', () => {
    const current = createSubagentTranscriptProjector({
      sessionId: 'root-session',
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      customEntryVisible: () => true,
    });
    current.acceptNativeEvent({
      type: 'entry_appended',
      entry: { id: 'note-1', type: 'custom', customType: 'extension-note', data: { text: 'note body' } },
    } as unknown as IncomingSdkEvent);
    expect(current.snapshot().messages).toEqual([expect.objectContaining({ role: 'custom', customType: 'extension-note', entryId: 'note-1' })]);
  });

  it('replaces a hidden custom entry with its provider content', () => {
    const current = projector();
    current.rehydrate([{ role: 'custom', customType: 'subagents', entryId: 'incoming-entry', content: [{ type: 'text', text: '<agent_message>hidden</agent_message>' }] }]);
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'incoming-send',
      cursor: cursor(1),
      target: { operationId: 'incoming-send', kind: 'send', path: ['worker'], placement: { entryId: 'incoming-entry' } },
      state: 'complete',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Incoming task' }, result: { response: '' } },
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
    expect(snapshot.messages[0]?.content[1]).toMatchObject({ data: { operation: 'send', parameters: { message: 'Check config' }, result: { response: 'All present' } } });
    expect(snapshot.activeOperations).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ operationId: 'send-call' }),
        data: expect.objectContaining({ parameters: expect.objectContaining({ message: 'Check config' }), result: expect.objectContaining({ response: 'All present' }) }),
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
      parameters: {},
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

  it('places a streamed spawn after preceding thinking content', () => {
    const current = createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: ['subagent'], hiddenCustomTypes: [] } });
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as unknown as IncomingSdkEvent);
    current.acceptNativeEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"agents":[{"id":"worker","task":"inspect"}]}',
        partial: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Reasoning first.' },
            { type: 'toolCall', id: 'spawn-call', name: 'subagent', arguments: { agents: [{ id: 'worker', task: 'inspect' }] } },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    const [start] = current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'streamed-spawn',
      cursor: cursor(1),
      target: { operationId: 'spawn-call', kind: 'delegation', path: [], placement: { toolCallId: 'spawn-call', contentIndex: 1 } },
      data: { operation: 'delegation', parameters: {}, result: { children: [{ path: ['worker'], task: 'inspect' }] } },
    });

    expect(start).toMatchObject({ type: 'subagent_content_start', contentIndex: 1 });
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'live' }, result: { response: '', phase: 'sending' } },
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
        data: { operation: 'send', parameters: { to: ['worker'], message: operationId }, result: { response: '' } },
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } },
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } },
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

  it('emits no message_end for a hidden custom entry whose semantic payload is pending elsewhere', () => {
    const current = projector();
    current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'settled-send',
      cursor: cursor(1),
      target: { operationId: 'settled-op', kind: 'send', path: [], placement: { toolCallId: 'settled-call', contentIndex: 0 } },
      state: 'complete',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: 'Done' } },
    });
    const events = current.acceptNativeEvent({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagents',
        entryId: 'pending-entry',
        content: [],
        details: {
          subagentContent: [
            {
              operationId: 'settled-op',
              kind: 'send',
              state: 'complete',
              source: 'custom_entry',
              data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: 'Done' } },
            },
          ],
        },
      },
    } as unknown as IncomingSdkEvent);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ content: [] }) }));
    expect(current.snapshot().messages).not.toContainEqual(expect.objectContaining({ entryId: 'pending-entry' }));
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
      data: { operation: 'send', parameters: { to: ['worker'], message: 'hidden' }, result: { response: '', phase: 'sending' } },
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

  it.each(['subagent', 'fork'] as const)('commits a %s spawn row before its delegation card arrives', (toolName) => {
    // Real live ordering: the assistant message ends before the tool executes, so
    // the provider snapshot only arrives after message_end was processed. The
    // client holds the row as its streaming placeholder until it receives the
    // commit; the next message_start would otherwise wipe it, losing the spawn
    // entry together with the surrounding thinking and text.
    const current = createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: [toolName], hiddenCustomTypes: ['subagents'] } });
    const nativeContent = [
      { type: 'thinking', thinking: 'x' },
      { type: 'text', text: 'Spawning.' },
      { type: 'toolCall', id: 'spawn-call', name: toolName, arguments: {} },
    ];
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as IncomingSdkEvent);
    current.acceptNativeEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, partial: { role: 'assistant', content: nativeContent } },
    } as IncomingSdkEvent);

    const endEvents = current.acceptNativeEvent({ type: 'message_end', message: { role: 'assistant', content: nativeContent } } as IncomingSdkEvent);
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toMatchObject({ type: 'message_end' });
    expect((endEvents[0] as { message: PimoteAgentMessage }).message.content.map((block) => block.type)).toEqual(['thinking', 'text']);

    const card: SubagentProviderEvent = {
      type: 'subagent_snapshot_event',
      eventId: 'card-spawn',
      cursor: cursor(1),
      target: { operationId: 'spawn-call', kind: 'delegation', path: [], placement: { toolCallId: 'spawn-call', contentIndex: 2 } },
      state: 'complete',
      data: {
        operation: 'delegation',
        parameters: { agents: [{ id: 'worker', task: 'inspect' }] },
        result: { children: [{ path: ['worker'], task: 'inspect', status: 'running' }] },
      },
    } as unknown as SubagentProviderEvent;
    expect(current.acceptProviderEvent(card).map((event) => event.type)).toEqual(['subagent_content_start', 'subagent_content_end']);

    const rows = current.snapshot().messages.filter((message) => message.content.some((block) => block.type === 'text' && block.text === 'Spawning.'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.some((block) => block.type === 'subagent' && block.subagentKind === 'delegation')).toBe(true);
  });

  it('streams delegation task updates into one spawn block and keeps the operation path', () => {
    const current = createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: ['subagent'], hiddenCustomTypes: [] } });
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as IncomingSdkEvent);
    const target = { operationId: 'spawn-call', kind: 'delegation' as const, path: ['owner'], placement: { toolCallId: 'spawn-call', contentIndex: 0 } };
    const start = current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'spawn-start',
      cursor: cursor(1),
      target,
      data: { operation: 'delegation', parameters: {}, result: { children: [{ path: ['owner', 'watcher'], task: 'Tail the log' }] } },
    });
    expect(start.map((event) => event.type)).toEqual(['subagent_content_start']);
    expect(start[0]).toMatchObject({ content: { subagentPath: ['owner'], data: { result: { children: [{ task: 'Tail the log' }] } } } });

    const delta = current.acceptProviderEvent({
      type: 'subagent_delta',
      eventId: 'spawn-delta',
      cursor: cursor(2),
      target,
      data: {
        operation: 'delegation',
        children: [
          { path: ['owner', 'watcher'], task: 'Tail the log and ping me' },
          { path: ['owner', 'tracer'], task: 'Check ws ordering' },
        ],
      },
    });
    expect(delta.map((event) => event.type)).toEqual(['subagent_content_delta']);
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({
      type: 'subagent',
      subagentPath: ['owner'],
      data: { result: { children: [{ task: 'Tail the log and ping me' }, { task: 'Check ws ordering' }] } },
    });

    const completed = current.acceptProviderEvent({
      type: 'subagent_snapshot_event',
      eventId: 'spawn-final',
      cursor: cursor(3),
      target,
      state: 'complete',
      data: {
        operation: 'delegation',
        parameters: { agents: [] },
        result: {
          children: [
            { path: ['owner', 'watcher'], task: 'Tail the log and ping me' },
            { path: ['owner', 'tracer'], task: 'Check ws ordering' },
          ],
        },
      },
    });
    expect(completed.map((event) => event.type)).toEqual(['subagent_content_end']);
    expect(completed[0]).toMatchObject({ content: { subagentState: 'complete', subagentPath: ['owner'] } });
  });

  it('attaches native tool duration to the projected subagent result without persisting it in tool data', () => {
    const current = createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] } });
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as IncomingSdkEvent);
    current.acceptNativeEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { role: 'assistant', content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: {} }] },
      },
    } as IncomingSdkEvent);
    const target = { operationId: 'send-call', kind: 'send' as const, path: [], placement: { toolCallId: 'send-call', contentIndex: 0 } };
    current.acceptProviderEvent({
      type: 'subagent_start',
      eventId: 'send-start',
      cursor: cursor(1),
      target,
      data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: '', phase: 'sending' } },
    });
    current.acceptProviderEvent({
      type: 'subagent_end',
      eventId: 'send-end',
      cursor: cursor(2),
      target,
      state: 'complete',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } },
    });

    const timing = current.acceptNativeEvent({ type: 'tool_execution_end', toolCallId: 'send-call', durationMs: 725 } as IncomingSdkEvent);
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({ type: 'subagent_content_end', content: { durationMs: 725 } });
    expect(current.snapshot().messages[0]?.content[0]).toMatchObject({ type: 'subagent', durationMs: 725 });
  });

  it('still drops fully hidden assistant rows without visible content', () => {
    const current = createSubagentTranscriptProjector({ sessionId: 'root-session', manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] } });
    current.acceptNativeEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as IncomingSdkEvent);
    const events = current.acceptNativeEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: { to: 'worker', message: 'secret' } }] },
    } as IncomingSdkEvent);
    expect(events).toEqual([]);
  });
});
