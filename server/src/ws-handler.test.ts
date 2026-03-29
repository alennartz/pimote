import { describe, it, expect, beforeEach } from 'vitest';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import type { PimoteSessionManager, ManagedSession } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import type { PushNotificationService } from './push-notification.js';
import type { EventBuffer } from './event-buffer.js';
import type { PimoteEvent, PimoteResponse, PimoteSessionEvent } from '@pimote/shared';

// --- Mock factories ---

function createMockEventBuffer(opts?: { replayResult?: PimoteSessionEvent[] | null }): EventBuffer {
  return {
    replay: () => opts?.replayResult !== undefined ? opts.replayResult : [],
    currentCursor: 0,
    onEvent: () => {},
  } as unknown as EventBuffer;
}

function createMockManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: overrides.id ?? 'session-1',
    session: {
      subscribe: () => () => {},
      dispose: () => {},
      messages: [],
      model: null,
      thinkingLevel: 'default',
      isStreaming: false,
      isCompacting: false,
      sessionFile: undefined,
      sessionId: 'session-1',
      sessionName: undefined,
      autoCompactionEnabled: false,
      bindExtensions: async () => {},
      modelRegistry: { getAvailable: () => [] },
    } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',
    sessionFilePath: undefined,
    eventBuffer: overrides.eventBuffer ?? createMockEventBuffer(),
    connectedClientId: overrides.connectedClientId ?? null,
    lastActivity: overrides.lastActivity ?? Date.now(),
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    sendLive: overrides.sendLive ?? (() => {}),
    onStatusChange: overrides.onStatusChange ?? null,
    unsubscribe: overrides.unsubscribe ?? (() => {}),
    ...overrides,
  };
}

function createMockSessionManager(sessions: Map<string, ManagedSession> = new Map()): PimoteSessionManager {
  return {
    getSession: (id: string) => sessions.get(id),
    getAllSessions: () => Array.from(sessions.values()),
    openSession: async () => 'new-session-id',
    closeSession: async (id: string) => { sessions.delete(id); },
    startIdleCheck: () => {},
    stopIdleCheck: () => {},
    dispose: async () => {},
  } as unknown as PimoteSessionManager;
}

function createMockFolderIndex(): FolderIndex {
  return {
    scan: async () => [],
    listSessions: async () => [],
  } as unknown as FolderIndex;
}

function createMockWs(): { ws: any; sent: Array<PimoteEvent | PimoteResponse> } {
  const sent: Array<PimoteEvent | PimoteResponse> = [];
  const ws = {
    readyState: 1, // OPEN
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
  };
  return { ws, sent };
}

function createMockPushService(): PushNotificationService {
  return {
    notifySessionIdle: async () => {},
    initialize: async () => {},
    addSubscription: async () => {},
    removeSubscription: async () => {},
    getSubscriptions: () => [],
  } as unknown as PushNotificationService;
}

interface TestContext {
  handler: WsHandler;
  ws: any;
  sent: Array<PimoteEvent | PimoteResponse>;
  sessions: Map<string, ManagedSession>;
  sessionManager: PimoteSessionManager;
  clientRegistry: ClientRegistry;
}

function createTestHandler(
  clientId: string,
  opts?: {
    sessions?: Map<string, ManagedSession>;
    clientRegistry?: ClientRegistry;
    folderIndex?: FolderIndex;
  },
): TestContext {
  const sessions = opts?.sessions ?? new Map();
  const sessionManager = createMockSessionManager(sessions);
  const clientRegistry = opts?.clientRegistry ?? new Map();
  const { ws, sent } = createMockWs();
  const folderIndex = opts?.folderIndex ?? createMockFolderIndex();
  const pushService = createMockPushService();

  const handler = new WsHandler(
    sessionManager,
    folderIndex,
    ws,
    pushService,
    clientId,
    clientRegistry,
  );

  clientRegistry.set(clientId, handler);

  return { handler, ws, sent, sessions, sessionManager, clientRegistry };
}

// --- Helpers ---

function findResponse(sent: Array<any>, id: string): PimoteResponse | undefined {
  return sent.find((m) => 'id' in m && m.id === id);
}

function findEvents(sent: Array<any>, type: string): PimoteEvent[] {
  return sent.filter((m) => 'type' in m && m.type === type);
}

// --- Tests ---

describe('WsHandler', () => {
  describe('clientId', () => {
    it('exposes the clientId passed to constructor', () => {
      const { handler } = createTestHandler('client-abc');
      expect(handler.clientId).toBe('client-abc');
    });
  });

  describe('reconnect — session not found', () => {
    it('responds with session_expired when session does not exist', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'nonexistent-session',
        lastCursor: 0,
        id: 'req-1',
      }));

      const resp = findResponse(sent, 'req-1');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_expired');
    });
  });

  describe('reconnect — same client ID (normal reconnect)', () => {
    it('replays buffered events for incremental replay', async () => {
      const bufferedEvents: PimoteSessionEvent[] = [
        { type: 'agent_start', sessionId: 'session-1', cursor: 5 },
        { type: 'agent_end', sessionId: 'session-1', cursor: 6 },
      ];

      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: bufferedEvents }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 4,
        id: 'req-2',
      }));

      // Should get buffered_events, connection_restored, and success response
      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(1);
      expect((buffered[0] as any).events).toEqual(bufferedEvents);

      const restored = findEvents(sent, 'connection_restored');
      expect(restored).toHaveLength(1);

      const resp = findResponse(sent, 'req-2');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('sends full_resync when cursor is too old', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: null }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-3',
      }));

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('session-1');

      const resp = findResponse(sent, 'req-3');
      expect(resp!.success).toBe(true);
    });

    it('re-attaches connectedClientId to session', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: null, // was disconnected
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-4',
      }));

      expect(session.connectedClientId).toBe('client-1');
    });
  });

  describe('reconnect — different client ID, old client disconnected (silent rebind)', () => {
    it('allows reconnect when old client is not in registry', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client', // old client used to own it
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      // clientRegistry does NOT contain 'old-client' — they disconnected
      const clientRegistry: ClientRegistry = new Map();

      const { handler, sent } = createTestHandler('new-client', {
        sessions,
        clientRegistry,
      });

      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-5',
      }));

      const resp = findResponse(sent, 'req-5');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connectedClientId).toBe('new-client');
    });

    it('rebinds silently without sending displacement to anyone', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const { sent } = createTestHandler('new-client', {
        sessions,
        clientRegistry,
      });

      const ctx = createTestHandler('new-client', { sessions, clientRegistry });
      await ctx.handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-6',
      }));

      // No session_closed events should be sent
      const closedEvents = findEvents(ctx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(0);
    });
  });

  describe('reconnect — different client ID, old client still connected, no force', () => {
    it('responds with session_owned error', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      // Create old client's handler and register in registry
      const oldCtx = createTestHandler('old-client', { sessions, clientRegistry });

      // Create new client's handler
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-7',
      }));

      const resp = findResponse(newCtx.sent, 'req-7');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_owned');

      // Session ownership should NOT change
      expect(session.connectedClientId).toBe('old-client');
    });
  });

  describe('reconnect — different client ID, old client still connected, force: true', () => {
    it('rebinds ownership to new client', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      // Create old client handler (in registry)
      const oldCtx = createTestHandler('old-client', { sessions, clientRegistry });

      // Create new client handler
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        force: true,
        id: 'req-8',
      }));

      const resp = findResponse(newCtx.sent, 'req-8');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connectedClientId).toBe('new-client');
    });

    it('sends session_closed with reason displaced to old client', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      // Create old client handler (in registry)
      const oldCtx = createTestHandler('old-client', { sessions, clientRegistry });

      // Create new client handler
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        force: true,
        id: 'req-9',
      }));

      // Old client should receive session_closed with reason 'displaced'
      const oldClosedEvents = findEvents(oldCtx.sent, 'session_closed');
      expect(oldClosedEvents).toHaveLength(1);
      expect((oldClosedEvents[0] as any).sessionId).toBe('session-1');
      expect((oldClosedEvents[0] as any).reason).toBe('displaced');
    });

    it('does not send displaced event to new client', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const oldCtx = createTestHandler('old-client', { sessions, clientRegistry });
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        force: true,
        id: 'req-10',
      }));

      // New client should NOT get session_closed events
      const newClosedEvents = findEvents(newCtx.sent, 'session_closed');
      expect(newClosedEvents).toHaveLength(0);
    });
  });

  describe('open_session — remote session conflict detection', () => {
    it('includes remoteSessions in session_conflict when other pimote sessions exist in same folder', async () => {
      // Another pimote session already exists in the same folder, owned by different client
      const existingSession = createMockManagedSession({
        id: 'existing-session',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
        status: 'working',
      });

      const sessions = new Map([['existing-session', existingSession]]);
      const sessionManager = createMockSessionManager(sessions);

      // Mock openSession to add the new session and return its ID
      let newSessionId = 'new-session';
      (sessionManager as any).openSession = async (
        folderPath: string,
        sessionPath: string | undefined,
        sendLive: any,
        onStatusChange: any,
      ) => {
        const newSession = createMockManagedSession({
          id: newSessionId,
          folderPath,
          connectedClientId: null,
        });
        sessions.set(newSessionId, newSession);
        return newSessionId;
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(
        sessionManager,
        folderIndex,
        ws,
        pushService,
        'my-client',
        clientRegistry,
      );
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(JSON.stringify({
        type: 'open_session',
        folderPath: '/home/user/project',
        id: 'req-11',
      }));

      // Should receive a session_conflict event with remoteSessions
      const conflicts = findEvents(sent, 'session_conflict');
      expect(conflicts.length).toBeGreaterThanOrEqual(1);

      // At least one conflict event should include remoteSessions
      const conflictWithRemote = conflicts.find(
        (e: any) => e.remoteSessions && e.remoteSessions.length > 0,
      );
      expect(conflictWithRemote).toBeDefined();
      expect((conflictWithRemote as any).remoteSessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'existing-session',
            status: 'working',
          }),
        ]),
      );
    });

    it('does not include own sessions in remoteSessions', async () => {
      // Session owned by the same client
      const ownSession = createMockManagedSession({
        id: 'own-session',
        connectedClientId: 'my-client',
        folderPath: '/home/user/project',
        status: 'idle',
      });

      const sessions = new Map([['own-session', ownSession]]);
      const sessionManager = createMockSessionManager(sessions);

      let newSessionId = 'new-session';
      (sessionManager as any).openSession = async (folderPath: string) => {
        const newSession = createMockManagedSession({
          id: newSessionId,
          folderPath,
          connectedClientId: null,
        });
        sessions.set(newSessionId, newSession);
        return newSessionId;
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(
        sessionManager,
        folderIndex,
        ws,
        pushService,
        'my-client',
        clientRegistry,
      );
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(JSON.stringify({
        type: 'open_session',
        folderPath: '/home/user/project',
        id: 'req-12',
      }));

      // If there IS a session_conflict event, its remoteSessions should not include own-session
      const conflicts = findEvents(sent, 'session_conflict');
      for (const conflict of conflicts) {
        const remoteSessions = (conflict as any).remoteSessions ?? [];
        const ownInRemote = remoteSessions.find(
          (rs: any) => rs.sessionId === 'own-session',
        );
        expect(ownInRemote).toBeUndefined();
      }
    });
  });

  describe('kill_conflicting_sessions', () => {
    it('closes specified sessions and responds with success', async () => {
      const targetSession = createMockManagedSession({
        id: 'target-session',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['target-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      // Create the other client's handler so we can check it receives session_closed
      const otherCtx = createTestHandler('other-client', { sessions, clientRegistry });

      // Create the requesting client's handler
      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(JSON.stringify({
        type: 'kill_conflicting_sessions',
        sessionIds: ['target-session'],
        id: 'req-13',
      }));

      const resp = findResponse(myCtx.sent, 'req-13');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('sends session_closed with reason killed to owning client', async () => {
      const targetSession = createMockManagedSession({
        id: 'target-session',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['target-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      // Create the other client's handler
      const otherCtx = createTestHandler('other-client', { sessions, clientRegistry });

      // Create the requesting client's handler
      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(JSON.stringify({
        type: 'kill_conflicting_sessions',
        sessionIds: ['target-session'],
        id: 'req-14',
      }));

      // Other client should receive session_closed with reason 'killed'
      const closedEvents = findEvents(otherCtx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(1);
      expect((closedEvents[0] as any).sessionId).toBe('target-session');
      expect((closedEvents[0] as any).reason).toBe('killed');
    });

    it('closes multiple sessions at once', async () => {
      const session1 = createMockManagedSession({
        id: 'session-a',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
      });
      const session2 = createMockManagedSession({
        id: 'session-b',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([
        ['session-a', session1],
        ['session-b', session2],
      ]);
      const clientRegistry: ClientRegistry = new Map();

      const otherCtx = createTestHandler('other-client', { sessions, clientRegistry });
      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(JSON.stringify({
        type: 'kill_conflicting_sessions',
        sessionIds: ['session-a', 'session-b'],
        id: 'req-15',
      }));

      const resp = findResponse(myCtx.sent, 'req-15');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);

      // Other client should get two session_closed events
      const closedEvents = findEvents(otherCtx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(2);

      const closedSessionIds = closedEvents.map((e: any) => e.sessionId).sort();
      expect(closedSessionIds).toEqual(['session-a', 'session-b']);

      for (const event of closedEvents) {
        expect((event as any).reason).toBe('killed');
      }
    });

    it('handles killing sessions whose client is no longer connected', async () => {
      const targetSession = createMockManagedSession({
        id: 'orphaned-session',
        connectedClientId: 'gone-client', // not in registry
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['orphaned-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      // Should not throw — gracefully handles missing client
      await myCtx.handler.handleMessage(JSON.stringify({
        type: 'kill_conflicting_sessions',
        sessionIds: ['orphaned-session'],
        id: 'req-16',
      }));

      const resp = findResponse(myCtx.sent, 'req-16');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('ignores nonexistent session IDs without failing', async () => {
      const sessions = new Map<string, ManagedSession>();
      const clientRegistry: ClientRegistry = new Map();

      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(JSON.stringify({
        type: 'kill_conflicting_sessions',
        sessionIds: ['does-not-exist'],
        id: 'req-17',
      }));

      const resp = findResponse(myCtx.sent, 'req-17');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('sets connectedClientId to null on managed sessions', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      // Subscribe to the session by reconnecting
      await handler.handleMessage(JSON.stringify({
        type: 'reconnect',
        sessionId: 'session-1',
        lastCursor: 0,
        id: 'req-cleanup',
      }));

      expect(session.connectedClientId).toBe('client-1');

      handler.cleanup();

      expect(session.connectedClientId).toBeNull();
    });

    it('clears viewedSessionId', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      // Set viewedSessionId via view_session command
      await handler.handleMessage(JSON.stringify({
        type: 'view_session',
        sessionId: 'session-1',
        id: 'req-view',
      }));

      expect(handler.getViewedSessionId()).toBe('session-1');

      handler.cleanup();

      expect(handler.getViewedSessionId()).toBeNull();
    });
  });
});
