// Tests for the walk-back surgery contract.
// See docs/plans/voice-mode.md — "Walk-back surgery contract".

import { describe, it, expect } from 'vitest';
import { walkBack, isAbortedEmptyAssistant, type ContentBlock } from './walk-back.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

// --- Helpers (shallow AgentMessage shapes — we only use fields the contract touches). ---

function speak(id: string, text: string): ContentBlock {
  return { type: 'tool_use', name: 'speak', id, input: { text } };
}
function thinking(text: string): ContentBlock {
  return { type: 'thinking', text };
}
function freeText(text: string): ContentBlock {
  return { type: 'text', text };
}
function otherTool(id: string, name: string): ContentBlock {
  return { type: 'tool_use', name, id, input: {} };
}
function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}
function assistantMsg(content: ContentBlock[], stopReason?: string): AgentMessage {
  return { role: 'assistant', content, ...(stopReason ? { stopReason } : {}) } as unknown as AgentMessage;
}
function syntheticAborted(): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'aborted' } as unknown as AgentMessage;
}
function toolResultMsg(toolUseId: string, text = 'ok'): AgentMessage {
  return {
    role: 'toolResult',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }],
  } as unknown as AgentMessage;
}
function capturedAssistant(content: ContentBlock[]): {
  role: 'assistant';
  content: ContentBlock[];
  stopReason?: string;
} {
  return { role: 'assistant', content, stopReason: 'aborted' };
}

// =============================================================================

describe('isAbortedEmptyAssistant', () => {
  it('returns true for pi synthetic empty aborted assistant', () => {
    expect(isAbortedEmptyAssistant(syntheticAborted())).toBe(true);
  });
  it('returns false for completed assistant with content', () => {
    expect(isAbortedEmptyAssistant(assistantMsg([freeText('hello')]))).toBe(false);
  });
  it('returns false for aborted assistant that somehow has real text', () => {
    expect(isAbortedEmptyAssistant(assistantMsg([freeText('real')], 'aborted'))).toBe(false);
  });
  it('returns false for user messages', () => {
    expect(isAbortedEmptyAssistant(userMsg('hi'))).toBe(false);
  });
});

describe('walkBack — idempotency (no pending rollback)', () => {
  it('drops a trailing synthetic aborted assistant when no watermark present', () => {
    const msgs = [userMsg('hi'), assistantMsg([freeText('earlier')]), syntheticAborted()];
    const out = walkBack({ heardText: null, captured: null, messages: msgs });
    expect(out).toHaveLength(2);
    expect(out[out.length - 1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'earlier' }] });
  });

  it('drops multiple trailing synthetic aborted assistants', () => {
    const msgs = [userMsg('hi'), syntheticAborted(), syntheticAborted()];
    const out = walkBack({ heardText: null, captured: null, messages: msgs });
    expect(out).toHaveLength(1);
  });

  it('is a no-op when the tail is a real completed turn', () => {
    const msgs = [userMsg('hi'), assistantMsg([freeText('real')])];
    const out = walkBack({ heardText: null, captured: null, messages: msgs });
    expect(out).toEqual(msgs);
  });

  it('never reaches past a real assistant to drop earlier empties', () => {
    // Only the trailing run of empties is stripped.
    const msgs = [syntheticAborted(), assistantMsg([freeText('real')])];
    const out = walkBack({ heardText: null, captured: null, messages: msgs });
    expect(out).toEqual(msgs);
  });
});

describe('walkBack — empty-heard abort with no audible output', () => {
  it('drops the aborted turn entirely when captured has no speak chunks', () => {
    const msgs = [userMsg('hi'), syntheticAborted()];
    const captured = capturedAssistant([thinking('reasoning'), freeText('preface')]);
    const out = walkBack({ heardText: '', captured, messages: msgs });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'user' });
  });

  it('still strips the synthetic aborted assistant even when nothing is appended', () => {
    const msgs = [userMsg('hi'), syntheticAborted()];
    const captured = capturedAssistant([]);
    const out = walkBack({ heardText: '', captured, messages: msgs });
    expect(out.some((m) => isAbortedEmptyAssistant(m))).toBe(false);
  });
});

describe('walkBack — speak chunks fully heard', () => {
  it('keeps all speak blocks when heardText matches their concatenation exactly', () => {
    const captured = capturedAssistant([speak('t1', 'Hello '), speak('t2', 'world')]);
    const out = walkBack({ heardText: 'Hello world', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.role).toBe('assistant');
    expect(last.content).toHaveLength(2);
    expect(last.content[0].input.text).toBe('Hello ');
    expect(last.content[1].input.text).toBe('world');
    expect(last.stopReason).toBe('aborted');
  });
});

describe('walkBack — speak chunk truncation', () => {
  it('truncates a speak block whose tail crosses the heardText boundary', () => {
    const captured = capturedAssistant([speak('t1', 'Hello '), speak('t2', 'world, friend')]);
    const out = walkBack({ heardText: 'Hello wor', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.content).toHaveLength(2);
    expect(last.content[0].input.text).toBe('Hello ');
    expect(last.content[1].input.text).toBe('wor');
  });

  it('drops later blocks after truncation', () => {
    const captured = capturedAssistant([speak('t1', 'abcdef'), speak('t2', 'xyz'), freeText('should-drop')]);
    const out = walkBack({ heardText: 'abc', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.content).toHaveLength(1);
    expect(last.content[0].input.text).toBe('abc');
  });

  it('truncates to exactly heardText.length characters, counting from start', () => {
    const captured = capturedAssistant([speak('t1', 'The quick brown fox')]);
    const out = walkBack({ heardText: 'The qui', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.content[0].input.text).toBe('The qui');
  });
});

describe('walkBack — non-speak blocks before / after cutoff', () => {
  it('keeps non-speak blocks whose position precedes the cutoff', () => {
    const captured = capturedAssistant([thinking('thinking!'), speak('t1', 'hello')]);
    const out = walkBack({ heardText: 'hello', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.content).toHaveLength(2);
    expect(last.content[0].type).toBe('thinking');
    expect(last.content[1].input.text).toBe('hello');
  });

  it('drops non-speak blocks that appear after the audible cutoff', () => {
    const captured = capturedAssistant([speak('t1', 'hello'), thinking('lateThought'), otherTool('t2', 'bash')]);
    const out = walkBack({ heardText: 'hello', captured, messages: [userMsg('hi'), syntheticAborted()] });
    const last = out[out.length - 1] as any;
    expect(last.content).toHaveLength(1);
    expect(last.content[0].input.text).toBe('hello');
  });
});

describe('walkBack — paired tool_result dropping', () => {
  it('drops paired tool_result blocks for dropped speak tool_uses', () => {
    // First speak is fully heard (kept-id). Second lies past the cutoff (dropped-id).
    const captured = capturedAssistant([speak('kept-id', 'hello'), speak('dropped-id', 'WORLD')]);
    const msgs: AgentMessage[] = [userMsg('hi'), toolResultMsg('kept-id'), toolResultMsg('dropped-id'), syntheticAborted()];
    const out = walkBack({ heardText: 'hello', captured, messages: msgs });
    const toolResults = out.filter((m) => (m as any).role === 'toolResult') as any[];
    const allResultIds = toolResults.flatMap((m) => m.content.map((b: any) => b.tool_use_id));
    expect(allResultIds).toContain('kept-id');
    expect(allResultIds).not.toContain('dropped-id');
  });
});

describe('walkBack — step-1 always applies', () => {
  it('strips the synthetic aborted assistant before appending the reconstruction', () => {
    const captured = capturedAssistant([speak('t1', 'hi')]);
    const msgs = [userMsg('hi'), syntheticAborted()];
    const out = walkBack({ heardText: 'hi', captured, messages: msgs });
    // Exactly one assistant message in output — the reconstruction.
    const assistants = out.filter((m) => (m as any).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(isAbortedEmptyAssistant(assistants[0]!)).toBe(false);
  });
});
