import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PimoteSessionManager } from './session-manager.js';
import type { ManagedSlot, SessionState, ClientConnection } from './session-manager.js';
import type { PimoteConfig } from './config.js';
import type { PushNotificationService } from './push-notification.js';

// --- Helpers ---

function createMockPushService(): PushNotificationService {
  return {
    notify: async () => {},
    initialize: async () => {},
    addSubscription: async () => {},
    removeSubscription: async () => {},
    getSubscriptions: () => [],
  } as unknown as PushNotificationService;
}

function createTestConfig(overrides: Partial<PimoteConfig> = {}): PimoteConfig {
  return {
    roots: ['/tmp/test-root'],
    idleTimeout: 300_000, // 5 minutes
    bufferSize: 100,
    port: 3000,
    ...overrides,
  };
}

/**
 * Insert a fake ManagedSlot directly into the manager's internal sessions Map.
 */
function injectSession(manager: PimoteSessionManager, slot: ManagedSlot): void {
  const sessions = (manager as any).sessions as Map<string, ManagedSlot>;
  sessions.set(slot.sessionState.id, slot);
}

function createFakeSlot(overrides: Partial<{
  id: string;
  folderPath: string;
  connection: ClientConnection | null;
  lastActivity: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
  unsubscribe: () => void;
}> = {}): ManagedSlot {
  const id = overrides.id ?? 'test-session-' + Math.random().toString(36).slice(2, 8);
  const sessionState: SessionState = {
    id,
    eventBuffer: { replay: () => [], currentCursor: 0, onEvent: () => {} } as any,
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    lastActivity: overrides.lastActivity ?? Date.now(),
    unsubscribe: overrides.unsubscribe ?? vi.fn(),
    pendingUiResponses: new Map(),
    extensionsBound: false,
    panelState: new Map(),
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
  };

  const mockSession = {
    dispose: vi.fn(),
    subscribe: () => () => {},
    messages: [],
    sessionId: id,
  } as any;

  const slot: ManagedSlot = {
    runtime: { session: mockSession } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',
    eventBusRef: { current: null },
    connection: overrides.connection ?? null,
    sessionState,
    get session() {
      return this.runtime.session;
    },
  };

  return slot;
}

// --- Tests ---

describe('PimoteSessionManager — idle reaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps sessions with no connected client past idle timeout', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const staleSlot = createFakeSlot({
      id: 'stale-1',
      connection: null,
      lastActivity: now - 400_000, // 6.7 minutes ago (past 5-minute timeout)
    });

    injectSession(manager, staleSlot);

    manager.startIdleCheck(300_000); // 5 minutes

    // Advance past one check interval (60 seconds)
    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).toHaveBeenCalledWith('stale-1');

    manager.stopIdleCheck();
  });

  it('does NOT reap sessions within idle timeout', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const freshSlot = createFakeSlot({
      id: 'fresh-1',
      connection: null,
      lastActivity: now - 60_000, // 1 minute ago (within 5-minute timeout)
    });

    injectSession(manager, freshSlot);

    manager.startIdleCheck(300_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).not.toHaveBeenCalled();

    manager.stopIdleCheck();
  });

  it('does NOT reap sessions with a connected client (isClientConnected returns true)', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const connectedSlot = createFakeSlot({
      id: 'connected-1',
      connection: { ws: {} as any, connectedClientId: 'client-abc', onSessionReset: null },
      lastActivity: now - 400_000, // old activity but client is connected
    });

    injectSession(manager, connectedSlot);

    const isClientConnected = (clientId: string) => clientId === 'client-abc';
    manager.startIdleCheck(300_000, isClientConnected);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).not.toHaveBeenCalled();

    manager.stopIdleCheck();
  });

  it('reaps sessions whose connectedClientId is set but isClientConnected returns false', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const ghostSlot = createFakeSlot({
      id: 'ghost-1',
      connection: { ws: {} as any, connectedClientId: 'dead-client', onSessionReset: null },
      lastActivity: now - 400_000,
    });

    injectSession(manager, ghostSlot);

    // isClientConnected returns false for 'dead-client'
    const isClientConnected = (_clientId: string) => false;
    manager.startIdleCheck(300_000, isClientConnected);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).toHaveBeenCalledWith('ghost-1');

    manager.stopIdleCheck();
  });

  it('uses isClientConnected callback only when connectedClientId is not null', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    // Session with null connection and old activity
    const nullClientSlot = createFakeSlot({
      id: 'null-client-1',
      connection: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, nullClientSlot);

    const isClientConnected = vi.fn(() => true);
    manager.startIdleCheck(300_000, isClientConnected);

    await vi.advanceTimersByTimeAsync(60_000);

    // connection is null, so isClientConnected should not be called
    expect(isClientConnected).not.toHaveBeenCalled();
    // But session should still be reaped (null client + past timeout)
    expect(closeSessionSpy).toHaveBeenCalledWith('null-client-1');

    manager.stopIdleCheck();
  });

  it('reaps multiple stale sessions in one check', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const stale1 = createFakeSlot({
      id: 'stale-a',
      connection: null,
      lastActivity: now - 400_000,
    });
    const stale2 = createFakeSlot({
      id: 'stale-b',
      connection: { ws: {} as any, connectedClientId: 'gone-client', onSessionReset: null },
      lastActivity: now - 500_000,
    });
    const fresh = createFakeSlot({
      id: 'fresh-a',
      connection: null,
      lastActivity: now - 100_000, // within timeout
    });

    injectSession(manager, stale1);
    injectSession(manager, stale2);
    injectSession(manager, fresh);

    const isClientConnected = (_clientId: string) => false;
    manager.startIdleCheck(300_000, isClientConnected);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).toHaveBeenCalledWith('stale-a');
    expect(closeSessionSpy).toHaveBeenCalledWith('stale-b');
    expect(closeSessionSpy).not.toHaveBeenCalledWith('fresh-a');

    manager.stopIdleCheck();
  });

  it('falls back to reaping when no isClientConnected callback is provided', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    // Session has a connectedClientId but no isClientConnected callback is given
    const slot = createFakeSlot({
      id: 'no-callback-1',
      connection: { ws: {} as any, connectedClientId: 'some-client', onSessionReset: null },
      lastActivity: now - 400_000,
    });

    injectSession(manager, slot);

    // No isClientConnected callback — should treat connectedClientId as not verified
    manager.startIdleCheck(300_000);

    await vi.advanceTimersByTimeAsync(60_000);

    // Without the callback, isClientConnected defaults to false,
    // so session with expired activity should be reaped
    expect(closeSessionSpy).toHaveBeenCalledWith('no-callback-1');

    manager.stopIdleCheck();
  });

  it('stopIdleCheck prevents further reaping', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const slot = createFakeSlot({
      id: 'stop-test-1',
      connection: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, slot);

    manager.startIdleCheck(300_000);
    manager.stopIdleCheck();

    await vi.advanceTimersByTimeAsync(120_000); // well past the check interval

    expect(closeSessionSpy).not.toHaveBeenCalled();
  });

  it('restarts idle check cleanly when called multiple times', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const slot = createFakeSlot({
      id: 'restart-1',
      connection: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, slot);

    // Start, then start again (should clear old interval)
    manager.startIdleCheck(300_000);
    manager.startIdleCheck(300_000);

    await vi.advanceTimersByTimeAsync(60_000);

    // Should only be called once per check, not twice (no duplicate intervals)
    expect(closeSessionSpy).toHaveBeenCalledTimes(1);
    expect(closeSessionSpy).toHaveBeenCalledWith('restart-1');

    manager.stopIdleCheck();
  });
});
