import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { autoDrainOnAbort, type AutoDrainSession } from './auto-drain-on-abort.js';

function makeSession(overrides: Partial<AutoDrainSession> & { agentOverrides?: Partial<AutoDrainSession['agent']> } = {}): AutoDrainSession & {
  waitForIdle: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
} {
  const waitForIdle = vi.fn(async () => {});
  const continueFn = vi.fn(async () => {});
  return {
    pendingMessageCount: overrides.pendingMessageCount ?? 0,
    agent: {
      waitForIdle: overrides.agentOverrides?.waitForIdle ?? waitForIdle,
      continue: overrides.agentOverrides?.continue ?? continueFn,
    },
    waitForIdle,
    continue: continueFn,
  };
}

const abortedAssistant: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '' }],
  stopReason: 'aborted',
} as unknown as AgentMessage;

const completedAssistant: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'all done' }],
  stopReason: 'stop',
} as unknown as AgentMessage;

describe('autoDrainOnAbort', () => {
  it('does nothing when there is no last message', async () => {
    const session = makeSession({ pendingMessageCount: 3 });
    await autoDrainOnAbort(session, undefined);
    expect(session.waitForIdle).not.toHaveBeenCalled();
    expect(session.continue).not.toHaveBeenCalled();
  });

  it('does nothing when the run completed normally', async () => {
    const session = makeSession({ pendingMessageCount: 3 });
    await autoDrainOnAbort(session, completedAssistant);
    expect(session.waitForIdle).not.toHaveBeenCalled();
    expect(session.continue).not.toHaveBeenCalled();
  });

  it('waits for idle but does not call continue when queue is empty', async () => {
    const session = makeSession({ pendingMessageCount: 0 });
    await autoDrainOnAbort(session, abortedAssistant);
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(session.continue).not.toHaveBeenCalled();
  });

  it('drains via agent.continue() when aborted with pending messages', async () => {
    const session = makeSession({ pendingMessageCount: 2 });
    await autoDrainOnAbort(session, abortedAssistant);
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(session.continue).toHaveBeenCalledTimes(1);
  });

  it('reports continue() failures via onError instead of throwing', async () => {
    const error = new Error('Agent is already processing');
    const continueFn = vi.fn(async () => {
      throw error;
    });
    const session = makeSession({
      pendingMessageCount: 2,
      agentOverrides: { continue: continueFn },
    });
    const onError = vi.fn();
    await autoDrainOnAbort(session, abortedAssistant, onError);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('reports waitForIdle() failures via onError', async () => {
    const error = new Error('boom');
    const waitForIdle = vi.fn(async () => {
      throw error;
    });
    const session = makeSession({
      pendingMessageCount: 2,
      agentOverrides: { waitForIdle },
    });
    const onError = vi.fn();
    await autoDrainOnAbort(session, abortedAssistant, onError);
    expect(onError).toHaveBeenCalledWith(error);
    expect(session.continue).not.toHaveBeenCalled();
  });
});
