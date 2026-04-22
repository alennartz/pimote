import { describe, it, expect, vi } from 'vitest';
import { VoiceOrchestrator, CallBindError, type VoiceSessionBusResolver } from './voice-orchestrator.js';
import type { PimoteConfig } from './config.js';
import type { ClientConnection, ManagedSlot, PimoteSessionManager } from './session-manager.js';
import type { EventBusController } from '@mariozechner/pi-coding-agent';

// --- Helpers ------------------------------------------------------------------

function fakeConfig(overrides: Partial<PimoteConfig> = {}): PimoteConfig {
  return {
    roots: ['/tmp'],
    idleTimeout: 1000,
    bufferSize: 10,
    port: 3000,
    voice: { speechmuxLlmWsUrl: 'ws://speechmux/llm', speechmuxSignalUrl: 'wss://speechmux/signal' },
    ...overrides,
  } as PimoteConfig;
}

function fakeBus(): EventBusController & { emitted: { type: string; payload: unknown }[] } {
  const emitted: { type: string; payload: unknown }[] = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    emitted,
    emit(type: string, payload: unknown) {
      emitted.push({ type, payload });
      for (const l of listeners.get(type) ?? []) l(payload);
    },
    on(type: string, handler: (payload: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      return () => {
        const cur = listeners.get(type) ?? [];
        listeners.set(
          type,
          cur.filter((h) => h !== handler),
        );
      };
    },
    clear() {
      listeners.clear();
    },
  } as unknown as EventBusController & { emitted: { type: string; payload: unknown }[] };
}

function fakeSlot(id: string): ManagedSlot {
  return { sessionState: { id } } as unknown as ManagedSlot;
}

function fakeConnection(): ClientConnection {
  return { ws: {} as any, connectedClientId: 'c-1', onSessionReset: null };
}

// --- Setup --------------------------------------------------------------------

function makeOrchestrator(options?: {
  slotLookup?: Map<string, ManagedSlot>;
  busLookup?: Map<string, ReturnType<typeof fakeBus>>;
  configOverrides?: Partial<PimoteConfig>;
  displace?: (sessionId: string, newOwner: ClientConnection) => Promise<void>;
  startImpl?: () => Promise<void>;
  stopImpl?: () => Promise<void>;
  isOwnedByVoiceCall?: (id: string) => boolean;
}) {
  const slots = options?.slotLookup ?? new Map<string, ManagedSlot>([['s-1', fakeSlot('s-1')]]);
  const buses = options?.busLookup ?? new Map([['s-1', fakeBus()]]);

  const resolver: VoiceSessionBusResolver = {
    getSlot: (id) => slots.get(id) ?? null,
    getEventBus: (id) => buses.get(id) ?? null,
  };

  const displaceOwner = options?.displace ?? vi.fn(async () => {});
  const startSpeechmux = options?.startImpl ?? vi.fn(async () => {});
  const stopSpeechmux = options?.stopImpl ?? vi.fn(async () => {});
  const isOwnedByVoiceCall = options?.isOwnedByVoiceCall ?? (() => false);

  const orchestrator = new VoiceOrchestrator({
    config: fakeConfig(options?.configOverrides),
    sessionManager: {} as PimoteSessionManager,
    busResolver: resolver,
    startSpeechmux,
    stopSpeechmux,
    displaceOwner,
    isOwnedByVoiceCall,
  });

  return { orchestrator, buses, slots, displaceOwner, startSpeechmux, stopSpeechmux };
}

// =============================================================================

describe('VoiceOrchestrator lifecycle', () => {
  it('start() spawns speechmux once', async () => {
    const { orchestrator, startSpeechmux } = makeOrchestrator();
    await orchestrator.start();
    await orchestrator.start();
    expect(startSpeechmux).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent', async () => {
    const { orchestrator, stopSpeechmux } = makeOrchestrator();
    await orchestrator.start();
    await orchestrator.stop();
    await orchestrator.stop();
    expect(stopSpeechmux).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceOrchestrator.bindCall', () => {
  it('emits pimote:voice:activate on the session bus and returns signalling info', async () => {
    const { orchestrator, buses } = makeOrchestrator();
    const res = await orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false });
    expect(res.sessionId).toBe('s-1');
    expect(res.webrtcSignalUrl).toBe('wss://speechmux/signal');
    // The pimote side no longer mints or proxies per-call auth tokens or
    // TURN creds — speechmux owns both now (DR-015 / DR-016).
    expect(res).not.toHaveProperty('callToken');
    expect(res).not.toHaveProperty('turn');

    const bus = buses.get('s-1')!;
    expect(bus.emitted).toEqual([
      {
        type: 'pimote:voice:activate',
        payload: {
          type: 'pimote:voice:activate',
          sessionId: 's-1',
          speechmuxWsUrl: 'ws://speechmux/llm',
        },
      },
    ]);
  });

  it('throws call_bind_failed_session_not_found for unknown session', async () => {
    const { orchestrator } = makeOrchestrator({ slotLookup: new Map() });
    await expect(orchestrator.bindCall({ sessionId: 'missing', clientConnection: fakeConnection(), force: false })).rejects.toMatchObject({
      name: 'CallBindError',
      code: 'call_bind_failed_session_not_found',
    });
  });

  it('throws call_bind_failed_owned when already bound and force=false', async () => {
    const { orchestrator } = makeOrchestrator({ isOwnedByVoiceCall: () => true });
    await expect(orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false })).rejects.toBeInstanceOf(CallBindError);
  });

  it('force=true displaces existing owner and succeeds', async () => {
    const displaceOwner = vi.fn(async () => {});
    const { orchestrator } = makeOrchestrator({ isOwnedByVoiceCall: () => true, displace: displaceOwner });
    const res = await orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: true });
    expect(displaceOwner).toHaveBeenCalledTimes(1);
    expect(res.webrtcSignalUrl).toBe('wss://speechmux/signal');
  });

  it('missing speechmux URLs surfaces as call_bind_failed_internal (voice disabled)', async () => {
    const { orchestrator } = makeOrchestrator({
      configOverrides: { voice: {} as PimoteConfig['voice'] },
    });
    await expect(orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false })).rejects.toMatchObject({ code: 'call_bind_failed_internal' });
  });

  it('isCallActive reflects a successful bind', async () => {
    const { orchestrator } = makeOrchestrator();
    expect(orchestrator.isCallActive('s-1')).toBe(false);
    await orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false });
    expect(orchestrator.isCallActive('s-1')).toBe(true);
  });
});

describe('VoiceOrchestrator.endCall', () => {
  it('emits pimote:voice:deactivate and clears active-call state', async () => {
    const { orchestrator, buses } = makeOrchestrator();
    await orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false });
    await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });

    const bus = buses.get('s-1')!;
    expect(bus.emitted.map((e) => e.type)).toEqual(['pimote:voice:activate', 'pimote:voice:deactivate']);
    expect(orchestrator.isCallActive('s-1')).toBe(false);
  });

  it('is idempotent — a second endCall for the same session is a no-op', async () => {
    const { orchestrator, buses } = makeOrchestrator();
    await orchestrator.bindCall({ sessionId: 's-1', clientConnection: fakeConnection(), force: false });
    await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
    await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
    const bus = buses.get('s-1')!;
    expect(bus.emitted.filter((e) => e.type === 'pimote:voice:deactivate')).toHaveLength(1);
  });

  it('endCall for an unbound session does not emit and does not throw', async () => {
    const { orchestrator, buses } = makeOrchestrator();
    await orchestrator.endCall({ sessionId: 's-1', reason: 'server_ended' });
    const bus = buses.get('s-1')!;
    expect(bus.emitted).toEqual([]);
  });
});
