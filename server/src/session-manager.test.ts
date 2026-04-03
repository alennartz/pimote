import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PimoteSessionManager } from './session-manager.js';
import type { ManagedSession } from './session-manager.js';
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
 * Insert a fake ManagedSession directly into the manager's internal sessions Map.
 * We access the private map via getAllSessions() + getSession() for reading,
 * and use this function to inject test data by reaching through the manager.
 */
function injectSession(manager: PimoteSessionManager, session: ManagedSession): void {
  // Access the private sessions Map — necessary for testing the idle reaper
  // without spinning up real pi SDK sessions.
  const sessions = (manager as any).sessions as Map<string, ManagedSession>;
  sessions.set(session.id, session);
}

function createFakeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  const id = overrides.id ?? 'test-session-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    session: {
      dispose: vi.fn(),
      subscribe: () => () => {},
      messages: [],
    } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',

    eventBuffer: { replay: () => [], currentCursor: 0, onEvent: () => {} } as any,
    connectedClientId: overrides.connectedClientId ?? null,
    lastActivity: overrides.lastActivity ?? Date.now(),
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    unsubscribe: overrides.unsubscribe ?? vi.fn(),
    ws: overrides.ws ?? null,
    pendingUiResponses: overrides.pendingUiResponses ?? new Map(),
    extensionsBound: overrides.extensionsBound ?? false,
    onSessionReset: overrides.onSessionReset ?? null,
    panelState: overrides.panelState ?? new Map(),
    panelThrottleTimer: overrides.panelThrottleTimer ?? null,
    ...overrides,
  };
}

// --- Tests ---

describe('PimoteSessionManager — detachSession', () => {
  it('removes session from map without disposing AgentSession', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const disposeFn = vi.fn();
    const unsubFn = vi.fn();
    const session = createFakeSession({
      id: 'detach-1',
      session: { dispose: disposeFn, subscribe: () => () => {}, messages: [] } as any,
      unsubscribe: unsubFn,
    });

    injectSession(manager, session);
    expect(manager.getSession('detach-1')).toBeDefined();

    manager.detachSession('detach-1');

    expect(manager.getSession('detach-1')).toBeUndefined();
    expect(unsubFn).toHaveBeenCalled();
    expect(disposeFn).not.toHaveBeenCalled();
  });

  it('fires onSessionClosed callback', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closedCallback = vi.fn();
    manager.onSessionClosed = closedCallback;

    const session = createFakeSession({ id: 'detach-2', folderPath: '/home/user/proj' });
    injectSession(manager, session);

    manager.detachSession('detach-2');

    expect(closedCallback).toHaveBeenCalledWith('detach-2', '/home/user/proj');
  });

  it('is a no-op for unknown session IDs', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    // Should not throw
    manager.detachSession('nonexistent');
  });
});

describe('PimoteSessionManager — adoptSession', () => {
  it('creates a new managed session wrapping the given AgentSession', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const mockAgentSession = {
      sessionId: 'adopted-1',
      isStreaming: false,
      subscribe: () => () => {},
      messages: [],
    } as any;

    const returnedId = manager.adoptSession(mockAgentSession, '/home/user/proj');

    expect(returnedId).toBe('adopted-1');
    const managed = manager.getSession('adopted-1');
    expect(managed).toBeDefined();
    expect(managed!.session).toBe(mockAgentSession);
    expect(managed!.folderPath).toBe('/home/user/proj');
    expect(managed!.connectedClientId).toBeNull();
    expect(managed!.status).toBe('idle');
  });

  it('sets status to working if AgentSession is streaming', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const mockAgentSession = {
      sessionId: 'adopted-streaming',
      isStreaming: true,
      subscribe: () => () => {},
      messages: [],
    } as any;

    manager.adoptSession(mockAgentSession, '/home/user/proj');

    const managed = manager.getSession('adopted-streaming');
    expect(managed!.status).toBe('working');
  });

  it('subscribes to events and fires onStatusChange on agent_start/agent_end', () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const statusCallback = vi.fn();
    manager.onStatusChange = statusCallback;

    let subscribedCallback: ((event: any) => void) | null = null;
    const mockAgentSession = {
      sessionId: 'adopted-events',
      isStreaming: false,
      subscribe: (cb: any) => {
        subscribedCallback = cb;
        return () => {};
      },
      messages: [],
    } as any;

    manager.adoptSession(mockAgentSession, '/home/user/proj');
    expect(subscribedCallback).not.toBeNull();

    // Simulate agent_start
    subscribedCallback!({ type: 'agent_start' });
    expect(statusCallback).toHaveBeenCalledWith('adopted-events', '/home/user/proj');

    statusCallback.mockClear();

    // Simulate agent_end
    subscribedCallback!({ type: 'agent_end' });
    expect(statusCallback).toHaveBeenCalledWith('adopted-events', '/home/user/proj');
  });
});

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
    const staleSession = createFakeSession({
      id: 'stale-1',
      connectedClientId: null,
      lastActivity: now - 400_000, // 6.7 minutes ago (past 5-minute timeout)
    });

    injectSession(manager, staleSession);

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
    const freshSession = createFakeSession({
      id: 'fresh-1',
      connectedClientId: null,
      lastActivity: now - 60_000, // 1 minute ago (within 5-minute timeout)
    });

    injectSession(manager, freshSession);

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
    const connectedSession = createFakeSession({
      id: 'connected-1',
      connectedClientId: 'client-abc',
      lastActivity: now - 400_000, // old activity but client is connected
    });

    injectSession(manager, connectedSession);

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
    const ghostSession = createFakeSession({
      id: 'ghost-1',
      connectedClientId: 'dead-client', // client ID recorded but not actually connected
      lastActivity: now - 400_000,
    });

    injectSession(manager, ghostSession);

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
    // Session with null connectedClientId and old activity
    const nullClientSession = createFakeSession({
      id: 'null-client-1',
      connectedClientId: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, nullClientSession);

    const isClientConnected = vi.fn(() => true);
    manager.startIdleCheck(300_000, isClientConnected);

    await vi.advanceTimersByTimeAsync(60_000);

    // connectedClientId is null, so isClientConnected should not be called
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
    const stale1 = createFakeSession({
      id: 'stale-a',
      connectedClientId: null,
      lastActivity: now - 400_000,
    });
    const stale2 = createFakeSession({
      id: 'stale-b',
      connectedClientId: 'gone-client',
      lastActivity: now - 500_000,
    });
    const fresh = createFakeSession({
      id: 'fresh-a',
      connectedClientId: null,
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
    const session = createFakeSession({
      id: 'no-callback-1',
      connectedClientId: 'some-client',
      lastActivity: now - 400_000,
    });

    injectSession(manager, session);

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
    const session = createFakeSession({
      id: 'stop-test-1',
      connectedClientId: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, session);

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
    const session = createFakeSession({
      id: 'restart-1',
      connectedClientId: null,
      lastActivity: now - 400_000,
    });

    injectSession(manager, session);

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
