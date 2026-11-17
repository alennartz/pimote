import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, PimoteSessionEvent, SubagentContentEndEvent, SubagentContentStartEvent } from '@pimote/shared';
import { SessionRegistry } from './session-registry.svelte.js';

const sessionId = 'transcript';
const childSessionId = 'child-transcript';
const path = ['worker'];
const answer = 'The previous answer must remain readable.';
const prompt = 'The next question.';

function event(type: string, extra: Record<string, unknown> = {}): PimoteSessionEvent {
  return { type, sessionId, cursor: 0, ...extra } as PimoteSessionEvent;
}

function transcript(kind: 'root' | 'child') {
  const registry = new SessionRegistry();
  registry.addSession(sessionId, '/workspace', 'workspace');
  let viewCursor = 0;
  if (kind === 'child') {
    registry.handleEvent({
      type: 'subagent_view_snapshot',
      sessionId,
      childSessionId,
      path,
      incarnation: 'child-incarnation',
      viewCursor,
      state: {
        sessionId: childSessionId,
        sessionFile: undefined,
        model: null,
        thinkingLevel: 'off',
        availableThinkingLevels: [],
        isStreaming: false,
        isCompacting: false,
        autoCompactionEnabled: false,
        messageCount: 0,
      },
      messages: [],
    });
  }
  return {
    get surface() {
      return kind === 'root' ? registry.sessions[sessionId] : registry.getSubagentAttachment(sessionId, path)!;
    },
    dispatch(input: PimoteSessionEvent): void {
      if (kind === 'root') registry.handleEvent(input);
      else {
        registry.handleEvent({
          type: 'subagent_view_event',
          sessionId,
          childSessionId,
          path,
          incarnation: 'child-incarnation',
          viewCursor: ++viewCursor,
          event: input,
        });
      }
    },
    addPrompt(): void {
      if (kind === 'root') registry.addOptimisticUserMessage(sessionId, prompt, 'prompt-1');
      else registry.addSubagentOptimisticUserMessage(sessionId, path, prompt, 'prompt-1');
    },
  };
}

type Transcript = ReturnType<typeof transcript>;

function streamMessage(view: Transcript, message: PimoteAgentMessage): void {
  view.dispatch(event('message_start', { role: message.role }));
  view.dispatch(event('message_end', { message }));
}

function projection(parentMessageId: string): SubagentContentStartEvent {
  return {
    type: 'subagent_content_start',
    sessionId,
    cursor: 0,
    parentMessageId,
    contentIndex: 0,
    operationId: 'send-call',
    kind: 'send',
    placement: { toolCallId: 'send-call', contentIndex: 0 },
    content: {
      type: 'subagent',
      operationId: 'send-call',
      subagentKind: 'send',
      subagentState: 'active',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check the result.' }, result: { response: '', phase: 'sending' } },
    },
  };
}

function texts(view: Transcript): string[] {
  return view.surface.messages.flatMap((message) => message.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])));
}

function echo(view: Transcript): void {
  view.dispatch(event('message_start', { role: 'user', clientMessageId: 'prompt-1' }));
  view.dispatch(event('message_end', { message: { role: 'user', content: [{ type: 'text', text: prompt }] }, clientMessageId: 'prompt-1' }));
}

describe.each(['root', 'child'] as const)('%s transcript preservation during subagent projection', (kind) => {
  it('keeps a streamed spawn in place when an intervening row shifts its synthetic parent index', () => {
    const view = transcript(kind);
    streamMessage(view, { role: 'assistant', content: [{ type: 'text', text: answer }] });
    view.dispatch(event('message_start', { role: 'assistant' }));
    const start: SubagentContentStartEvent = {
      type: 'subagent_content_start',
      sessionId,
      cursor: 1,
      parentMessageId: 'message-1',
      contentIndex: 0,
      operationId: 'spawn-call',
      kind: 'delegation',
      placement: { toolCallId: 'spawn-call', contentIndex: 0 },
      content: {
        type: 'subagent',
        operationId: 'spawn-call',
        subagentKind: 'delegation',
        subagentState: 'active',
        data: { operation: 'delegation', parameters: { agents: [] }, result: { children: [{ path: ['tree'], task: '' }] } },
      },
    };
    view.dispatch(start);
    view.dispatch(event('custom_entry', { message: { role: 'custom', customType: 'notice', content: [{ type: 'text', text: 'Intervening notice.' }] } }));

    const end: SubagentContentEndEvent = {
      type: 'subagent_content_end',
      sessionId,
      cursor: 2,
      parentMessageId: start.parentMessageId,
      contentIndex: start.contentIndex,
      operationId: start.operationId,
      kind: start.kind,
      state: 'complete',
      content: {
        type: 'subagent',
        operationId: start.operationId,
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
    view.dispatch(end);

    const transcriptCards = view.surface.messages.flatMap((message) => message.content.filter((block) => block.type === 'subagent' && block.operationId === 'spawn-call'));
    const streamingCards = view.surface.streamingMessage?.content.filter((block) => block.type === 'subagent' && block.operationId === 'spawn-call') ?? [];
    expect(transcriptCards).toEqual([]);
    expect(streamingCards).toHaveLength(1);
    expect(streamingCards[0]).toMatchObject({ subagentState: 'complete', data: { result: { children: [{ path: ['tree-watcher'] }, { path: ['tree-delegator'] }] } } });
  });

  it('keeps every assistant row readable after a projected row and a new user echo', () => {
    const view = transcript(kind);
    streamMessage(view, { role: 'user', content: [{ type: 'text', text: 'Initial question.' }] });
    view.dispatch(projection('message-1'));
    streamMessage(view, { role: 'assistant', content: [{ type: 'text', text: answer }] });

    view.addPrompt();
    echo(view);

    expect(texts(view)).toContain(answer);
    expect(texts(view).filter((text) => text === prompt)).toHaveLength(1);
  });

  it('preserves a pending user message when an existing assistant projection changes', () => {
    const view = transcript(kind);
    streamMessage(view, { role: 'assistant', entryId: 'answer-entry', content: [{ type: 'text', text: answer }] });
    view.addPrompt();

    view.dispatch(projection('answer-entry'));

    expect(texts(view)).toEqual([answer, prompt]);
    echo(view);
    expect(texts(view)).toEqual([answer, prompt]);
  });

  it('inserts a new projected row ahead of a pending user message without replacing either', () => {
    const view = transcript(kind);
    streamMessage(view, { role: 'assistant', content: [{ type: 'text', text: answer }] });
    view.addPrompt();

    view.dispatch(projection('message-1'));

    expect(texts(view)).toEqual([answer, prompt]);
    expect(view.surface.messages.at(-1)?.role).toBe('user');
    echo(view);
    expect(texts(view)).toEqual([answer, prompt]);
    expect(view.surface.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({ type: 'subagent', operationId: 'send-call' }));
  });

  it('keeps a live operation in its assistant row while a user message awaits its echo', () => {
    const view = transcript(kind);
    streamMessage(view, { role: 'assistant', content: [{ type: 'text', text: answer }] });
    view.dispatch(event('message_start', { role: 'assistant' }));
    view.addPrompt();

    view.dispatch(projection('message-1'));

    expect(texts(view)).toEqual([answer, prompt]);
    expect(view.surface.streamingMessage?.content).toContainEqual(expect.objectContaining({ type: 'subagent', operationId: 'send-call' }));
  });
});
