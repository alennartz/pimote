import { describe, expect, it, vi } from 'vitest';
import { VoiceOrchestrator, type VoiceOrchestratorOptions } from './voice-orchestrator.js';

function createOrchestrator(notifyClientCallEnded = vi.fn()): VoiceOrchestrator {
  const bus = { on: vi.fn(() => () => {}), emit: vi.fn(), clear: vi.fn() };
  const options: VoiceOrchestratorOptions = {
    config: { voice: { speechmuxSignalUrl: 'https://speechmux.test/signal', speechmuxLlmWsUrl: 'wss://speechmux.test/llm' } } as any,
    sessionManager: {} as any,
    notifyClientCallEnded,
    busResolver: {
      getSlot: () => ({}) as any,
      getEventBus: () => bus,
    },
  };
  return new VoiceOrchestrator(options);
}

describe('voice call holder', () => {
  it('records the client that binds the first call for a session', async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.bindCall({ sessionId: 'session-1', clientId: 'client-a', force: false });

    expect(orchestrator.callHolder.get('session-1')).toBe('client-a');
  });

  it('rejects a second caller without force while the first holder remains active', async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.bindCall({ sessionId: 'session-1', clientId: 'client-a', force: false });

    await expect(orchestrator.bindCall({ sessionId: 'session-1', clientId: 'client-b', force: false })).rejects.toMatchObject({ code: 'call_bind_failed_owned' });
    expect(orchestrator.callHolder.get('session-1')).toBe('client-a');
  });

  it('force binding transfers the holder and clears it when the call ends', async () => {
    const notify = vi.fn();
    const orchestrator = createOrchestrator(notify);
    await orchestrator.bindCall({ sessionId: 'session-1', clientId: 'client-a', force: false });

    await orchestrator.bindCall({ sessionId: 'session-1', clientId: 'client-b', force: true });
    expect(notify).toHaveBeenCalledWith('client-a', { type: 'call_ended', sessionId: 'session-1', reason: 'displaced' });
    expect(notify.mock.calls.some(([, event]) => event.type === 'session_closed')).toBe(false);
    expect(orchestrator.callHolder.get('session-1')).toBe('client-b');

    await orchestrator.endCall({ sessionId: 'session-1', reason: 'user_hangup' });
    expect(orchestrator.callHolder.has('session-1')).toBe(false);
  });
});
