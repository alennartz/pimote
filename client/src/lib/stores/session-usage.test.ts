import { describe, expect, it } from 'vitest';
import type { PimoteEvent } from '@pimote/shared';
import { SessionRegistry } from './session-registry.svelte.js';

const usage = (total: number) => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const event = (type: string, extra = {}) => ({ type, sessionId: 's1', cursor: 1, ...extra }) as PimoteEvent;
const makeRegistry = () => {
  const registry = new SessionRegistry();
  registry.addSession('s1', '/path', 'project');
  return registry;
};
const resync = (messages: unknown[], streamingMessage?: unknown) =>
  event('full_resync', {
    messages,
    streamingMessage,
    state: {
      model: null,
      thinkingLevel: 'off',
      isStreaming: !!streamingMessage,
      isCompacting: false,
      sessionId: 's1',
      autoCompactionEnabled: false,
      messageCount: messages.length,
    },
  });

describe('SessionRegistry usage boundaries', () => {
  it('replaces streaming snapshots and then keeps final usage during replay and resync', () => {
    const registry = makeRegistry();
    registry.handleEvent(event('message_start', { role: 'assistant', usage: usage(1) }));
    registry.handleEvent(event('message_update', { contentIndex: 0, subtype: 'start', content: { type: 'text', text: '' }, usage: usage(2) }));
    expect(registry.sessions.s1.streamingMessage?.usage).toEqual(usage(2));
    const message = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: usage(3) };
    registry.handleEvent(event('message_end', { message }));
    expect(registry.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(3);
    const replay = makeRegistry();
    replay.handleEvent(event('message_end', { message }));
    expect(replay.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(3);
    registry.handleEvent(resync([message]));
    expect(registry.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(3);
    const reload = makeRegistry();
    reload.handleEvent(resync([message]));
    expect(reload.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(3);
  });
  it('restores in-flight usage from full resync without adding snapshots', () => {
    const registry = makeRegistry();
    registry.handleEvent(resync([], { role: 'assistant', content: [], usage: usage(2) }));
    expect(registry.sessions.s1.streamingMessage?.usage).toEqual(usage(2));
  });
  it.each([{ aborted: true }, { errorMessage: 'provider error' }])('keeps partial-only terminal usage in the active view, not persisted data: %s', (terminal) => {
    const registry = makeRegistry();
    registry.handleEvent(event('message_start', { role: 'assistant', usage: usage(1) }));
    const message = { role: 'assistant', content: [], ...terminal };
    registry.handleEvent(event('message_end', { message }));
    expect(registry.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(1);
    expect(message).not.toHaveProperty('usage');
    registry.handleEvent(resync([message]));
    expect(registry.getAssistantRowUsage('s1', 0)).toBeNull();
    const reload = makeRegistry();
    reload.handleEvent(resync([message]));
    expect(reload.getAssistantRowUsage('s1', 0)).toBeNull();
  });
  it('keeps terminal final usage instead of the partial fallback', () => {
    const registry = makeRegistry();
    registry.handleEvent(event('message_start', { role: 'assistant', usage: usage(1) }));
    const message = { role: 'assistant', content: [], aborted: true, usage: usage(2) };
    registry.handleEvent(event('message_end', { message }));
    registry.handleEvent(resync([message]));
    expect(registry.getAssistantRowUsage('s1', 0)?.totalCostUsd).toBe(2);
  });
  it('stores additive session breakdowns without forecast state or partial updates to the Pi total', () => {
    const registry = makeRegistry();
    const usageBreakdown = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
    registry.updateMeta('s1', { gitBranch: null, contextUsage: null, lifetimeCostUsd: 7, usageBreakdown });
    expect(registry.sessions.s1).toMatchObject({ lifetimeCostUsd: 7, usageBreakdown });
    expect(registry.sessions.s1).not.toHaveProperty('nextRoundtripCostUsd');
    registry.handleEvent(event('message_start', { role: 'assistant', usage: usage(1) }));
    expect(registry.sessions.s1.lifetimeCostUsd).toBe(7);
  });
});
