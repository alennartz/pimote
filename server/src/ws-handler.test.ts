import { describe, it, expect, vi } from 'vitest';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import type { PimoteSessionManager, ManagedSlot, SessionState, ClientConnection } from './session-manager.js';
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

function createMockSlot(
  overrides: Partial<{
    id: string;
    folderPath: string;
    connectedClientId: string | null;
    lastActivity: number;
    status: 'idle' | 'working';
    needsAttention: boolean;
    unsubscribe: () => void;
    eventBuffer: EventBuffer;
    extensionsBound: boolean;
    session: any;
    panelState: Map<string, any>;
  }> = {},
): ManagedSlot {
  const id = overrides.id ?? 'session-1';
  const mockSession = overrides.session ?? {
    subscribe: () => () => {},
    dispose: () => {},
    messages: [],
    model: null,
    thinkingLevel: 'default',
    isStreaming: false,
    isCompacting: false,
    sessionFile: undefined,
    sessionId: id,
    sessionName: undefined,
    autoCompactionEnabled: false,
    bindExtensions: async () => {},
    modelRegistry: { getAvailable: () => [] },
    clearQueue: () => ({ steering: [], followUp: [] }),
  };

  const sessionState: SessionState = {
    id,
    eventBuffer: overrides.eventBuffer ?? createMockEventBuffer(),
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    lastActivity: overrides.lastActivity ?? Date.now(),
    unsubscribe: overrides.unsubscribe ?? (() => {}),
    pendingUiResponses: new Map(),
    extensionsBound: overrides.extensionsBound ?? false,
    panelState: overrides.panelState ?? new Map(),
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
  };

  const connection: ClientConnection | null =
    overrides.connectedClientId != null ? { ws: null as any, connectedClientId: overrides.connectedClientId, onSessionReset: null } : null;

  const slot: ManagedSlot = {
    runtime: { session: mockSession } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',
    eventBusRef: { current: null },
    connection,
    sessionState,
    get session() {
      return this.runtime.session;
    },
  };

  return slot;
}

function createMockSessionManager(sessions: Map<string, ManagedSlot> = new Map()): PimoteSessionManager {
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
    rebuildSessionState: () => {},
    reKeySession: (slot: ManagedSlot, oldId: string, newId: string) => {
      sessions.delete(oldId);
      sessions.set(newId, slot);
    },
  } as unknown as PimoteSessionManager;
}

function createMockFolderIndex(): FolderIndex {
  return {
    scan: async () => [],
    listSessions: async () => [],
    listSessionRecords: async () => [],
    resolveSessionPath: async () => undefined,
    renameSession: async () => false,
    deleteSession: async () => false,
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

function createMockSessionMetadataStore(initialArchived: string[] = []) {
  const archived = new Set(initialArchived);
  return {
    get: (path: string) => (archived.has(path) ? { archived: true, archivedAt: '2026-04-05T00:00:00.000Z' } : undefined),
    isArchived: (path: string) => archived.has(path),
    getArchivedLookup: (paths: string[]) => new Map(paths.map((path) => [path, archived.has(path)])),
    setArchived: async (path: string, next: boolean) => {
      if (next) archived.add(path);
      else archived.delete(path);
    },
    delete: async (path: string) => {
      archived.delete(path);
    },
  };
}

interface TestContext {
  handler: WsHandler;
  ws: any;
  sent: Array<PimoteEvent | PimoteResponse>;
  sessions: Map<string, ManagedSlot>;
  sessionManager: PimoteSessionManager;
  clientRegistry: ClientRegistry;
  sessionMetadataStore: ReturnType<typeof createMockSessionMetadataStore>;
}

function createTestHandler(
  clientId: string,
  opts?: {
    sessions?: Map<string, ManagedSlot>;
    clientRegistry?: ClientRegistry;
    folderIndex?: FolderIndex;
    sessionMetadataStore?: ReturnType<typeof createMockSessionMetadataStore>;
  },
): TestContext {
  const sessions = opts?.sessions ?? new Map();
  const sessionManager = createMockSessionManager(sessions);
  const clientRegistry = opts?.clientRegistry ?? new Map();
  const { ws, sent } = createMockWs();
  const folderIndex = opts?.folderIndex ?? createMockFolderIndex();
  const pushService = createMockPushService();
  const sessionMetadataStore = opts?.sessionMetadataStore ?? createMockSessionMetadataStore();

  const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, sessionMetadataStore as any, clientId, clientRegistry);

  clientRegistry.set(clientId, handler);

  return { handler, ws, sent, sessions, sessionManager, clientRegistry, sessionMetadataStore };
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

  describe('open_session — existing session missing', () => {
    it('responds with session_expired when session does not exist in memory or on disk', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'nonexistent-session',
          id: 'req-1',
        }),
      );

      const resp = findResponse(sent, 'req-1');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_expired');
    });
  });

  describe('open_session — same client ID (live restore)', () => {
    it('replays buffered events for incremental replay when lastCursor is provided', async () => {
      const bufferedEvents: PimoteSessionEvent[] = [
        { type: 'agent_start', sessionId: 'session-1', cursor: 5 },
        { type: 'agent_end', sessionId: 'session-1', cursor: 6 },
      ];

      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: bufferedEvents }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 4,
          id: 'req-2',
        }),
      );

      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(1);
      expect((buffered[0] as any).events).toEqual(bufferedEvents);

      const restored = findEvents(sent, 'connection_restored');
      expect(restored).toHaveLength(1);

      const resp = findResponse(sent, 'req-2');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('sends full_resync when lastCursor is omitted', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          id: 'req-3',
        }),
      );

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('session-1');

      const resp = findResponse(sent, 'req-3');
      expect(resp!.success).toBe(true);
    });

    it('sends full_resync when cursor is too old', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: null }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-4',
        }),
      );

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('session-1');

      const resp = findResponse(sent, 'req-4');
      expect(resp!.success).toBe(true);
    });

    it('re-attaches connection to session', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: null,
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-5',
        }),
      );

      expect(session.connection?.connectedClientId).toBe('client-1');
    });
  });

  describe('open_session — different client ID, old client disconnected (silent rebind)', () => {
    it('allows opening when old client is not in registry', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const { handler, sent } = createTestHandler('new-client', {
        sessions,
        clientRegistry,
      });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-6',
        }),
      );

      const resp = findResponse(sent, 'req-6');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connection?.connectedClientId).toBe('new-client');
    });

    it('rebinds silently without sending displacement to anyone', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'old-client',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const clientRegistry: ClientRegistry = new Map();

      const ctx = createTestHandler('new-client', { sessions, clientRegistry });
      await ctx.handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-7',
        }),
      );

      const closedEvents = findEvents(ctx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(0);
    });
  });

  describe('open_session — different client ID, old client still connected, no force', () => {
    it('responds with session_owned error', async () => {
      const session = createMockSlot({
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
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-8',
        }),
      );

      const resp = findResponse(newCtx.sent, 'req-8');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_owned');
      expect(session.connection?.connectedClientId).toBe('old-client');
    });
  });

  describe('open_session — takeover of already-loaded session', () => {
    it('returns session_owned when session is loaded and owned by another client', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'old-client',
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
      expect(session.connection?.connectedClientId).toBe('old-client');
    });

    it('displaces old client and reclaims session with force: true', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'old-client',
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

      const resp = findResponse(newCtx.sent, 'req-10');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect(session.connection?.connectedClientId).toBe('new-client');

      const resync = findEvents(newCtx.sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('session-1');

      // Old client gets session_closed with displaced
      const oldClosedEvents = findEvents(oldCtx.sent, 'session_closed');
      expect(oldClosedEvents).toHaveLength(1);
      expect((oldClosedEvents[0] as any).sessionId).toBe('session-1');
      expect((oldClosedEvents[0] as any).reason).toBe('displaced');
    });

    it('reclaims session already owned by same client without displacement', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'my-client',
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
      expect(session.connection?.connectedClientId).toBe('my-client');

      // No displaced events
      const closedEvents = findEvents(ctx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(0);
    });
  });

  describe('open_session — disk-backed reopen', () => {
    it('loads a persisted session from disk and sends full_resync when it is not live in memory', async () => {
      const sessions = new Map<string, ManagedSlot>();
      const sessionManager = createMockSessionManager(sessions);
      const reopenedSessionId = 'session-1';

      (sessionManager as any).openSession = async (folderPath: string, sessionFilePath?: string) => {
        expect(folderPath).toBe('/home/user/project');
        expect(sessionFilePath).toBe('/tmp/session-1.jsonl');
        const reopened = createMockSlot({
          id: reopenedSessionId,
          session: {
            subscribe: () => () => {},
            dispose: () => {},
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            model: null,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            sessionFile: sessionFilePath,
            sessionId: reopenedSessionId,
            sessionName: undefined,
            autoCompactionEnabled: false,
            bindExtensions: async () => {},
            modelRegistry: { getAvailable: () => [] },
            clearQueue: () => ({ steering: [], followUp: [] }),
          } as any,
        });
        sessions.set(reopenedSessionId, reopened);
        return reopenedSessionId;
      };

      const folderIndex = {
        ...createMockFolderIndex(),
        resolveSessionPath: async (_folderPath: string, sessionId: string) => (sessionId === reopenedSessionId ? '/tmp/session-1.jsonl' : undefined),
      } as FolderIndex;

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const pushService = createMockPushService();
      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: reopenedSessionId,
          id: 'req-disk-reopen',
        }),
      );

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe(reopenedSessionId);

      const resp = findResponse(sent, 'req-disk-reopen');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).sessionId).toBe(reopenedSessionId);
    });
  });

  describe('open_session — remote session conflict detection', () => {
    it('includes remoteSessions in session_conflict when other pimote sessions exist in same folder', async () => {
      const existingSession = createMockSlot({
        id: 'existing-session',
        connectedClientId: 'other-client',
        status: 'working',
      });

      const sessions = new Map([['existing-session', existingSession]]);
      const sessionManager = createMockSessionManager(sessions);

      const newSessionId = 'new-session';
      (sessionManager as any).openSession = async (_folderPath: string) => {
        const newSession = createMockSlot({
          id: newSessionId,
          connectedClientId: null,
        });
        sessions.set(newSessionId, newSession);
        return newSessionId;
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          id: 'req-11',
        }),
      );

      const conflicts = findEvents(sent, 'session_conflict');
      expect(conflicts.length).toBeGreaterThanOrEqual(1);

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
      const ownSession = createMockSlot({
        id: 'own-session',
        connectedClientId: 'my-client',
        status: 'idle',
      });

      const sessions = new Map([['own-session', ownSession]]);
      const sessionManager = createMockSessionManager(sessions);

      const newSessionId = 'new-session';
      (sessionManager as any).openSession = async (_folderPath: string) => {
        const newSession = createMockSlot({
          id: newSessionId,
          connectedClientId: null,
        });
        sessions.set(newSessionId, newSession);
        return newSessionId;
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          id: 'req-12',
        }),
      );

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
      const targetSession = createMockSlot({
        id: 'target-session',
        connectedClientId: 'other-client',
      });

      const sessions = new Map([['target-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      const _otherCtx = createTestHandler('other-client', { sessions, clientRegistry });
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
      const targetSession = createMockSlot({
        id: 'target-session',
        connectedClientId: 'other-client',
      });

      const sessions = new Map([['target-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      const otherCtx = createTestHandler('other-client', { sessions, clientRegistry });
      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

      await myCtx.handler.handleMessage(
        JSON.stringify({
          type: 'kill_conflicting_sessions',
          sessionIds: ['target-session'],
          id: 'req-14',
        }),
      );

      const closedEvents = findEvents(otherCtx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(1);
      expect((closedEvents[0] as any).sessionId).toBe('target-session');
      expect((closedEvents[0] as any).reason).toBe('killed');
    });

    it('closes multiple sessions at once', async () => {
      const session1 = createMockSlot({
        id: 'session-a',
        connectedClientId: 'other-client',
      });
      const session2 = createMockSlot({
        id: 'session-b',
        connectedClientId: 'other-client',
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

      const closedEvents = findEvents(otherCtx.sent, 'session_closed');
      expect(closedEvents).toHaveLength(2);

      const closedSessionIds = closedEvents.map((e: any) => e.sessionId).sort();
      expect(closedSessionIds).toEqual(['session-a', 'session-b']);

      for (const event of closedEvents) {
        expect((event as any).reason).toBe('killed');
      }
    });

    it('handles killing sessions whose client is no longer connected', async () => {
      const targetSession = createMockSlot({
        id: 'orphaned-session',
        connectedClientId: 'gone-client',
      });

      const sessions = new Map([['orphaned-session', targetSession]]);
      const clientRegistry: ClientRegistry = new Map();

      const myCtx = createTestHandler('my-client', { sessions, clientRegistry });

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
      const sessions = new Map<string, ManagedSlot>();
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
      const mySession = createMockSlot({
        id: 'my-session',
        connectedClientId: 'my-client',
        status: 'working',
      });
      const otherSession = createMockSlot({
        id: 'other-session',
        connectedClientId: 'other-client',
        status: 'idle',
      });

      const sessions = new Map([
        ['my-session', mySession],
        ['other-session', otherSession],
      ]);

      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async (_folderPath: string) => [
          {
            path: '/tmp/file-session-a.jsonl',
            id: 'file-session-a',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 5,
            firstMessage: 'Hello',
            allMessagesText: 'Hello',
          },
          {
            path: '/tmp/file-session-b.jsonl',
            id: 'file-session-b',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 3,
            firstMessage: '',
            allMessagesText: '',
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
      // 2 from folder index + 2 active in-memory (different IDs) = 4
      expect(listedSessions).toHaveLength(4);

      for (const s of listedSessions) {
        expect(s).toHaveProperty('isOwnedByMe');
        expect(s).toHaveProperty('liveStatus');
      }
    });

    it('marks active sessions owned by requesting client with isOwnedByMe=true', async () => {
      const mySession = createMockSlot({
        id: 'session-a',
        connectedClientId: 'my-client',
        status: 'working',
      });

      const sessions = new Map([['session-a', mySession]]);

      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async () => [
          {
            path: '/tmp/session-a.jsonl',
            id: 'session-a',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 5,
            firstMessage: '',
            allMessagesText: '',
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
      const otherSession = createMockSlot({
        id: 'session-b',
        connectedClientId: 'other-client',
        status: 'idle',
      });

      const sessions = new Map([['session-b', otherSession]]);

      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async () => [
          {
            path: '/tmp/session-b.jsonl',
            id: 'session-b',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 3,
            firstMessage: '',
            allMessagesText: '',
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
      const sessions = new Map<string, ManagedSlot>();

      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async () => [
          {
            path: '/tmp/c.jsonl',
            id: 'c',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 1,
            firstMessage: '',
            allMessagesText: '',
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

  describe('archive_session and archived listings', () => {
    it('hides archived sessions from list_sessions by default', async () => {
      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async () => [
          {
            path: '/tmp/visible.jsonl',
            id: 'visible',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 1,
            firstMessage: '',
            allMessagesText: '',
          },
          {
            path: '/tmp/archived.jsonl',
            id: 'archived',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 2,
            firstMessage: '',
            allMessagesText: '',
          },
        ],
      } as unknown as FolderIndex;

      const { handler, sent } = createTestHandler('client-1', {
        folderIndex,
        sessionMetadataStore: createMockSessionMetadataStore(['/tmp/archived.jsonl']),
      });

      await handler.handleMessage(JSON.stringify({ type: 'list_sessions', folderPath: '/home/user/project', id: 'req-archived-default' }));

      expect((findResponse(sent, 'req-archived-default')!.data as any).sessions).toEqual([expect.objectContaining({ id: 'visible', archived: false })]);
    });

    it('includes archived sessions when includeArchived=true', async () => {
      const folderIndex = {
        scan: async () => [],
        listSessionRecords: async () => [
          {
            path: '/tmp/archived.jsonl',
            id: 'archived',
            cwd: '/home/user/project',
            name: undefined,
            created: new Date('2025-01-01T00:00:00.000Z'),
            modified: new Date('2025-01-02T00:00:00.000Z'),
            messageCount: 2,
            firstMessage: '',
            allMessagesText: '',
          },
        ],
      } as unknown as FolderIndex;

      const { handler, sent } = createTestHandler('client-1', {
        folderIndex,
        sessionMetadataStore: createMockSessionMetadataStore(['/tmp/archived.jsonl']),
      });

      await handler.handleMessage(JSON.stringify({ type: 'list_sessions', folderPath: '/home/user/project', includeArchived: true, id: 'req-archived-all' }));

      expect((findResponse(sent, 'req-archived-all')!.data as any).sessions).toEqual([expect.objectContaining({ id: 'archived', archived: true })]);
    });

    it('archives a session and broadcasts session_archived', async () => {
      const folderIndex = {
        ...createMockFolderIndex(),
        resolveSessionPath: async () => '/tmp/archive-me.jsonl',
      } as unknown as FolderIndex;
      const sessionMetadataStore = createMockSessionMetadataStore();
      const { handler, sent } = createTestHandler('client-1', { folderIndex, sessionMetadataStore });

      await handler.handleMessage(JSON.stringify({ type: 'archive_session', folderPath: '/home/user/project', sessionIds: ['archive-me'], archived: true, id: 'req-archive' }));

      expect(sessionMetadataStore.isArchived('/tmp/archive-me.jsonl')).toBe(true);
      expect(findEvents(sent, 'session_archived')).toEqual([
        {
          type: 'session_archived',
          sessionId: 'archive-me',
          folderPath: '/home/user/project',
          archived: true,
        },
      ]);
    });

    it('unarchives a persisted session when it is reopened', async () => {
      const reopenedSessionId = 'archived-session';
      const sessionPath = '/tmp/archived-session.jsonl';
      const sessions = new Map<string, ManagedSlot>();
      const sessionManager = createMockSessionManager(sessions);
      (sessionManager as any).openSession = async (_folderPath: string, sessionFilePath?: string) => {
        const reopened = createMockSlot({
          id: reopenedSessionId,
          session: {
            subscribe: () => () => {},
            dispose: () => {},
            messages: [],
            model: null,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            sessionFile: sessionFilePath,
            sessionId: reopenedSessionId,
            sessionName: undefined,
            autoCompactionEnabled: false,
            bindExtensions: async () => {},
            modelRegistry: { getAvailable: () => [] },
            clearQueue: () => ({ steering: [], followUp: [] }),
          } as any,
        });
        sessions.set(reopenedSessionId, reopened);
        return reopenedSessionId;
      };

      const folderIndex = {
        ...createMockFolderIndex(),
        resolveSessionPath: async () => sessionPath,
      } as unknown as FolderIndex;
      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const pushService = createMockPushService();
      const sessionMetadataStore = createMockSessionMetadataStore([sessionPath]);
      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, sessionMetadataStore as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/project', sessionId: reopenedSessionId, id: 'req-open-archived' }));

      expect(sessionMetadataStore.isArchived(sessionPath)).toBe(false);
      expect(findEvents(sent, 'session_archived')).toEqual([
        {
          type: 'session_archived',
          sessionId: reopenedSessionId,
          folderPath: '/home/user/project',
          archived: false,
        },
      ]);
    });
  });

  describe('open_session — catch-up replay after claimSession', () => {
    it('sends catch-up events buffered between initial replay and claimSession', async () => {
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
            return initialEvents;
          }
          return fromCursor >= 2 ? catchUpEvents : [...initialEvents, ...catchUpEvents];
        },
        currentCursor: 2,
        onEvent: () => {},
      } as unknown as EventBuffer;

      Object.defineProperty(eventBuffer, 'currentCursor', {
        get: () => (replayCallCount >= 1 ? 3 : 2),
      });

      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer,
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-catchup',
        }),
      );

      const bufferedEvents = findEvents(sent, 'buffered_events');
      expect(bufferedEvents).toHaveLength(2);

      expect((bufferedEvents[0] as any).events).toEqual(initialEvents);
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

      let callCount = 0;
      (eventBuffer as any).replay = (_fromCursor: number) => {
        callCount++;
        if (callCount === 1) return bufferedEvents;
        return [];
      };

      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer,
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 4,
          id: 'req-no-catchup',
        }),
      );

      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(1);
    });

    it('skips catch-up when initial replay was full_resync', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: null }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-resync',
        }),
      );

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);

      const buffered = findEvents(sent, 'buffered_events');
      expect(buffered).toHaveLength(0);
    });
  });

  describe('cleanup', () => {
    it('sets connection to null on managed slots', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          lastCursor: 0,
          id: 'req-cleanup',
        }),
      );

      expect(session.connection?.connectedClientId).toBe('client-1');

      handler.cleanup();

      expect(session.connection).toBeNull();
    });

    it('clears viewedSessionId', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
      });

      const sessions = new Map([['session-1', session]]);
      const { handler } = createTestHandler('client-1', { sessions });

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
      const session = createMockSlot({
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
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
      });
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
          if (bindings.commandContextActions) {
            capturedOnReset = async () => {
              mockAgentSession.sessionId = 'new-session';
              await bindings.commandContextActions.newSession();
            };
          }
        },
        modelRegistry: { getAvailable: () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
      } as any;

      const slot = createMockSlot({
        id: 'old-session',
        session: mockAgentSession,
        connectedClientId: null,
      });
      // Wire the runtime to support newSession
      (slot.runtime as any).newSession = async () => {
        mockAgentSession.sessionId = 'new-session';
        return { cancelled: false };
      };

      const sessions = new Map([['old-session', slot]]);
      const sessionManager = createMockSessionManager(sessions);

      // Mock rebuildSessionState — just update the session state ID
      (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
        s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'old-session',
          id: 'req-open',
        }),
      );

      sent.length = 0;

      expect(capturedOnReset).toBeDefined();
      await capturedOnReset!();

      const replaced = findEvents(sent, 'session_replaced');
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as any).oldSessionId).toBe('old-session');
      expect((replaced[0] as any).newSessionId).toBe('new-session');
      expect((replaced[0] as any).folder.path).toBe('/home/user/project');

      const stateChanges = findEvents(sent, 'session_state_changed');
      const oldChange = stateChanges.find((e: any) => e.sessionId === 'old-session');
      const newChange = stateChanges.find((e: any) => e.sessionId === 'new-session');
      expect(oldChange).toBeDefined();
      expect(newChange).toBeDefined();
      expect((oldChange as any).liveStatus).toBeNull();

      expect(sessions.has('old-session')).toBe(false);
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

      const slot = createMockSlot({
        id: 'same-session',
        session: mockAgentSession,
        connectedClientId: null,
      });

      const sessions = new Map([['same-session', slot]]);
      const sessionManager = createMockSessionManager(sessions);

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const folderIndex = createMockFolderIndex();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, folderIndex, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
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

      await capturedBindings.commandContextActions.navigateTree('entry-123');

      const replaced = findEvents(sent, 'session_replaced');
      expect(replaced).toHaveLength(0);

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).sessionId).toBe('same-session');
    });
  });

  describe('tree navigation interfaces', () => {
    it('returns mapped tree data when prompt message is /tree', async () => {
      const tree = [
        {
          entry: {
            id: 'entry-user',
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Show me the latest tree node' }],
            },
            timestamp: '2026-04-11T12:00:00.000Z',
          },
          label: 'root',
          labelTimestamp: '2026-04-11T12:00:01.000Z',
          children: [
            {
              entry: {
                id: 'entry-summary',
                type: 'branch_summary',
                summary: 'A summary of a previously navigated branch',
                timestamp: '2026-04-11T12:05:00.000Z',
              },
              children: [],
            },
          ],
        },
      ];

      const session = createMockSlot({
        id: 'session-tree',
        connectedClientId: 'client-1',
      });

      (session.session as any).sessionManager = {
        getTree: () => tree,
        getLeafId: () => 'entry-summary',
      };

      const sessions = new Map([['session-tree', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'prompt',
          sessionId: 'session-tree',
          message: '/tree',
          id: 'req-tree-prompt',
        }),
      );

      const resp = findResponse(sent, 'req-tree-prompt');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);

      const payload = resp!.data as any;
      expect(payload.currentLeafId).toBe('entry-summary');
      expect(payload.tree).toHaveLength(1);
      expect(payload.tree[0]).toMatchObject({
        id: 'entry-user',
        type: 'message',
        role: 'user',
        preview: 'Show me the latest tree node',
        timestamp: '2026-04-11T12:00:00.000Z',
        label: 'root',
        labelTimestamp: '2026-04-11T12:00:01.000Z',
      });
      expect(payload.tree[0].children).toHaveLength(1);
      expect(payload.tree[0].children[0]).toMatchObject({
        id: 'entry-summary',
        type: 'branch_summary',
        preview: 'A summary of a previously navigated branch',
        timestamp: '2026-04-11T12:05:00.000Z',
      });
    });

    it('navigates to a tree entry with start/end lifecycle events and optional editorText', async () => {
      const navigateTree = vi.fn().mockResolvedValue({
        cancelled: false,
        editorText: 'Use this summary as the next prompt',
      });

      const session = createMockSlot({
        id: 'session-tree-nav',
        connectedClientId: 'client-1',
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          thinkingLevel: 'default',
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'session-tree-nav',
          sessionName: undefined,
          autoCompactionEnabled: false,
          bindExtensions: async () => {},
          modelRegistry: { getAvailable: () => [] },
          clearQueue: () => ({ steering: [], followUp: [] }),
          navigateTree,
          sessionManager: {
            appendLabelChange: vi.fn(),
            getTree: () => [],
            getLeafId: () => null,
          },
        } as any,
      });

      const sessions = new Map([['session-tree-nav', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'navigate_tree',
          sessionId: 'session-tree-nav',
          targetId: 'entry-target',
          summarize: true,
          customInstructions: 'Focus on unresolved TODOs',
          replaceInstructions: false,
          label: 'checkpoint',
          id: 'req-navigate-tree',
        }),
      );

      expect(navigateTree).toHaveBeenCalledWith('entry-target', {
        summarize: true,
        customInstructions: 'Focus on unresolved TODOs',
        replaceInstructions: false,
        label: 'checkpoint',
      });

      const startEvents = findEvents(sent, 'tree_navigation_start');
      const endEvents = findEvents(sent, 'tree_navigation_end');
      expect(startEvents).toEqual([
        {
          type: 'tree_navigation_start',
          sessionId: 'session-tree-nav',
          cursor: expect.any(Number),
          targetId: 'entry-target',
          summarizing: true,
        },
      ]);
      expect(endEvents).toEqual([
        {
          type: 'tree_navigation_end',
          sessionId: 'session-tree-nav',
          cursor: expect.any(Number),
        },
      ]);

      const fullResync = findEvents(sent, 'full_resync');
      expect(fullResync).toHaveLength(1);

      const resp = findResponse(sent, 'req-navigate-tree');
      expect(resp).toEqual({
        id: 'req-navigate-tree',
        success: true,
        data: { cancelled: false, editorText: 'Use this summary as the next prompt' },
      });
    });

    it('sets or clears a tree label through the session manager and responds with success', async () => {
      const appendLabelChange = vi.fn().mockReturnValue('label-entry-id');
      const session = createMockSlot({ id: 'session-tree-label', connectedClientId: 'client-1' });
      (session.session as any).sessionManager = {
        appendLabelChange,
        getTree: () => [],
        getLeafId: () => null,
      };

      const sessions = new Map([['session-tree-label', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'set_tree_label',
          sessionId: 'session-tree-label',
          entryId: 'entry-42',
          label: 'important',
          id: 'req-set-tree-label',
        }),
      );

      expect(appendLabelChange).toHaveBeenCalledWith('entry-42', 'important');
      expect(findResponse(sent, 'req-set-tree-label')).toEqual({
        id: 'req-set-tree-label',
        success: true,
        data: { success: true },
      });
    });
  });

  describe('rename_session', () => {
    it('renames an active session via the live AgentSession', async () => {
      const setSessionName = vi.fn();
      const session = createMockSlot({
        id: 'session-1',
        session: {
          subscribe: () => () => {},
          setSessionName,
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
        },
      });
      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'rename_session',
          folderPath: '/home/user/project',
          sessionId: 'session-1',
          name: '  Renamed Session  ',
          id: 'req-rename-1',
        }),
      );

      expect(setSessionName).toHaveBeenCalledWith('Renamed Session');
      expect(findEvents(sent, 'session_renamed')).toEqual([
        {
          type: 'session_renamed',
          sessionId: 'session-1',
          folderPath: '/home/user/project',
          name: 'Renamed Session',
        },
      ]);
      expect(findResponse(sent, 'req-rename-1')).toMatchObject({ success: true, data: { name: 'Renamed Session' } });
    });

    it('renames an inactive persisted session via FolderIndex', async () => {
      const renameSession = vi.fn().mockResolvedValue(true);
      const folderIndex = {
        ...createMockFolderIndex(),
        renameSession,
      } as unknown as FolderIndex;
      const { handler, sent } = createTestHandler('client-1', { folderIndex });

      await handler.handleMessage(
        JSON.stringify({
          type: 'rename_session',
          folderPath: '/home/user/project',
          sessionId: 'session-2',
          name: 'Renamed Persisted Session',
          id: 'req-rename-2',
        }),
      );

      expect(renameSession).toHaveBeenCalledWith('/home/user/project', 'session-2', 'Renamed Persisted Session');
      expect(findEvents(sent, 'session_renamed')).toEqual([
        {
          type: 'session_renamed',
          sessionId: 'session-2',
          folderPath: '/home/user/project',
          name: 'Renamed Persisted Session',
        },
      ]);
      expect(findResponse(sent, 'req-rename-2')).toMatchObject({ success: true, data: { name: 'Renamed Persisted Session' } });
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
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
      });

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

      (session.session as any).promptTemplates = (opts.promptTemplates ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        content: '',
        source: 'test',
        filePath: '/fake',
      }));

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
      expect(commands[0]).toEqual({ name: 'skill:brainstorm', description: 'Brainstorm ideas', hasArgCompletions: false });
      expect(commands[1]).toEqual({ name: 'skill:code-review', description: 'Review code', hasArgCompletions: false });
    });

    it('returns prompt templates as commands with hasArgCompletions=false', async () => {
      const session = createSessionWithSources({
        promptTemplates: [{ name: 'fix-bug', description: 'Fix a bug' }],
      });

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'get_commands', sessionId: 'session-1', id: 'req-cmds-3' }));

      const resp = findResponse(sent, 'req-cmds-3');
      const commands = (resp!.data as any).commands;
      expect(commands).toHaveLength(3);
      expect(commands[0]).toEqual({ name: 'fix-bug', description: 'Fix a bug', hasArgCompletions: false });
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

      await handler.handleMessage(JSON.stringify({ type: 'get_commands', sessionId: 'session-1', id: 'req-cmds-5' }));

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

      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
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

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'deploy', prefix: 'sta', id: 'req-args-1' }));

      const resp = findResponse(sent, 'req-args-1');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toEqual([{ value: 'staging', label: 'staging', description: 'Staging environment' }]);
    });

    it('returns null when command does not exist', async () => {
      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = { getRegisteredCommands: () => [], getCommand: () => undefined };

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'nonexistent', prefix: '', id: 'req-args-2' }));

      const resp = findResponse(sent, 'req-args-2');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('returns null when command exists but has no getArgumentCompletions', async () => {
      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
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

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'reload', prefix: '', id: 'req-args-3' }));

      const resp = findResponse(sent, 'req-args-3');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('returns null when extensionRunner is not available', async () => {
      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
      (session.session as any).promptTemplates = [];
      (session.session as any).extensionRunner = undefined;

      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'anything', prefix: '', id: 'req-args-4' }));

      const resp = findResponse(sent, 'req-args-4');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });

    it('passes prefix through to getArgumentCompletions', async () => {
      let receivedPrefix: string | undefined;

      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
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

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'deploy', prefix: 'prod', id: 'req-args-5' }));

      expect(receivedPrefix).toBe('prod');
    });

    it('normalizes null return from getArgumentCompletions', async () => {
      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1' });
      (session.session as any).resourceLoader = { getSkills: () => ({ skills: [], diagnostics: [] }) };
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

      await handler.handleMessage(JSON.stringify({ type: 'complete_args', sessionId: 'session-1', commandName: 'deploy', prefix: '', id: 'req-args-6' }));

      const resp = findResponse(sent, 'req-args-6');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).items).toBeNull();
    });
  });
});
