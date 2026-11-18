import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { BorrowedAgentSession } from '@pimote/sdk/subagents';
import type { PimoteEvent } from '../../shared/dist/index.js';
import { createSessionSurface, type SessionSurfaceCapabilities, type SessionSurfaceOptions } from './session-surface.js';

function fixture(kind: 'root' | 'child') {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let streaming = true;
  let steering: string[] = [];
  let followUp: string[] = [];
  const delivered: { clientId: string; event: PimoteEvent }[] = [];
  const publish = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const queue = (text: string, behavior: 'steer' | 'followUp') => {
    (behavior === 'steer' ? steering : followUp).push(text);
    publish({ type: 'queue_update', steering: [...steering], followUp: [...followUp] });
  };
  const native = {
    sessionId: 'conversation',
    sessionFile: '/saved/conversation.jsonl',
    messages: [],
    model: null,
    thinkingLevel: 'high',
    get isStreaming() {
      return streaming;
    },
    get isIdle() {
      return !streaming;
    },
    isCompacting: false,
    isBashRunning: false,
    state: { streamingMessage: undefined, pendingToolCalls: new Set<string>(), errorMessage: undefined },
    sessionManager: { getBranch: () => [], getEntries: () => [], buildContextEntries: () => [], getCwd: () => '/workspace' },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSteeringMessages: () => [...steering],
    getFollowUpMessages: () => [...followUp],
    async prompt(text: string, options: { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (outcome: 'started' | 'queued') => void }) {
      if (streaming) {
        queue(text, options.streamingBehavior ?? 'steer');
        options.preflightResult?.('queued');
      } else {
        streaming = true;
        options.preflightResult?.('started');
        publish({ type: 'agent_start' });
      }
    },
    async followUp(text: string) {
      queue(text, 'followUp');
      return 'queued';
    },
    clearQueue() {
      const drained = { steering, followUp };
      steering = [];
      followUp = [];
      publish({ type: 'queue_update', steering, followUp });
      return drained;
    },
    async abort() {
      streaming = false;
    },
    getContextUsage: () => null,
    getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
  } as unknown as BorrowedAgentSession;
  const capabilities: SessionSurfaceCapabilities = {
    operations: ['prompt', 'steer', 'follow_up', 'stop'],
    resolveModel: async () => undefined,
    getSettings: () => ({ availableThinkingLevels: ['off', 'high'], autoCompactionEnabled: false }),
    getCommands: async () => [],
    completeArgs: async () => [],
    completeFileRefs: async () => [],
    executeBash: async () => ({ output: '', cancelled: false, truncated: false }),
    getGitBranch: () => null,
  };
  const options = {
    sessionId: native.sessionId,
    session: native,
    kind,
    capabilities,
    ...(kind === 'child' ? { path: ['worker'], incarnation: 'inc', stop: async () => native.abort() } : {}),
    sendToClient: (clientId: string, event: PimoteEvent) => {
      delivered.push({ clientId, event });
      return true;
    },
  };
  const surface = createSessionSurface(options as SessionSurfaceOptions);
  return {
    surface,
    delivered,
    native,
    setStreaming: (value: boolean) => {
      streaming = value;
    },
  };
}

describe.each(['root', 'child'] as const)('%s session interactions', (kind) => {
  it('returns each drained message only to its sender on Abort', async () => {
    const f = fixture(kind);
    await f.surface.initialize();
    await f.surface.dispatch({ type: 'steer', message: 'my question' }, { clientId: 'first' });
    await f.surface.dispatch({ type: 'follow_up', message: 'their question' }, { clientId: 'second' });
    const result = await f.surface.dispatch({ type: 'abort' }, { clientId: 'first' });
    expect(result).toEqual({ steering: ['my question'], followUp: [] });
    expect(f.delivered).toEqual([
      {
        clientId: 'second',
        event: {
          type: 'queued_drafts_restored',
          sessionId: 'conversation',
          steering: [],
          followUp: ['their question'],
        },
      },
    ]);
    expect(f.native.isStreaming).toBe(false);
  });

  it('starts an idle follow-up through the ordinary prompt path', async () => {
    const f = fixture(kind);
    f.setStreaming(false);
    await f.surface.initialize();
    const result = await f.surface.dispatch({ type: 'follow_up', message: 'continue' }, { clientId: 'first' });
    expect(result).toEqual({ outcome: 'started' });
    expect(f.native.isStreaming).toBe(true);
  });
});
