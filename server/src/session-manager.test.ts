import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeDownloadSnapshot, PimoteSessionManager, routeSlotDownloadUpdate, setupSlotDownloadListener, singleFlight } from './session-manager.js';
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

function createFakeSlot(
  overrides: Partial<{
    id: string;
    folderPath: string;
    connection: ClientConnection | null;
    idleSince: number | null;
    status: 'idle' | 'working';
    needsAttention: boolean;
    unsubscribe: () => void;
    treeNavigationInProgress: boolean;
  }> = {},
): ManagedSlot {
  const id = overrides.id ?? 'test-session-' + Math.random().toString(36).slice(2, 8);
  const sessionState: SessionState = {
    id,
    eventBuffer: { replay: () => [], currentCursor: 0, onEvent: () => {} } as any,
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    idleSince: overrides.idleSince === undefined ? Date.now() : overrides.idleSince,
    unsubscribe: overrides.unsubscribe ?? vi.fn(),
    pendingUiResponses: new Map(),
    extensionsBound: false,
    panelState: new Map(),
    downloads: [],
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: overrides.treeNavigationInProgress ?? false,
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
      idleSince: now - 400_000, // 6.7 minutes ago (past 5-minute timeout)
    });

    injectSession(manager, staleSlot);

    manager.startIdleCheck(300_000); // 5 minutes

    // Advance past one check interval (60 seconds)
    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).toHaveBeenCalledWith('stale-1');

    manager.stopIdleCheck();
  });

  it('does NOT reap a working (streaming) session, no matter how stale', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    // A streaming session has idleSince === null. Even with no client and an arbitrarily
    // long-running turn, it must never be reaped — the agent is actively working.
    const workingSlot = createFakeSlot({
      id: 'working-1',
      connection: null,
      status: 'working',
      idleSince: null,
    });

    injectSession(manager, workingSlot);

    manager.startIdleCheck(300_000);

    // Burn through several check intervals to make sure it stays alive.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(closeSessionSpy).not.toHaveBeenCalled();

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
      idleSince: now - 60_000, // 1 minute ago (within 5-minute timeout)
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
      idleSince: now - 400_000, // old activity but client is connected
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
      idleSince: now - 400_000,
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
      idleSince: now - 400_000,
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

  it('does NOT reap stale sessions while tree navigation is in progress', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const navigatingSlot = createFakeSlot({
      id: 'navigating-1',
      connection: null,
      idleSince: now - 400_000,
      treeNavigationInProgress: true,
    });

    injectSession(manager, navigatingSlot);

    manager.startIdleCheck(300_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).not.toHaveBeenCalled();

    manager.stopIdleCheck();
  });

  it('reaps stale sessions after tree navigation completes', async () => {
    const config = createTestConfig();
    const manager = new PimoteSessionManager(config, createMockPushService());
    const closeSessionSpy = vi.spyOn(manager, 'closeSession');

    const now = Date.now();
    const navigatingSlot = createFakeSlot({
      id: 'navigating-2',
      connection: null,
      idleSince: now - 400_000,
      treeNavigationInProgress: true,
    });

    injectSession(manager, navigatingSlot);

    manager.startIdleCheck(300_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeSessionSpy).not.toHaveBeenCalled();

    navigatingSlot.sessionState.treeNavigationInProgress = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(closeSessionSpy).toHaveBeenCalledWith('navigating-2');

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
      idleSince: now - 400_000,
    });
    const stale2 = createFakeSlot({
      id: 'stale-b',
      connection: { ws: {} as any, connectedClientId: 'gone-client', onSessionReset: null },
      idleSince: now - 500_000,
    });
    const fresh = createFakeSlot({
      id: 'fresh-a',
      connection: null,
      idleSince: now - 100_000, // within timeout
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
      idleSince: now - 400_000,
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
      idleSince: now - 400_000,
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
      idleSince: now - 400_000,
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

describe('singleFlight', () => {
  it('coalesces concurrent calls with the same key into one run', async () => {
    const map = new Map<string, Promise<string>>();
    let runs = 0;
    let resolveFn!: (v: string) => void;
    const run = () => {
      runs++;
      return new Promise<string>((r) => {
        resolveFn = r;
      });
    };
    const p1 = singleFlight(map, 'k', run);
    const p2 = singleFlight(map, 'k', run);
    expect(runs).toBe(1); // second caller shares the in-flight promise
    resolveFn('done');
    expect(await p1).toBe('done');
    expect(await p2).toBe('done');
    // entry cleared after settle — a later call re-runs
    const p3 = singleFlight(map, 'k', run);
    expect(runs).toBe(2);
    resolveFn('again');
    expect(await p3).toBe('again');
  });

  it('runs independently for distinct keys', async () => {
    const map = new Map<string, Promise<string>>();
    let runs = 0;
    const run = (v: string) => () => {
      runs++;
      return Promise.resolve(v);
    };
    const [a, b] = await Promise.all([singleFlight(map, 'a', run('A')), singleFlight(map, 'b', run('B'))]);
    expect([a, b]).toEqual(['A', 'B']);
    expect(runs).toBe(2);
  });
});

describe('PimoteSessionManager — download delivery seam', () => {
  const older = { id: 'opaque-old', filename: 'old.txt', sizeBytes: 1, href: '/d/opaque-old' };
  const offered = { id: 'opaque-new', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-new' };

  it('subscribes the session state to the dedicated EventBus channel and routes its update', async () => {
    const on = vi.fn();
    const unsubscribe = vi.fn();
    const state = { downloads: [] as (typeof offered)[] };
    const send = vi.fn();
    const notify = vi.fn(async () => undefined);
    setupSlotDownloadListener(
      {
        on: ((type: 'pimote:downloads', listener: (update: unknown) => void | Promise<void>) => {
          on(type, listener);
          return unsubscribe;
        }) as any,
      },
      { sessionId: 'session-1', folderPath: '/workspace/project', state, send, notify },
    );

    expect(on).toHaveBeenCalledWith('pimote:downloads', expect.any(Function));
    const listener = on.mock.calls[0]?.[1] as (update: unknown) => void | Promise<void>;
    await listener({ type: 'download_update', sessionId: 'session-1', cause: 'offered', offeredDownloadId: offered.id, downloads: [offered] });

    expect(state.downloads).toEqual([offered]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'download_update', cause: 'offered' }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('builds a silent restored snapshot for recovery and viewed-session handoff', () => {
    expect(makeDownloadSnapshot('session-1', [older])).toEqual({
      type: 'download_update',
      sessionId: 'session-1',
      cause: 'restored',
      downloads: [older],
    });
  });

  it('replaces state, routes an offered full snapshot to the sole owner, and sends presentation-only push metadata', async () => {
    const state = { downloads: [] as (typeof offered)[] };
    const send = vi.fn();
    const notify = vi.fn(async () => undefined);
    const update = {
      type: 'download_update' as const,
      sessionId: 'session-1',
      cause: 'offered' as const,
      offeredDownloadId: offered.id,
      downloads: [older, offered],
    };

    await routeSlotDownloadUpdate(update, {
      sessionId: 'session-1',
      folderPath: '/workspace/project',
      sessionName: 'Report work',
      state,
      send,
      notify,
    });

    expect(state.downloads).toEqual([older, offered]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(update);
    expect(notify).toHaveBeenCalledWith({
      projectName: 'project',
      folderPath: '/workspace/project',
      sessionId: 'session-1',
      sessionName: 'Report work',
      reason: 'download',
      download: { downloadId: 'opaque-new', filename: 'report.pdf', sizeBytes: 42 },
    });
    expect(notify.mock.calls[0]?.[0]?.download).not.toHaveProperty('href');
  });

  it('routes silent snapshots without a duplicate push notification', async () => {
    const state = { downloads: [] as (typeof offered)[] };
    const send = vi.fn();
    const notify = vi.fn(async () => undefined);
    const update = { type: 'download_update' as const, sessionId: 'session-1', cause: 'consumed' as const, downloads: [older] };

    await routeSlotDownloadUpdate(update, {
      sessionId: 'session-1',
      folderPath: '/workspace/project',
      state,
      send,
      notify,
    });

    expect(state.downloads).toEqual([older]);
    expect(send).toHaveBeenCalledWith(update);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores an event for a different session instead of mutating or notifying the owner', async () => {
    const state = { downloads: [] as (typeof offered)[] };
    const send = vi.fn();
    const notify = vi.fn(async () => undefined);

    await routeSlotDownloadUpdate(
      {
        type: 'download_update',
        sessionId: 'other-session',
        cause: 'offered',
        offeredDownloadId: offered.id,
        downloads: [offered],
      },
      { sessionId: 'session-1', folderPath: '/workspace/project', state, send, notify },
    );

    expect(state.downloads).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('starts rebuilt session state without registrations from the prior session identity', () => {
    const manager = new PimoteSessionManager(createTestConfig(), createMockPushService());
    const slot = createFakeSlot({ id: 'old-session' });
    slot.sessionState.downloads = [offered];
    slot.eventBusRef.current = { on: vi.fn(() => () => {}), emit: vi.fn() } as any;
    (slot.runtime.session as any).sessionManager = { getCwd: () => '/home/user/replaced-project' };

    manager.rebuildSessionState(slot);

    expect(slot.sessionState.id).toBe('old-session');
    expect(slot.sessionState.downloads).toEqual([]);
  });
});

describe('PimoteSessionManager — openSession reuse (#5)', () => {
  it('returns the already-open session id without building a second runtime', async () => {
    const manager = new PimoteSessionManager(createTestConfig(), createMockPushService());
    const slot = createFakeSlot({ id: 'sess-x' });
    (slot.runtime.session as any).sessionFile = '/sessions/x.json';
    injectSession(manager, slot);
    // If the short-circuit failed, doOpenSession would try to build a real pi
    // runtime against a non-existent file and throw/hang.
    const id = await manager.openSession('/folder', '/sessions/x.json');
    expect(id).toBe('sess-x');
  });
});
