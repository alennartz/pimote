import { describe, it, expect, vi } from 'vitest';
import { buildVoiceOrchestrator, type VoiceClientRegistry } from './voice-orchestrator-boot.js';
import type { PimoteConfig } from './config.js';
import type { ManagedSlot, PimoteSessionManager } from './session-manager.js';
import type { EventBusController } from '@earendil-works/pi-coding-agent';
import type { WsHandler } from './ws-handler.js';

function fakeConfig(): PimoteConfig {
  return {
    roots: ['/tmp'],
    idleTimeout: 1000,
    bufferSize: 10,
    port: 3000,
    voice: { speechmuxLlmWsUrl: 'ws://speechmux/llm', speechmuxSignalUrl: 'wss://speechmux/signal' },
  } as PimoteConfig;
}

function fakeBus(): EventBusController {
  return {
    emit() {},
    on() {
      return () => {};
    },
    clear() {},
  } as unknown as EventBusController;
}

describe('buildVoiceOrchestrator — force-bind ownership transfer (#7)', () => {
  it('displaces the old owner AND claims the session for the new caller', async () => {
    // Slot starts owned by client A. eventBusRef.current must be present for bind.
    const slot = {
      sessionState: { id: 's-1' },
      connection: { connectedClientId: 'A' },
      eventBusRef: { current: fakeBus() },
    } as unknown as ManagedSlot;

    const sessionManager = {
      getSlot: (id: string) => (id === 's-1' ? slot : null),
    } as unknown as PimoteSessionManager;

    const sendDisplacedEvent = vi.fn();
    const claimSession = vi.fn(async (_id: string, s: ManagedSlot) => {
      // Mirror the real claim: new caller becomes the owner.
      (s as any).connection = { connectedClientId: 'B' };
    });

    const handlerA = { sendDisplacedEvent } as unknown as WsHandler;
    const handlerB = { claimSession } as unknown as WsHandler;
    const clientRegistry: VoiceClientRegistry = {
      get: (id) => (id === 'A' ? handlerA : id === 'B' ? handlerB : undefined),
    };

    const boot = buildVoiceOrchestrator({ config: fakeConfig(), sessionManager, clientRegistry });
    expect(boot).not.toBeNull();
    const orchestrator = boot!.orchestrator;

    const connB = { ws: {} as any, connectedClientId: 'B', onSessionReset: null };

    // A binds first so the session is an active voice call (force path requires owned).
    await orchestrator.bindCall({ sessionId: 's-1', clientConnection: { ws: {} as any, connectedClientId: 'A', onSessionReset: null }, force: false });

    // B force-binds: must notify A (displaced) and claim ownership for B.
    await orchestrator.bindCall({ sessionId: 's-1', clientConnection: connB, force: true });

    expect(sendDisplacedEvent).toHaveBeenCalledWith('s-1');
    expect(claimSession).toHaveBeenCalledWith('s-1', slot);
    // Ownership actually transferred — not left pointing at the displaced client.
    expect((slot as any).connection.connectedClientId).toBe('B');

    await boot!.shutdown();
  });
});
