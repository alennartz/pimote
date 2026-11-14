import { describe, it, expect, vi } from 'vitest';

import { PimoteSessionManager } from './session-manager.js';
import type { ManagedSlot, SessionObserver } from './session-manager.js';
import type { PimoteConfig } from './config.js';
import type { PushNotificationService } from './push-notification.js';

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
    managerRoot: '/tmp/manager-root',
    idleTimeout: 300_000,
    bufferSize: 100,
    port: 3000,
    ...overrides,
  };
}

describe('applySessionReset — unchanged session (tree navigation)', () => {
  it('re-syncs the surface projection with the mutated branch', async () => {
    const manager = await PimoteSessionManager.create(createTestConfig(), createMockPushService());

    const id = 'nav-reset';
    const branchBeforeNavigation = [{ entryId: 'msg-old', role: 'user', text: 'intervening message' }];
    const branchAfterNavigation = [{ entryId: 'sum-new', role: 'assistant', text: 'branch summary' }];
    let nativeBranch = branchBeforeNavigation;

    const mockSession = {
      dispose: vi.fn(),
      bindExtensions: vi.fn(async () => {}),
      subscribe: () => () => {},
      messages: [],
      sessionId: id,
      sessionManager: { getBranch: () => nativeBranch },
    } as any;

    // Stand-in for the real session surface: snapshot() serves the cached
    // projection; refreshSnapshot() re-reads the native branch.
    let projection = [...branchBeforeNavigation];
    const surface = {
      snapshot: () => ({ messages: projection }),
      refreshSnapshot: () => {
        projection = nativeBranch.map((entry) => ({ ...entry }));
        return surface.snapshot();
      },
    };

    const sessionState = {
      id,
      eventBuffer: { replay: () => [], currentCursor: 0, onEvent: () => {}, invalidateReplay: vi.fn() } as any,
      status: 'idle' as const,
      needsAttention: false,
      idleSince: Date.now(),
      unsubscribe: vi.fn(),
      pendingUiResponses: new Map(),
      extensionsBound: false,
      sessionIdentity: mockSession,
      panelState: new Map(),
      downloads: [],
      panelListenerUnsubs: [],
      panelThrottleTimer: null,
      treeNavigationInProgress: false,
    };
    const slot: ManagedSlot = {
      runtime: { session: mockSession } as any,
      folderPath: '/home/user/project',
      eventBusRef: { current: null },
      observers: new Map(),
      sessionState: sessionState as any,
      sessionSurface: surface as any,
      get session() {
        return this.runtime.session;
      },
    };
    const sessions = (manager as any).sessions as Map<string, ManagedSlot>;
    sessions.set(id, slot);

    const resetOutcomes: string[] = [];
    const observer: SessionObserver = {
      ws: null as any,
      clientId: 'client-1',
      cursor: 0,
      onSessionReset: async (_s, outcome) => {
        resetOutcomes.push(outcome.kind);
      },
    };
    slot.observers.set(observer.clientId, observer);

    // navigateTree keeps the same AgentSession and mutates the branch without
    // emitting session events.
    nativeBranch = branchAfterNavigation;
    await manager.applySessionReset(slot);

    expect(resetOutcomes).toEqual(['unchanged']);
    expect(slot.sessionSurface!.snapshot().messages).toEqual(branchAfterNavigation);
  });
});
