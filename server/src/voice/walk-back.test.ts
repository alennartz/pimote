import { describe, it, expect } from 'vitest';
import { walkBack } from './walk-back.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

// Build pi-runtime-shaped messages. Tool results are their own `toolResult`
// messages referencing a toolCallId at the message level.
const speak = (id: string, text: string) => ({ type: 'toolCall', id, name: 'speak', arguments: { text } });
const tool = (id: string, name: string) => ({ type: 'toolCall', id, name, arguments: {} });
const assistant = (content: unknown[], stopReason?: string) => ({ role: 'assistant', content, ...(stopReason ? { stopReason } : {}) }) as unknown as AgentMessage;
const toolResult = (toolCallId: string) => ({ role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'ok' }] }) as unknown as AgentMessage;

const speakBlocks = (m: AgentMessage) => (m as { content: { type: string; name?: string }[] }).content.filter((b) => b.type === 'toolCall' && b.name === 'speak');
const blockText = (m: AgentMessage, i: number) => (m as { content: { arguments?: { text?: string } }[] }).content[i]?.arguments?.text ?? '';
const resultIds = (msgs: AgentMessage[]) => msgs.filter((m) => (m as { role?: string }).role === 'toolResult').map((m) => (m as { toolCallId: string }).toolCallId);

describe('walkBack — prune rule (M6)', () => {
  it('strips a trailing aborted-empty assistant', () => {
    const msgs = [assistant([{ type: 'text', text: 'hi' }]), assistant([{ type: 'text', text: '' }], 'aborted')];
    const out = walkBack({ messages: msgs, rollback: null });
    expect(out).toHaveLength(1);
  });

  it('no rollback → only strips, leaves real content alone', () => {
    const msgs = [assistant([speak('s1', 'hello')]), toolResult('s1')];
    const out = walkBack({ messages: msgs, rollback: null });
    expect(out).toEqual(msgs);
  });

  it('target not found → no-op beyond the strip', () => {
    const msgs = [assistant([speak('s1', 'hello')]), toolResult('s1')];
    const out = walkBack({ messages: msgs, rollback: { heardText: 'he', targetSpeakToolCallId: 'missing' } });
    expect(out).toEqual(msgs);
  });

  it('partial heard: truncates target, drops later speaks, KEEPS non-speak tool calls + results', () => {
    const msgs = [
      assistant([speak('spk1', 'Hello there friend')], 'endTurn'),
      toolResult('spk1'),
      assistant([tool('read1', 'read'), speak('spk2', 'Reading done')]),
      toolResult('read1'),
      toolResult('spk2'),
    ];
    const out = walkBack({ messages: msgs, rollback: { heardText: 'Hello', targetSpeakToolCallId: 'spk1' } });

    // Target truncated to heardText.
    expect(blockText(out[0]!, 0)).toBe('Hello');
    // D2: original stopReason preserved, not forced to 'aborted'.
    expect((out[0] as { stopReason?: string }).stopReason).toBe('endTurn');
    // The non-speak tool call survives with its result; both speak results are gone.
    expect(resultIds(out)).toEqual(['read1']);
    // spk2 (a later speak) was dropped.
    const allSpeakIds = out.flatMap((m) =>
      ((m as { content?: { id?: string; name?: string; type?: string }[] }).content ?? []).filter((b) => b.type === 'toolCall' && b.name === 'speak').map((b) => b.id),
    );
    expect(allSpeakIds).toEqual(['spk1']);
    // read tool call retained.
    expect(out.some((m) => ((m as { content?: { id?: string }[] }).content ?? []).some((b) => b.id === 'read1'))).toBe(true);
  });

  it('fully heard: keeps the target speak intact and its result', () => {
    const msgs = [assistant([speak('s1', 'Hi')]), toolResult('s1')];
    const out = walkBack({ messages: msgs, rollback: { heardText: 'Hi', targetSpeakToolCallId: 's1' } });
    expect(out).toHaveLength(2);
    expect(speakBlocks(out[0]!)).toHaveLength(1);
    expect(resultIds(out)).toEqual(['s1']);
  });

  it('empty heard: drops the target speak and its result', () => {
    const msgs = [assistant([{ type: 'text', text: 'pre' }]), assistant([speak('s1', 'Hi')]), toolResult('s1')];
    const out = walkBack({ messages: msgs, rollback: { heardText: '', targetSpeakToolCallId: 's1' } });
    // The pre-target assistant survives; the target speak message (now empty) and its result are gone.
    expect(out).toHaveLength(1);
    expect(resultIds(out)).toEqual([]);
  });

  it('drops a block-level (Anthropic-shape) tool_result for a pruned speak', () => {
    const msgs = [assistant([speak('s1', 'Hello world')]), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1' }] } as unknown as AgentMessage];
    const out = walkBack({ messages: msgs, rollback: { heardText: 'Hello', targetSpeakToolCallId: 's1' } });
    // truncated target kept; the orphaned tool_result block message is dropped.
    expect(out).toHaveLength(1);
    expect(blockText(out[0]!, 0)).toBe('Hello');
  });
});
