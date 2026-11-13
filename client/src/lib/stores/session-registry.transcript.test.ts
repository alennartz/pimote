import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, PimoteSessionEvent, SubagentContentStartEvent } from '@pimote/shared';
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
      attachmentGeneration: 'child-generation',
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
          attachmentGeneration: 'child-generation',
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
      data: { operation: 'send', to: ['worker'], request: 'Check the result.', response: '', phase: 'sending' },
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
