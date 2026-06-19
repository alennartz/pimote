import { describe, it, expect } from 'vitest';
import { reduceStreaming, currentStreamingSpeakId } from './streaming.js';
import type { MessageStreamState } from '../state.js';

const fresh = (): MessageStreamState => ({ blocks: new Map(), interrupted: false });

describe('streaming reducer — post-interrupt suppression (gap 1)', () => {
  const speakEnd = { type: 'sdk:toolcall_end' as const, contentIndex: 0, toolCall: { id: 's1', name: 'speak', arguments: { text: 'Hello' } } };

  it('a no-prior-block speak end normally emits token+end', () => {
    const { frames } = reduceStreaming(fresh(), speakEnd);
    expect(frames.map((f) => f.type)).toEqual(['token', 'end']);
  });

  it('once interrupted, the same speak end emits nothing', () => {
    const { frames } = reduceStreaming({ blocks: new Map(), interrupted: true }, speakEnd);
    expect(frames).toEqual([]);
  });

  it('ws:incoming abort latches interrupted', () => {
    const { next } = reduceStreaming(fresh(), { type: 'ws:incoming', frame: { type: 'abort', reason: 'barge_in' } });
    expect(next.interrupted).toBe(true);
  });

  it('message_start clears the interrupt latch', () => {
    const { next } = reduceStreaming({ blocks: new Map(), interrupted: true }, { type: 'sdk:message_start', message: { role: 'assistant', content: [] } as never });
    expect(next.interrupted).toBe(false);
  });
});

describe('currentStreamingSpeakId', () => {
  it('returns null when no speak is mid-stream', () => {
    expect(currentStreamingSpeakId(fresh())).toBeNull();
  });
});
