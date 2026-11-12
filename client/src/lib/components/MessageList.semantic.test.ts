// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage, SubagentSemanticEvent } from '@pimote/shared';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: new Proxy(
    { status: 'disconnected', managerRoot: null, send: vi.fn(async () => ({ success: true, data: {} })) },
    { get: (target, property) => (property in target ? target[property as keyof typeof target] : vi.fn()) },
  ),
}));

const { default: MessageList } = await import('./MessageList.svelte');
let component: ReturnType<typeof mount> | undefined;

const assistant = (entryId: string, text: string): PimoteAgentMessage => ({ role: 'assistant', entryId, content: [{ type: 'text', text }] });
const thread = (eventId: string, toolCallId?: string): Extract<SubagentSemanticEvent, { kind: 'message_thread' }> => ({
  type: 'subagent_event',
  sessionId: 'root',
  cursor: 1,
  eventId,
  path: [],
  kind: 'message_thread',
  relatedPiEvents: toolCallId ? [{ sessionId: 'root', kind: 'tool_call', toolCallId }] : [{ sessionId: 'root', kind: 'custom_message' }],
  data: { phase: 'sent', from: [], to: ['worker'], text: `Body ${eventId}`, responseExpected: false },
});

async function render(messages: PimoteAgentMessage[], events: SubagentSemanticEvent[]) {
  sessionRegistry.addSession('root', '/workspace', 'workspace');
  sessionRegistry.switchTo('root');
  const session = sessionRegistry.viewed!;
  session.messages = messages;
  session.messageKeys = messages.map((message, index) => message.entryId ?? `message-${index}`);
  for (const event of events) sessionRegistry.handleEvent(event);
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(MessageList, { target });
  await tick();
  return { target, session };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  sessionRegistry.sessions = {};
  sessionRegistry.subagentRoots = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
});

describe('semantic transcript message boundaries', () => {
  it('renders a responder-owned blocking reply in the sender transcript', async () => {
    const pending = thread('request', 'send-call');
    const request = { ...pending, data: { ...pending.data, responseExpected: true, correlationId: 'question' } };
    const received: SubagentSemanticEvent = {
      ...thread('received'),
      relatedPiEvents: [{ sessionId: 'child', kind: 'custom_message', entryId: 'child-incoming' }],
      transcriptPosition: { sessionId: 'child', afterEntryId: 'child-before' },
      data: { phase: 'received', from: [], to: ['worker'], text: pending.data.text, responseExpected: true, correlationId: 'question' },
    };
    const response: SubagentSemanticEvent = {
      ...thread('reply'),
      sessionId: 'root',
      cursor: 2,
      relatedPiEvents: [{ sessionId: 'child', kind: 'tool_call', toolCallId: 'respond-call' }],
      transcriptPosition: { sessionId: 'child', afterEntryId: 'response-entry' },
      data: { phase: 'response', from: ['worker'], to: [], text: 'The child reply is visible.', responseExpected: false, correlationId: 'question' },
    };
    const call: PimoteAgentMessage = { role: 'assistant', entryId: 'send-entry', content: [{ type: 'tool_call', toolCallId: 'send-call', toolName: 'send' }] };
    const { target } = await render([call], [request]);
    sessionRegistry.handleEvent({
      type: 'message_end',
      sessionId: 'root',
      cursor: 3,
      message: {
        role: 'toolResult',
        entryId: 'sender-result',
        content: [{ type: 'tool_result', toolCallId: 'send-call', text: 'Native result.' }],
        details: { semantic: [request, received, response] },
      },
    });
    await tick();
    expect(target.textContent).toContain('The child reply is visible.');
    expect(target.querySelector('[aria-label="Message received"]')).toBeNull();
    expect(target.textContent?.match(/Body request/g)).toHaveLength(1);
    expect(target.textContent).not.toContain('Native result.');
    expect(target.querySelectorAll('.assistant-icon')).toHaveLength(1);
  });

  it('preserves two identical legacy custom deliveries around an assistant response', async () => {
    const fact = { ...thread('reused-legacy-id'), data: { phase: 'received' as const, from: ['worker'], to: [], text: 'Repeated delivery.', responseExpected: false } };
    const { target } = await render([], []);
    for (const [index, message] of [
      {
        role: 'custom' as const,
        entryId: 'first-delivery',
        customType: 'subagents',
        content: [{ type: 'text' as const, text: 'First native wrapper.' }],
        details: { semantic: [fact] },
      },
      assistant('between', 'Work continued.'),
      {
        role: 'custom' as const,
        entryId: 'second-delivery',
        customType: 'subagents',
        content: [{ type: 'text' as const, text: 'Second native wrapper.' }],
        details: { semantic: [fact] },
      },
    ].entries()) {
      sessionRegistry.handleEvent({ type: 'message_start', sessionId: 'root', cursor: index * 2 + 1, role: message.role });
      sessionRegistry.handleEvent({ type: 'message_end', sessionId: 'root', cursor: index * 2 + 2, message });
    }
    await tick();
    const rows = [...target.querySelectorAll('.transcript-row')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual([expect.stringContaining('Repeated delivery.'), 'Work continued.', expect.stringContaining('Repeated delivery.')]);
    expect(target.querySelectorAll('[data-semantic-kind="message_thread"]')).toHaveLength(2);
    expect(target.textContent).not.toMatch(/native wrapper/);
    expect(target.querySelectorAll('.assistant-icon')).toHaveLength(1);
    const text = sessionRegistry
      .getSubagentTranscript('root')
      .filter((item) => item.kind === 'semantic')
      .map((item) => item.block.transcriptText)
      .join('\n');
    expect(text.match(/Repeated delivery\./g)).toHaveLength(2);
  });

  it('keeps one bot icon for each assistant response containing semantic replacements', async () => {
    const calls: PimoteAgentMessage[] = ['first', 'second'].map((entryId) => ({
      role: 'assistant',
      entryId,
      content: [{ type: 'tool_call', toolCallId: entryId, toolName: 'send' }],
    }));
    const { target } = await render(calls, [thread('one', 'first'), { ...thread('two', 'second'), cursor: 2 }]);
    const rows = target.querySelectorAll('.assistant-message');
    expect(rows).toHaveLength(2);
    for (const [index, row] of [...rows].entries()) {
      expect(row.querySelectorAll('.assistant-icon')).toHaveLength(1);
      expect(row.textContent).toContain(index === 0 ? 'Body one' : 'Body two');
      expect(row.querySelector('.tool-block')).toBeNull();
    }
  });

  it('keeps an insertion between native messages when the transcript grows', async () => {
    const event = { ...thread('positioned'), transcriptPosition: { sessionId: 'root', afterEntryId: 'first', messageIndex: 1 } };
    const { target, session } = await render([assistant('first', 'Before'), assistant('second', 'After')], [event]);
    const inOrder = () => [...target.querySelectorAll('.transcript-row')].map((row) => row.textContent?.trim());
    expect(inOrder()).toEqual(['Before', expect.stringContaining('Body positioned'), 'After']);
    session.messages.push(assistant('third', 'Much later'));
    session.messageKeys.push('third');
    flushSync();
    expect(inOrder()).toEqual(['Before', expect.stringContaining('Body positioned'), 'After', 'Much later']);
  });

  it('uses an exact custom-message anchor instead of an earlier provisional insertion slot', async () => {
    const event = { ...thread('incoming'), transcriptPosition: { sessionId: 'root', afterEntryId: 'first', messageIndex: 1 } };
    const notice: PimoteAgentMessage = {
      role: 'custom',
      entryId: 'notice',
      customType: 'subagents',
      content: [{ type: 'text', text: 'Native notification' }],
      details: { semanticEvents: [event] },
    };
    const { target } = await render([assistant('first', 'Before'), assistant('second', 'Continued'), notice, assistant('third', 'After')], [event]);
    const rows = [...target.querySelectorAll('.transcript-row')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['Before', 'Continued', expect.stringContaining('Body incoming'), 'After']);
    expect(target.textContent).not.toContain('Native notification');
    expect(target.querySelectorAll('[data-semantic-kind="message_thread"]')).toHaveLength(1);
  });

  it('uses lifecycle tool provenance without replacing unrelated text and tools', async () => {
    const call: PimoteAgentMessage = {
      role: 'assistant',
      entryId: 'tools',
      content: [
        { type: 'text', text: 'Stopping the worker.' },
        { type: 'tool_call', toolCallId: 'stop', toolName: 'interrupt' },
        { type: 'tool_call', toolCallId: 'read', toolName: 'read', text: '{}' },
      ],
    };
    const event: SubagentSemanticEvent = {
      type: 'subagent_event',
      sessionId: 'root',
      eventId: 'stop-worker',
      cursor: 1,
      path: ['worker'],
      kind: 'interrupt',
      relatedPiEvents: [{ sessionId: 'root', toolCallId: 'stop', kind: 'lifecycle' }],
      data: { path: ['worker'], outcome: 'succeeded' },
    };
    const { target } = await render([call], [event]);
    expect(target.textContent).toContain('Stopping the worker.');
    expect(target.querySelector('[data-semantic-kind="lifecycle"]')).not.toBeNull();
    expect(target.querySelectorAll('.tool-block')).toHaveLength(1);
    expect(target.querySelector('.tool-block')?.textContent).toContain('read');
    expect(target.querySelectorAll('.assistant-icon')).toHaveLength(1);
  });

  it('does not leak another surface or an abandoned native anchor into the current transcript', async () => {
    const other = {
      ...thread('child'),
      relatedPiEvents: [{ sessionId: 'child', kind: 'custom_message' as const }],
      transcriptPosition: { sessionId: 'child', afterEntryId: 'first', messageIndex: 1 },
    };
    const abandoned = { ...thread('abandoned', 'missing'), transcriptPosition: { sessionId: 'root', afterEntryId: 'gone', messageIndex: 1 } };
    const { target } = await render([assistant('first', 'Current branch')], [other, { ...abandoned, cursor: 2 }]);
    expect(target.querySelector('[data-semantic-kind]')).toBeNull();
    expect(target.textContent).toContain('Current branch');
  });
});
