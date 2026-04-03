import { describe, it, expect } from 'vitest';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import type { PimoteSessionManager, ManagedSession } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import type { PushNotificationService } from './push-notification.js';
import type { EventBuffer } from './event-buffer.js';
import type { PimoteEvent, PimoteResponse, PimoteSessionEvent } from '@pimote/shared';

// --- Mock factories ---

function createMockEventBuffer(opts?: { replayResult?: PimoteSessionEvent[] | null }): EventBuffer {
  const events = opts?.replayResult;
  // Derive currentCursor from the highest cursor in the replay events
  const maxCursor = events && events.length > 0 ? Math.max(...events.map((e) => e.cursor)) : 0;
  return {
    replay: (fromCursor: number) => {
      if (events === null) return null;
      if (events === undefined) return [];
      // Filter to only events after fromCursor (matches real EventBuffer behavior)
      const filtered = events.filter((e) => e.cursor > fromCursor);
      return filtered;
    },
    currentCursor: maxCursor,
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
      clearQueue: () => ({ steering: [], followUp: [] }),
    } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',
    eventBuffer: overrides.eventBuffer ?? createMockEventBuffer(),
    connectedClientId: overrides.connectedClientId ?? null,
    lastActivity: overrides.lastActivity ?? Date.now(),
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    unsubscribe: overrides.unsubscribe ?? (() => {}),
    ws: overrides.ws ?? null,
    pendingUiResponses: overrides.pendingUiResponses ?? new Map(),
    extensionsBound: overrides.extensionsBound ?? false,
    onSessionReset: overrides.onSessionReset ?? null,
    panelState: overrides.panelState ?? new Map(),
    panelThrottleTimer: overrides.panelThrottleTimer ?? null,
    ...overrides,
  };
}

function createMockSessionManager(sessions: Map<string, ManagedSession> = new Map()): PimoteSessionManager {
  return {
    getSession: (id: string) => sessions.get(id),
    getAllSessions: () => Array.from(sessions.values()),
    openSession: async () => 'new-session-id',
    closeSession: async (id: string) => {
      sessions.delete(id);
    },
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
    notify: async () => {},
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

  const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, clientId, clientRegistry);

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

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'nonexistent-session',
          lastCursor: 0,
          id: 'req-1',
        }),
      );

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

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 4,
          id: 'req-2',
        }),
      );

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

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-3',
        }),
      );

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

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-4',
        }),
      );

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

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-5',
        }),
      );

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

      const ctx = createTestHandler('new-client', { sessions, clientRegistry });
      await ctx.handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-6',
        }),
      );

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
      const _oldCtx = createTestHandler('old-client', { sessions, clientRegistry });

      // Create new client's handler
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-7',
        }),
      );

      const resp = findResponse(newCtx.sent, 'req-7');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_owned');

      // Session ownership should NOT change
      expect(session.connectedClientId).toBe('old-client');
    });
  });

  describe('reconnect — different client ID, old client still connected, force: true (legacy)', () => {
    it('rejects with session_owned even with force (force removed from reconnect)', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const _oldCtx = createTestHandler('old-client', { sessions, clientRegistry });
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          force: true,
          id: 'req-8',
        }),
      );

      const resp = findResponse(newCtx.sent, 'req-8');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_owned');
      // Ownership unchanged
      expect(session.connectedClientId).toBe('old-client');
    });
  });

  describe('open_session — takeover of already-loaded session', () => {
    it('returns session_owned when session is loaded and owned by another client', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const _oldCtx = createTestHandler('old-client', { sessions, clientRegistry });
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          id: 'req-9',
        }),
      );

      const resp = findResponse(newCtx.sent, 'req-9');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_owned');
      expect(session.connectedClientId).toBe('old-client');
    });

    it('displaces old client and reclaims session with force: true', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'old-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const oldCtx = createTestHandler('old-client', { sessions, clientRegistry });
      const newCtx = createTestHandler('new-client', { sessions, clientRegistry });

      await newCtx.handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          force: true,
          id: 'req-10',
        }),
      );

      // New client gets success + session_opened
      const resp = findResponse(newCtx.sent, 'req-10');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connectedClientId).toBe('new-client');

      const openedEvents = findEvents(newCtx.sent, 'session_opened');
      expect(openedEvents).toHaveLength(1);
      expect((openedEvents[0] as any).sessionId).toBe('session-1');

      // Old client gets session_closed with displaced
      const oldClosedEvents = findEvents(oldCtx.sent, 'session_closed');
      expect(oldClosedEvents).toHaveLength(1);
      expect((oldClosedEvents[0] as any).sessionId).toBe('session-1');
      expect((oldClosedEvents[0] as any).reason).toBe('displaced');
    });

    it('reclaims session already owned by same client without displacement', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'my-client',
        folderPath: '/home/user/project',
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const ctx = createTestHandler('my-client', { sessions, clientRegistry });

      await ctx.handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          id: 'req-11-same',
        }),
      );

      const resp = findResponse(ctx.sent, 'req-11-same');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connectedClientId).toBe('my-client');

      // No displaced events
      const closedEvents = findEvents(ctx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(0);
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
      const newSessionId = 'new-session';
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

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          id: 'req-11',
        }),
      );

      // Should receive a session_conflict event with remoteSessions
      const conflicts = findEvents(sent, 'session_conflict');
      expect(conflicts.length).toBeGreaterThanOrEqual(1);

      // At least one conflict event should include remoteSessions
      const conflictWithRemote = conflicts.find((e: any) => e.remoteSessions && e.remoteSessions.length > 0);
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

      const newSessionId = 'new-session';
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

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          id: 'req-12',
        }),
      );

      // If there IS a session_conflict event, its remoteSessions should not include own-session
      const conflicts = findEvents(sent, 'session_conflict');
      for (const conflict of conflicts) {
        const remoteSessions = (conflict as any).remoteSessions ?? [];
        const ownInRemote = remoteSessions.find((rs: any) => rs.sessionId === 'own-session');
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
      const _otherCtx = createTestHandler('other-client', { sessions, clientRegistry });

      // Create the requesting client's handler
      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['target-session'],
          id: 'req-13',
        }),
      );

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

      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['target-session'],
          id: 'req-14',
        }),
      );

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

      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['session-a', 'session-b'],
          id: 'req-15',
        }),
      );

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
      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['orphaned-session'],
          id: 'req-16',
        }),
      );

      const resp = findResponse(myCtx.sent, 'req-16');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('ignores nonexistent session IDs without failing', async () => {
      const sessions = new Map<string, ManagedSession>();
      const clientRegistry: ClientRegistry = new Map();

      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['does-not-exist'],
          id: 'req-17',
        }),
      );

      const resp = findResponse(myCtx.sent, 'req-17');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });
  });

  describe('list_sessions — ownership enrichment', () => {
    it('annotates sessions with isOwnedByMe and liveStatus', async () => {
      // Two active pimote sessions in the same folder: one owned by me, one by another client
      const mySession = createMockManagedSession({
        id: 'my-session',
        connectedClientId: 'my-client',
        folderPath: '/home/user/project',
        status: 'working',
      });
      const otherSession = createMockManagedSession({
        id: 'other-session',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
        status: 'idle',
      });

      const sessions = new Map([
        ['my-session', mySession],
        ['other-session', otherSession],
      ]);

      // FolderIndex returns base session info (without ownership fields)
      const folderIndex = {
        scan: async () => [],
        listSessions: async (_folderPath: string) => [
          {
            id: 'file-session-a',
            name: undefined,
            created: '2025-01-01T00:00:00.000Z',
            modified: '2025-01-02T00:00:00.000Z',
            messageCount: 5,
            firstMessage: 'Hello',
          },
          {
            id: 'file-session-b',
            name: undefined,
            created: '2025-01-01T00:00:00.000Z',
            modified: '2025-01-02T00:00:00.000Z',
            messageCount: 3,
            firstMessage: undefined,
          },
        ],
      } as unknown as FolderIndex;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        folderIndex,
      });

      await handler.handleMessage(
        JSON.stringify({
          type: 'list_sessions',
          folderPath: '/home/user/project',
          id: 'req-list',
        }),
      );

      const resp = findResponse(sent, 'req-list');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);

      const listedSessions = (resp!.data as any).sessions;
      expect(listedSessions).toHaveLength(2);

      // Each listed session should have isOwnedByMe and liveStatus fields.
      // The enrichment cross-references file sessions with active managed sessions
      // by matching session IDs. These file sessions don't match active
      // sessions (different IDs), so they should report no ownership.
      for (const s of listedSessions) {
        expect(s).toHaveProperty('isOwnedByMe');
        expect(s).toHaveProperty('liveStatus');
      }
    });

    it('marks active sessions owned by requesting client with isOwnedByMe=true', async () => {
      // Active session owned by the requesting client — ID matches listed session
      const mySession = createMockManagedSession({
        id: 'session-a',
        connectedClientId: 'my-client',
        folderPath: '/home/user/project',
        status: 'working',
      });

      const sessions = new Map([['session-a', mySession]]);

      const folderIndex = {
        scan: async () => [],
        listSessions: async () => [
          {
            id: 'session-a',
            name: undefined,
            created: '2025-01-01T00:00:00.000Z',
            modified: '2025-01-02T00:00:00.000Z',
            messageCount: 5,
          },
        ],
      } as unknown as FolderIndex;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        folderIndex,
      });

      await handler.handleMessage(
        JSON.stringify({
          type: 'list_sessions',
          folderPath: '/home/user/project',
          id: 'req-list-mine',
        }),
      );

      const resp = findResponse(sent, 'req-list-mine');
      const listedSessions = (resp!.data as any).sessions;
      expect(listedSessions).toHaveLength(1);
      expect(listedSessions[0].isOwnedByMe).toBe(true);
      expect(listedSessions[0].liveStatus).toBe('working');
    });

    it('marks active sessions owned by another client with isOwnedByMe=false', async () => {
      const otherSession = createMockManagedSession({
        id: 'session-b',
        connectedClientId: 'other-client',
        folderPath: '/home/user/project',
        status: 'idle',
      });

      const sessions = new Map([['session-b', otherSession]]);

      const folderIndex = {
        scan: async () => [],
        listSessions: async () => [
          {
            id: 'session-b',
            name: undefined,
            created: '2025-01-01T00:00:00.000Z',
            modified: '2025-01-02T00:00:00.000Z',
            messageCount: 3,
          },
        ],
      } as unknown as FolderIndex;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        folderIndex,
      });

      await handler.handleMessage(
        JSON.stringify({
          type: 'list_sessions',
          folderPath: '/home/user/project',
          id: 'req-list-other',
        }),
      );

      const resp = findResponse(sent, 'req-list-other');
      const listedSessions = (resp!.data as any).sessions;
      expect(listedSessions).toHaveLength(1);
      expect(listedSessions[0].isOwnedByMe).toBe(false);
      expect(listedSessions[0].liveStatus).toBe('idle');
    });

    it('returns liveStatus=null for sessions that are not active in memory', async () => {
      // No active managed sessions
      const sessions = new Map<string, ManagedSession>();

      const folderIndex = {
        scan: async () => [],
        listSessions: async () => [
          {
            id: 'c',
            name: undefined,
            created: '2025-01-01T00:00:00.000Z',
            modified: '2025-01-02T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      } as unknown as FolderIndex;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        folderIndex,
      });

      await handler.handleMessage(
        JSON.stringify({
          type: 'list_sessions',
          folderPath: '/home/user/project',
          id: 'req-list-inactive',
        }),
      );

      const resp = findResponse(sent, 'req-list-inactive');
      const listedSessions = (resp!.data as any).sessions;
      expect(listedSessions).toHaveLength(1);
      expect(listedSessions[0].isOwnedByMe).toBe(false);
      expect(listedSessions[0].liveStatus).toBeNull();
    });
  });

  describe('reconnect — catch-up replay after claimSession', () => {
    it('sends catch-up events buffered between initial replay and claimSession', async () => {
      // Simulate events appearing in the buffer during claimSession (e.g. from
      // a pending select resolved by cleanup). The first replay returns the
      // initial set; the second replay (catch-up) returns the new events.
      let replayCallCount = 0;
      const initialEvents: PimoteSessionEvent[] = [
        { type: 'agent_start', sessionId: 'session-1', cursor: 1 },
        { type: 'tool_execution_start', sessionId: 'session-1', cursor: 2, toolName: 'ask_user', toolCallId: 'tc-1', args: {} },
      ];
      const catchUpEvents: PimoteSessionEvent[] = [{ type: 'tool_execution_end', sessionId: 'session-1', cursor: 3, toolCallId: 'tc-1', result: 'cancelled' }];

      const eventBuffer = {
        replay: (fromCursor: number) => {
          replayCallCount++;
          if (replayCallCount === 1) {
            // Initial replay — return events since client's lastCursor
            return initialEvents;
          }
          // Catch-up replay — return events buffered during claimSession
          return fromCursor >= 2 ? catchUpEvents : [...initialEvents, ...catchUpEvents];
        },
        currentCursor: 2, // will be updated by the test
        onEvent: () => {},
      } as unknown as EventBuffer;

      // Make currentCursor advance to 3 when claimSession reads it, simulating
      // an event buffered between the first replay and claimSession
      Object.defineProperty(eventBuffer, 'currentCursor', {
        get: () => (replayCallCount >= 1 ? 3 : 2),
      });

      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer,
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-catchup',
        }),
      );

      // Should have two buffered_events: initial replay + catch-up
      const bufferedEvents = findEvents(sent, 'buffered_events');
      expect(bufferedEvents).toHaveLength(2);

      // First batch: initial events
      expect((bufferedEvents[0] as any).events).toEqual(initialEvents);

      // Second batch: catch-up events (tool_execution_end that arrived during claimSession)
      expect((bufferedEvents[1] as any).events).toEqual(catchUpEvents);

      const resp = findResponse(sent, 'req-catchup');
      expect(resp!.success).toBe(true);
    });

    it('does not send catch-up when no new events were buffered', async () => {
      const bufferedEvents: PimoteSessionEvent[] = [{ type: 'agent_start', sessionId: 'session-1', cursor: 5 }];

      const eventBuffer = {
        replay: () => bufferedEvents,
        currentCursor: 5,
        onEvent: () => {},
      } as unknown as EventBuffer;

      // After first replay, catch-up replay returns empty (no new events)
      let callCount = 0;
      (eventBuffer as any).replay = (_fromCursor: number) => {
        callCount++;
        if (callCount === 1) return bufferedEvents;
        return []; // no catch-up events
      };

      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer,
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 4,
          id: 'req-no-catchup',
        }),
      );

      // Only ONE buffered_events (initial replay), no catch-up
      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(1);
    });

    it('skips catch-up when initial replay was full_resync', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: null }), // triggers full_resync
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-resync',
        }),
      );

      // full_resync, no buffered_events at all
      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);

      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(0);
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
      await handler.handleMessage(
        JSON.stringify({
          type: 'reconnect',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-cleanup',
        }),
      );

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
      await handler.handleMessage(
        JSON.stringify({
          type: 'view_session',
          sessionId: 'session-1',
          id: 'req-view',
        }),
      );

      expect(handler.getViewedSessionId()).toBe('session-1');

      handler.cleanup();

      expect(handler.getViewedSessionId()).toBeNull();
    });
  });

  describe('dequeue_steering', () => {
    it('responds with session not found when sessionId does not exist', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(
        JSON.stringify({
          type: 'dequeue_steering',
          sessionId: 'nonexistent',
          id: 'req-dequeue-1',
        }),
      );

      const resp = findResponse(sent, 'req-dequeue-1');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('not found');
    });

    it('responds with error when sessionId is missing', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(
        JSON.stringify({
          type: 'dequeue_steering',
          id: 'req-dequeue-2',
        }),
      );

      const resp = findResponse(sent, 'req-dequeue-2');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('sessionId');
    });

    it('returns empty arrays when no messages are queued', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'dequeue_steering',
          sessionId: 'session-1',
          id: 'req-dequeue-3',
        }),
      );

      const resp = findResponse(sent, 'req-dequeue-3');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(resp!.data).toEqual({ steering: [], followUp: [] });
    });

    it('returns queued steering and follow-up messages from clearQueue', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });
      // Override clearQueue to return pending messages
      (session.session as any).clearQueue = () => ({
        steering: ['fix the bug', 'also update tests'],
        followUp: ['then deploy'],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'dequeue_steering',
          sessionId: 'session-1',
          id: 'req-dequeue-4',
        }),
      );

      const resp = findResponse(sent, 'req-dequeue-4');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(resp!.data).toEqual({
        steering: ['fix the bug', 'also update tests'],
        followUp: ['then deploy'],
      });
    });
  });

  describe('handleSessionReset — session replacement via extension commands', () => {
    it('sends session_replaced and broadcasts sidebar updates when session ID changes', async () => {
      // Track the onSessionReset callback that claimSession passes to bindExtensions
      let capturedOnReset: (() => void) | undefined;
      const mockAgentSession = {
        sessionId: 'old-session',
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async (bindings: any) => {
          // Extract the onSessionReset from the commandContextActions' newSession wrapper.
          // createCommandContextActions wraps session.newSession and calls onSessionReset on success.
          // We capture it by introspecting the wrapper — but since we can't easily, we'll
          // capture the whole commandContextActions and call newSession ourselves.
          if (bindings.commandContextActions) {
            // Store a reference so we can simulate the reset
            capturedOnReset = async () => {
              // Simulate what happens: session.sessionId changes, then the callback fires
              mockAgentSession.sessionId = 'new-session';
              // Call newSession which triggers the onSessionReset callback
              await bindings.commandContextActions.newSession();
            };
            // Mock the session's newSession to just return true (success)
            mockAgentSession.newSession = async () => true;
          }
        },
        modelRegistry: { getAvailable: () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        newSession: async () => true,
      } as any;

      const managed = createMockManagedSession({
        id: 'old-session',
        session: mockAgentSession,
        folderPath: '/home/user/project',
        connectedClientId: null,
      });

      const sessions = new Map([['old-session', managed]]);
      const sessionManager = createMockSessionManager(sessions);

      // Mock detachSession and adoptSession
      (sessionManager as any).detachSession = (id: string) => {
        sessions.delete(id);
      };
      (sessionManager as any).adoptSession = (agentSess: any, folderPath: string) => {
        const newId = agentSess.sessionId;
        const newManaged = createMockManagedSession({
          id: newId,
          session: agentSess,
          folderPath,
          connectedClientId: null,
        });
        sessions.set(newId, newManaged);
        return newId;
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      // Open the session to trigger claimSession
      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'old-session',
          id: 'req-open',
        }),
      );

      // Clear sent messages so we only see the reset events
      sent.length = 0;

      // Trigger the session reset (simulates extension calling newSession)
      expect(capturedOnReset).toBeDefined();
      await capturedOnReset!();

      // Should have sent session_replaced event
      const replaced = findEvents(sent, 'session_replaced');
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as any).oldSessionId).toBe('old-session');
      expect((replaced[0] as any).newSessionId).toBe('new-session');
      expect((replaced[0] as any).folder.path).toBe('/home/user/project');

      // Should have broadcast session_state_changed for both old and new
      const stateChanges = findEvents(sent, 'session_state_changed');
      const oldChange = stateChanges.find((e: any) => e.sessionId === 'old-session');
      const newChange = stateChanges.find((e: any) => e.sessionId === 'new-session');
      expect(oldChange).toBeDefined();
      expect(newChange).toBeDefined();
      // Old session is no longer in the map, so liveStatus should be null
      expect((oldChange as any).liveStatus).toBeNull();

      // The old session should be removed from the map
      expect(sessions.has('old-session')).toBe(false);
      // The new session should be in the map
      expect(sessions.has('new-session')).toBe(true);
    });

    it('sends full_resync (not session_replaced) when session ID stays the same (navigateTree)', async () => {
      let capturedBindings: any;
      const mockAgentSession = {
        sessionId: 'same-session',
        subscribe: () => () => {},
        dispose: () => {},
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        model: { provider: 'test', id: 'test-model', name: 'Test' },
        thinkingLevel: 'default',
        isStreaming: false,
        isCompacting: false,
        sessionFile: '/tmp/session.json',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async (bindings: any) => {
          capturedBindings = bindings;
        },
        modelRegistry: { getAvailable: () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
      } as any;

      const managed = createMockManagedSession({
        id: 'same-session',
        session: mockAgentSession,
        folderPath: '/home/user/project',
        connectedClientId: null,
      });

      const sessions = new Map([['same-session', managed]]);
      const sessionManager = createMockSessionManager(sessions);

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'same-session',
          id: 'req-open',
        }),
      );

      sent.length = 0;

      // navigateTree doesn't change session ID — trigger the callback
      // sessionId stays 'same-session'
      await capturedBindings.commandContextActions.navigateTree('entry-123');

      // Should get full_resync, NOT session_replaced
      const replaced = findEvents(sent, 'session_replaced');
      expect(replaced).toHaveLength(0);

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('same-session');
    });
  });

  describe('get_commands', () => {
    function createSessionWithSources(opts: {
      skills?: Array<{ name: string; description: string }>;
      promptTemplates?: Array<{ name: string; description: string }>;
      extensionCommands?: Array<{
        name: string;
        description?: string;
        getArgumentCompletions?: (prefix: string) => any;
      }>;
    }) {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      // Add resourceLoader with skills
      (session.session as any).resourceLoader = {
        getSkills: () => ({
          skills: (opts.skills ?? []).map((s) => ({
            name: s.name,
            description: s.description,
            filePath: '/fake',
            baseDir: '/fake',
            source: 'test',
            disableModelInvocation: false,
          })),
          diagnostics: [],
        }),
      };

      // Add promptTemplates
      (session.session as any).promptTemplates = (opts.promptTemplates ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        content: '',
        source: 'test',
        filePath: '/fake',
      }));

      // Add extensionRunner
      if (opts.extensionCommands) {
        (session.session as any).extensionRunner = {
          getRegisteredCommands: () =>
            opts.extensionCommands!.map((cmd) => ({
              name: cmd.name,
              description: cmd.description,
              getArgumentCompletions: cmd.getArgumentCompletions,
              handler: async () => {},
            })),
          getCommand: (name: string) => {
            const found = opts.extensionCommands!.find((c) => c.name === name);
            if (!found) return undefined;
            return {
              name: found.name,
              description: found.description,
              getArgumentCompletions: found.getArgumentCompletions,
              handler: async () => {},
            };
          },
        };
      }

      return session;
    }

    it('returns empty commands when session has no skills, templates, or extension commands', async () => {
      const session = createSessionWithSources({});

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-1',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-1');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).commands).toEqual([
        { name: 'new', description: 'Start a new session', hasArgCompletions: false },
        { name: 'reload', description: 'Reload extensions and skills', hasArgCompletions: false },
      ]);
    });

    it('returns skills as "skill:<name>" commands with hasArgCompletions=false', async () => {
      const session = createSessionWithSources({
        skills: [
          { name: 'brainstorm', description: 'Brainstorm ideas' },
          { name: 'code-review', description: 'Review code' },
        ],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-2',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-2');
      const commands = (resp!.data as any).commands;
      expect(commands).toHaveLength(4);
      expect(commands[0]).toEqual({
        name: 'skill:brainstorm',
        description: 'Brainstorm ideas',
        hasArgCompletions: false,
      });
      expect(commands[1]).toEqual({
        name: 'skill:code-review',
        description: 'Review code',
        hasArgCompletions: false,
      });
      expect(commands[2]).toEqual({
        name: 'new',
        description: 'Start a new session',
        hasArgCompletions: false,
      });
      expect(commands[3]).toEqual({
        name: 'reload',
        description: 'Reload extensions and skills',
        hasArgCompletions: false,
      });
    });

    it('returns prompt templates as commands with hasArgCompletions=false', async () => {
      const session = createSessionWithSources({
        promptTemplates: [{ name: 'fix-bug', description: 'Fix a bug' }],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-3',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-3');
      const commands = (resp!.data as any).commands;
      expect(commands).toHaveLength(3);
      expect(commands[0]).toEqual({
        name: 'fix-bug',
        description: 'Fix a bug',
        hasArgCompletions: false,
      });
      expect(commands[1]).toEqual({
        name: 'new',
        description: 'Start a new session',
        hasArgCompletions: false,
      });
      expect(commands[2]).toEqual({
        name: 'reload',
        description: 'Reload extensions and skills',
        hasArgCompletions: false,
      });
    });

    it('returns extension commands with correct hasArgCompletions', async () => {
      const session = createSessionWithSources({
        extensionCommands: [
          { name: 'deploy', description: 'Deploy to production', getArgumentCompletions: () => [] },
          { name: 'reload', description: undefined },
        ],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-4',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-4');
      const commands = (resp!.data as any).commands;
      expect(commands).toHaveLength(4);
      expect(commands[0]).toEqual({
        name: 'deploy',
        description: 'Deploy to production',
        hasArgCompletions: true,
      });
      expect(commands[1]).toEqual({
        name: 'reload',
        description: '',
        hasArgCompletions: false,
      });
      expect(commands[2]).toEqual({
        name: 'new',
        description: 'Start a new session',
        hasArgCompletions: false,
      });
      expect(commands[3]).toEqual({
        name: 'reload',
        description: 'Reload extensions and skills',
        hasArgCompletions: false,
      });
    });

    it('combines all three sources in order: skills, templates, extension commands', async () => {
      const session = createSessionWithSources({
        skills: [{ name: 'brainstorm', description: 'Brainstorm' }],
        promptTemplates: [{ name: 'fix-bug', description: 'Fix a bug' }],
        extensionCommands: [{ name: 'deploy', description: 'Deploy' }],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-5',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-5');
      const commands = (resp!.data as any).commands;
      expect(commands).toHaveLength(5);
      expect(commands[0].name).toBe('skill:brainstorm');
      expect(commands[1].name).toBe('fix-bug');
      expect(commands[2].name).toBe('deploy');
      expect(commands[3].name).toBe('new');
      expect(commands[4].name).toBe('reload');
    });

    it('handles missing extensionRunner gracefully', async () => {
      const session = createSessionWithSources({
        skills: [{ name: 'test', description: 'Test' }],
      });
      // Explicitly remove extensionRunner
      (session.session as any).extensionRunner = undefined;

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'get_commands',
          sessionId: 'session-1',
          id: 'req-cmds-6',
        }),
      );

      const resp = findResponse(sent, 'req-cmds-6');
      expect(resp!.success).toBe(true);
      // Should still return the skill + built-in commands
      expect((resp!.data as any).commands).toHaveLength(3);
    });
  });

  describe('complete_args', () => {
    it('returns items from extension command with argument completions', async () => {
      const completionItems = [
        { value: 'staging', label: 'staging', description: 'Staging environment' },
        { value: 'production', label: 'production', description: 'Production environment' },
      ];

      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = {
        getRegisteredCommands: () => [],
        getCommand: (name: string) => {
          if (name === 'deploy') {
            return {
              name: 'deploy',
              description: 'Deploy',
              getArgumentCompletions: (prefix: string) => completionItems.filter((i) => i.value.startsWith(prefix)),
              handler: async () => {},
            };
          }
          return undefined;
        },
      };

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'deploy',
          prefix: 'sta',
          id: 'req-args-1',
        }),
      );

      const resp = findResponse(sent, 'req-args-1');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toEqual([{ value: 'staging', label: 'staging', description: 'Staging environment' }]);
    });

    it('returns null when command does not exist', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = {
        getRegisteredCommands: () => [],
        getCommand: () => undefined,
      };

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'nonexistent',
          prefix: '',
          id: 'req-args-2',
        }),
      );

      const resp = findResponse(sent, 'req-args-2');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('returns null when command exists but has no getArgumentCompletions', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = {
        getRegisteredCommands: () => [],
        getCommand: (name: string) => {
          if (name === 'reload') {
            return {
              name: 'reload',
              description: 'Reload',
              handler: async () => {},
              // no getArgumentCompletions
            };
          }
          return undefined;
        },
      };

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'reload',
          prefix: '',
          id: 'req-args-3',
        }),
      );

      const resp = findResponse(sent, 'req-args-3');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('returns null when extensionRunner is not available', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = undefined;

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'anything',
          prefix: '',
          id: 'req-args-4',
        }),
      );

      const resp = findResponse(sent, 'req-args-4');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('passes prefix through to getArgumentCompletions', async () => {
      let receivedPrefix: string | undefined;

      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = {
        getRegisteredCommands: () => [],
        getCommand: (name: string) => {
          if (name === 'deploy') {
            return {
              name: 'deploy',
              getArgumentCompletions: (prefix: string) => {
                receivedPrefix = prefix;
                return [];
              },
              handler: async () => {},
            };
          }
          return undefined;
        },
      };

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'deploy',
          prefix: 'prod',
          id: 'req-args-5',
        }),
      );

      expect(receivedPrefix).toBe('prod');
    });

    it('normalizes null return from getArgumentCompletions', async () => {
      const session = createMockManagedSession({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

      (session.session as any).resourceLoader = {
        getSkills: () => ({ skills: [], diagnostics: [] }),
      };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = {
        getRegisteredCommands: () => [],
        getCommand: (name: string) => {
          if (name === 'deploy') {
            return {
              name: 'deploy',
              getArgumentCompletions: () => null,
              handler: async () => {},
            };
          }
          return undefined;
        },
      };

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'complete_args',
          sessionId: 'session-1',
          commandName: 'deploy',
          prefix: '',
          id: 'req-args-6',
        }),
      );

      const resp = findResponse(sent, 'req-args-6');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });
  });
});
