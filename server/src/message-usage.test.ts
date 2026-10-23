import { describe, expect, it } from 'vitest';
import { mapAgentMessage, mapContextEntries } from './message-mapper.js';
import { EventBuffer } from './event-buffer.js';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';

const usage = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  totalTokens: 100,
  cacheWrite1h: 5,
  reasoning: 6,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

describe('message usage wire boundaries', () => {
  it.each(['assistant', 'toolResult'])('preserves %s usage through mapping and persisted context', (role) => {
    const message = { role, content: [{ type: 'text', text: 'answer' }], toolCallId: 'nested', toolName: 'model', usage };
    const mapped = mapAgentMessage(message as never);
    expect(mapped.usage).toEqual(usage);
    if (role === 'toolResult') expect(mapped.content[0].toolCallId).toBe('nested');
    expect(mapContextEntries([{ type: 'message', id: 'entry', parentId: null, timestamp: '2026-01-01T00:00:00Z', message } as never])[0].usage).toEqual(usage);
  });
  it('omits usage for other message roles', () => {
    expect(mapAgentMessage({ role: 'user', content: [], usage } as never).usage).toBeUndefined();
  });
  it('forwards cumulative partial snapshots and final usage through live delivery and replay', () => {
    const buffer = new EventBuffer(100);
    const live: PimoteSessionEvent[] = [];
    const send = (event: PimoteSessionEvent) => live.push(event);
    buffer.onEvent({ type: 'message_start', message: { role: 'assistant', content: [], usage } } as never, 's1', send);
    buffer.onEvent(
      { type: 'message_update', message: { role: 'assistant', content: [], usage }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'answer' } } as never,
      's1',
      send,
    );
    buffer.onEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage } } as never, 's1', send);
    expect(live[0]).toMatchObject({ type: 'message_start', usage });
    expect(live[1]).toMatchObject({ type: 'message_update', usage });
    expect(live[2]).toMatchObject({ type: 'message_end', message: { usage } });
    expect(buffer.replay(0)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ usage }) })]));
  });
  it.each([undefined, { ...usage, input: -1 }, { ...usage, output: NaN }, { ...usage, cost: { ...usage.cost, total: Infinity } }])(
    'does not forward unusable partial usage',
    (snapshot) => {
      const live: PimoteSessionEvent[] = [];
      const buffer = new EventBuffer(10);
      buffer.onEvent({ type: 'message_start', message: { role: 'assistant', content: [], usage: snapshot } } as never, 's1', (event) => live.push(event));
      expect(live[0]).not.toHaveProperty('usage');
    },
  );
});
