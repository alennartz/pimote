import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCommandContextActions, WsHandler, type ClientRegistry } from './ws-handler.js';
import type { PimoteSessionManager, ManagedSlot, SessionState, ClientConnection } from './session-manager.js';
import type { SessionRecords } from './session-records.js';
import type { RepoIndex } from './repo-index.js';
import type { FolderRegistry } from './folder-registry.js';
import type { FolderListingService } from './folder-listing.js';
import type { FolderCreator } from './folder-sources/index.js';
import type { PushNotificationService } from './push-notification.js';
import { EventBuffer } from './event-buffer.js';
import type { EventBusController } from '@earendil-works/pi-coding-agent';
import type { DownloadItem, FolderInfo, PimoteEvent, PimoteResponse, PimoteSessionEvent } from '../../shared/dist/index.js';

describe('extension command context actions', () => {
  it('delegates waitForIdle to the SDK settle-aware primitive', async () => {
    let resolveIdle: (() => void) | undefined;
    const waitForIdle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveIdle = resolve;
        }),
    );
    const slot = createMockSlot();
    (slot.session as any).waitForIdle = waitForIdle;
    const actions = createCommandContextActions(slot, {} as PimoteSessionManager);

    let resolved = false;
    const waiting = actions.waitForIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    resolveIdle!();
    await waiting;
    expect(resolved).toBe(true);
  });
});

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
    idleSince: number;
    status: 'idle' | 'working';
    needsAttention: boolean;
    unsubscribe: () => void;
    eventBuffer: EventBuffer;
    extensionsBound: boolean;
    session: any;
    panelState: Map<string, any>;
    downloads: DownloadItem[];
    eventBus: EventBusController | null;
  }> = {},
): ManagedSlot {
  const id = overrides.id ?? 'session-1';
  const mockSession = overrides.session ?? {
    subscribe: () => () => {},
    dispose: () => {},
    messages: [],
    model: null,
    thinkingLevel: 'default',
    getAvailableThinkingLevels: () => [],
    isStreaming: false,
    isCompacting: false,
    sessionFile: undefined,
    sessionId: id,
    sessionName: undefined,
    autoCompactionEnabled: false,
    bindExtensions: async () => {},
    modelRuntime: { getAvailable: async () => [] },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sessionManager: { buildContextEntries: () => [], getBranch: () => [], getCwd: () => overrides.folderPath ?? '/home/user/project' },
  };

  const sessionState: SessionState = {
    id,
    eventBuffer: overrides.eventBuffer ?? createMockEventBuffer(),
    status: overrides.status ?? 'idle',
    needsAttention: overrides.needsAttention ?? false,
    idleSince: overrides.idleSince ?? Date.now(),
    unsubscribe: overrides.unsubscribe ?? (() => {}),
    pendingUiResponses: new Map(),
    extensionsBound: overrides.extensionsBound ?? false,
    panelState: overrides.panelState ?? new Map(),
    downloads: overrides.downloads ?? [],
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
  };

  const connection: ClientConnection | null =
    overrides.connectedClientId != null ? { ws: null as any, connectedClientId: overrides.connectedClientId, onSessionReset: null } : null;

  const slot: ManagedSlot = {
    runtime: { session: mockSession } as any,
    folderPath: overrides.folderPath ?? '/home/user/project',
    eventBusRef: { current: overrides.eventBus ?? null },
    connection,
    sessionState,
    get session() {
      return this.runtime.session;
    },
  };

  return slot;
}

function createMockSessionManager(sessions: Map<string, ManagedSlot> = new Map()): PimoteSessionManager {
  const manager = {
    getSession: (id: string) => sessions.get(id),
    getSlot: (id: string) => sessions.get(id) ?? null,
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
    getLastKnownGitBranch: () => null,
    onSlotEvicted: undefined as undefined | ((sessionId: string) => void),
    // Mirrors the real SessionManager.applySessionReset: reconcile the map ALWAYS
    // (dispatching through the manager so test overrides of rebuild/close/reKey take
    // effect), then notify the slot's current owner. Kept faithful so ws-handler
    // tests exercise the real notify-only handleSessionReset.
    applySessionReset: async (slot: ManagedSlot) => {
      const newId = slot.runtime.session.sessionId;
      const oldId = slot.sessionState.id;
      if (newId === oldId) {
        await slot.connection?.onSessionReset?.(slot, { kind: 'unchanged' });
        return;
      }
      manager.rebuildSessionState(slot);
      const occupant = manager.getSession(newId);
      if (occupant && occupant !== slot) {
        manager.onSlotEvicted?.(newId);
        await manager.closeSession(newId);
      }
      manager.reKeySession(slot, oldId, newId);
      await slot.connection?.onSessionReset?.(slot, { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath });
    },
  };
  return manager as unknown as PimoteSessionManager;
}

function createMockSessionRecords(): SessionRecords {
  return {
    listSessions: async () => [],
    listSessionRecords: async () => [],
    resolveSessionPath: async () => undefined,
    renameSession: async () => false,
    deleteSession: async () => false,
  } as unknown as SessionRecords;
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
    sessionRecords?: SessionRecords;
    sessionMetadataStore?: ReturnType<typeof createMockSessionMetadataStore>;
    repoIndex?: RepoIndex;
    folderRegistry?: FolderRegistry;
    creators?: FolderCreator[];
    folderListing?: FolderListingService;
  },
): TestContext {
  const sessions = opts?.sessions ?? new Map();
  const sessionManager = createMockSessionManager(sessions);
  const clientRegistry = opts?.clientRegistry ?? new Map();
  const { ws, sent } = createMockWs();
  const sessionRecords = opts?.sessionRecords ?? createMockSessionRecords();
  const pushService = createMockPushService();
  const sessionMetadataStore = opts?.sessionMetadataStore ?? createMockSessionMetadataStore();

  const handler = new WsHandler(
    sessionManager,
    sessionRecords,
    ws,
    pushService,
    sessionMetadataStore as any,
    clientId,
    clientRegistry,
    undefined,
    opts?.repoIndex,
    opts?.folderRegistry,
    { disposeClient: () => {} } as never, // managerService: only truthiness is required by requireFolderDeps; cleanup() no-op
    opts?.creators ?? [], // creators
    opts?.folderListing, // folderListing
  );

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

const pendingDownload: DownloadItem = { id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' };

function folderRow(path: string, overrides: Partial<FolderInfo> = {}): FolderInfo {
  return {
    path,
    name: basename(path),
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...overrides,
  };
}

/** Let queued promise chains (fire-and-forget broadcasts) settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Tests ---

describe('WsHandler', () => {
  describe('clientId', () => {
    it('exposes the clientId passed to constructor', () => {
      const { handler } = createTestHandler('client-abc');
      expect(handler.clientId).toBe('client-abc');
    });
  });

  describe('server-global login commands', () => {
    it('waits for asynchronous OAuth provider listing before responding', async () => {
      let release!: () => void;
      const providersGate = new Promise<Array<{ id: string; name: string; loggedIn: boolean }>>(
        (resolve) => (release = () => resolve([{ id: 'anthropic', name: 'Claude', loggedIn: true }])),
      );
      const { handler, sent, sessionManager } = createTestHandler('client-1');
      (sessionManager as any).getLoginOrchestrator = () => ({ listProviders: () => providersGate });

      const handling = handler.handleMessage(JSON.stringify({ type: 'login_list', id: 'req-login-list' }));
      await Promise.resolve();
      expect(findResponse(sent, 'req-login-list')).toBeUndefined();

      release();
      await handling;
      expect(findResponse(sent, 'req-login-list')).toMatchObject({ success: true, data: { providers: [{ id: 'anthropic', name: 'Claude', loggedIn: true }] } });
    });

    it('waits for logout and its model refresh before confirming success', async () => {
      let release!: () => void;
      const logoutGate = new Promise<void>((resolve) => (release = resolve));
      const logout = vi.fn(() => logoutGate);
      const { handler, sent, sessionManager } = createTestHandler('client-1');
      (sessionManager as any).getLoginOrchestrator = () => ({ logout });

      const handling = handler.handleMessage(JSON.stringify({ type: 'logout', providerId: 'anthropic', id: 'req-logout' }));
      await Promise.resolve();
      expect(logout).toHaveBeenCalledWith('anthropic');
      expect(findResponse(sent, 'req-logout')).toBeUndefined();

      release();
      await handling;
      expect(findResponse(sent, 'req-logout')).toMatchObject({ success: true, data: { ok: true } });
    });
  });

  describe('session model runtime controls', () => {
    it('waits for session.modelRuntime before listing available models', async () => {
      let release!: () => void;
      const modelsGate = new Promise<Array<{ provider: string; id: string; name: string }>>(
        (resolve) => (release = () => resolve([{ provider: 'anthropic', id: 'claude', name: 'Claude' }])),
      );
      const slot = createMockSlot();
      const getAvailable = vi.fn(() => modelsGate);
      (slot.session as any).modelRuntime = { getAvailable };
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      const handling = handler.handleMessage(JSON.stringify({ type: 'get_available_models', sessionId: slot.sessionState.id, id: 'req-model-list' }));
      await Promise.resolve();
      expect(getAvailable).toHaveBeenCalledOnce();
      expect(findResponse(sent, 'req-model-list')).toBeUndefined();

      release();
      await handling;
      expect(findResponse(sent, 'req-model-list')).toMatchObject({
        success: true,
        data: { models: [{ provider: 'anthropic', id: 'claude', name: 'Claude' }] },
      });
    });

    it('selects a matching model from session.modelRuntime', async () => {
      const model = { provider: 'anthropic', id: 'claude', name: 'Claude' };
      const slot = createMockSlot();
      const setModel = vi.fn(async () => {
        slot.session.model = model;
        slot.session.thinkingLevel = 'off';
        slot.session.getAvailableThinkingLevels = () => ['off', 'minimal', 'low'];
      });
      (slot.session as any).modelRuntime = { getAvailable: vi.fn(async () => [model]) };
      (slot.session as any).setModel = setModel;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(JSON.stringify({ type: 'set_model', sessionId: slot.sessionState.id, provider: 'anthropic', modelId: 'claude', id: 'req-set-model' }));

      expect(setModel).toHaveBeenCalledWith(model);
      expect(findResponse(sent, 'req-set-model')).toMatchObject({
        success: true,
        data: {
          model,
          thinkingLevel: 'off',
          availableThinkingLevels: ['off', 'minimal', 'low'],
        },
      });
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

  describe('open_session — folder source open hooks', () => {
    it('runs runOpenHooks before opening a new session', async () => {
      const order: string[] = [];
      const repoIndex = {
        roots: ['/home/user/projects'],
        list: async () => [],
        listSourceHubs: async () => [],
        runOpenHooks: async (path: string) => {
          order.push(`hooks:${path}`);
        },
      } as unknown as RepoIndex;
      const { handler, sent, sessionManager } = createTestHandler('client-1', { repoIndex });
      // Sentinel open: proves hooks ran first without plumbing a full slot.
      sessionManager.openSession = async () => {
        order.push('open');
        throw new Error('halt');
      };

      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/projects/alpha', id: 'req-hooks' }));

      const resp = findResponse(sent, 'req-hooks');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('halt');
      expect(order).toEqual(['hooks:/home/user/projects/alpha', 'open']);
    });

    it('a hook error aborts the open and surfaces the message', async () => {
      const order: string[] = [];
      const repoIndex = {
        roots: ['/home/user/projects'],
        list: async () => [],
        listSourceHubs: async () => [],
        runOpenHooks: async () => {
          throw new Error('scaffold failed: unmounted volume');
        },
      } as unknown as RepoIndex;
      const { handler, sent, sessionManager } = createTestHandler('client-1', { repoIndex });
      sessionManager.openSession = async () => {
        order.push('open');
        return 'never';
      };

      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/projects/alpha', id: 'req-hook-err' }));

      const resp = findResponse(sent, 'req-hook-err');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('scaffold failed');
      expect(order).toEqual([]);
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
        downloads: [pendingDownload],
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
      expect(findEvents(sent, 'download_update')).toContainEqual({
        type: 'download_update',
        sessionId: 'session-1',
        cause: 'restored',
        downloads: [pendingDownload],
      });

      const resp = findResponse(sent, 'req-2');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
    });

    it('sends full_resync when lastCursor is omitted', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'client-1',
        eventBuffer: createMockEventBuffer({ replayResult: [] }),
        downloads: [pendingDownload],
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
      expect(findEvents(sent, 'download_update')).toContainEqual({
        type: 'download_update',
        sessionId: 'session-1',
        cause: 'restored',
        downloads: [pendingDownload],
      });

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

    it('sends the pending snapshot only to the new owner after takeover', async () => {
      const session = createMockSlot({
        id: 'session-1',
        connectedClientId: 'old-client',
        downloads: [pendingDownload],
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
          id: 'req-download-takeover',
        }),
      );

      expect(findEvents(newCtx.sent, 'download_update')).toContainEqual({
        type: 'download_update',
        sessionId: 'session-1',
        cause: 'restored',
        downloads: [pendingDownload],
      });
      expect(findEvents(oldCtx.sent, 'download_update')).toEqual([]);
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
            getAvailableThinkingLevels: () => [],
            isStreaming: false,
            isCompacting: false,
            sessionFile: sessionFilePath,
            sessionId: reopenedSessionId,
            sessionName: undefined,
            autoCompactionEnabled: false,
            bindExtensions: async () => {},
            modelRuntime: { getAvailable: async () => [] },
            clearQueue: () => ({ steering: [], followUp: [] }),
            sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
          } as any,
        });
        sessions.set(reopenedSessionId, reopened);
        return reopenedSessionId;
      };

      const sessionRecords = {
        ...createMockSessionRecords(),
        resolveSessionPath: async (_folderPath: string, sessionId: string) => (sessionId === reopenedSessionId ? '/tmp/session-1.jsonl' : undefined),
      } as SessionRecords;

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const pushService = createMockPushService();
      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
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

  describe('open_session — folderless deep-link reopen', () => {
    /** Slot stub rich enough for syncSessionToClient's disk_full_resync path. */
    function stubDiskReopen(sessionManager: PimoteSessionManager, sessions: Map<string, ManagedSlot>, expectFolder: string, expectFile: string): void {
      (sessionManager as any).openSession = async (folderPath: string, sessionFilePath?: string) => {
        expect(folderPath).toBe(expectFolder);
        expect(sessionFilePath).toBe(expectFile);
        const reopened = createMockSlot({
          id: 'session-deep',
          folderPath: expectFolder,
          session: {
            subscribe: () => () => {},
            dispose: () => {},
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            model: null,
            thinkingLevel: 'off',
            getAvailableThinkingLevels: () => [],
            isStreaming: false,
            isCompacting: false,
            sessionFile: sessionFilePath,
            sessionId: 'session-deep',
            sessionName: undefined,
            autoCompactionEnabled: false,
            bindExtensions: async () => {},
            modelRuntime: { getAvailable: async () => [] },
            clearQueue: () => ({ steering: [], followUp: [] }),
            sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
          } as any,
        });
        sessions.set('session-deep', reopened);
        return 'session-deep';
      };
    }

    it('resolves the folder by searching known folders (archived included) and unarchives on open', async () => {
      const sessions = new Map<string, ManagedSlot>();
      const sessionManager = createMockSessionManager(sessions);
      stubDiskReopen(sessionManager, sessions, '/home/user/beta', '/tmp/session-deep.jsonl');

      const sessionRecords = {
        ...createMockSessionRecords(),
        resolveSessionPath: async (folderPath: string, sessionId: string) =>
          folderPath === '/home/user/beta' && sessionId === 'session-deep' ? '/tmp/session-deep.jsonl' : undefined,
      } as SessionRecords;
      const folderRegistry = {
        list: async () => [folderRow('/home/user/alpha'), folderRow('/home/user/beta', { archived: true })],
      } as unknown as FolderRegistry;
      const sessionMetadataStore = createMockSessionMetadataStore(['/tmp/session-deep.jsonl']);

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const handler = new WsHandler(
        sessionManager,
        sessionRecords,
        ws,
        createMockPushService(),
        sessionMetadataStore as any,
        'client-1',
        clientRegistry,
        undefined,
        undefined,
        folderRegistry,
      );
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(JSON.stringify({ type: 'open_session', sessionId: 'session-deep', id: 'req-folderless' }));

      const resp = findResponse(sent, 'req-folderless');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).folderPath).toBe('/home/user/beta');

      // Opened straight from the archived folder record → unarchived on the fly.
      expect(sessionMetadataStore.isArchived('/tmp/session-deep.jsonl')).toBe(false);
      const archivedEvents = findEvents(sent, 'session_archived');
      expect(archivedEvents).toHaveLength(1);
      expect((archivedEvents[0] as any).archived).toBe(false);
    });

    it('responds session_expired when no known folder holds the session', async () => {
      const sessionManager = createMockSessionManager(new Map());
      const folderRegistry = {
        list: async () => [folderRow('/home/user/alpha'), folderRow('/home/user/beta')],
      } as unknown as FolderRegistry;

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const handler = new WsHandler(
        sessionManager,
        createMockSessionRecords(),
        ws,
        createMockPushService(),
        createMockSessionMetadataStore() as any,
        'client-1',
        clientRegistry,
        undefined,
        undefined,
        folderRegistry,
      );
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(JSON.stringify({ type: 'open_session', sessionId: 'ghost-session', id: 'req-folderless-miss' }));

      const resp = findResponse(sent, 'req-folderless-miss');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('session_expired');
    });

    it('rejects creating a new session without a folderPath', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(JSON.stringify({ type: 'open_session', id: 'req-no-folder' }));

      const resp = findResponse(sent, 'req-no-folder');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('folder_required');
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
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
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
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
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

      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        sessionRecords,
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
      // 2 from disk records + 2 active in-memory (different IDs) = 4
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

      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        sessionRecords,
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

      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        sessionRecords,
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

      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const clientRegistry: ClientRegistry = new Map();
      const { handler, sent } = createTestHandler('my-client', {
        sessions,
        clientRegistry,
        sessionRecords,
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
      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const { handler, sent } = createTestHandler('client-1', {
        sessionRecords,
        sessionMetadataStore: createMockSessionMetadataStore(['/tmp/archived.jsonl']),
      });

      await handler.handleMessage(JSON.stringify({ type: 'list_sessions', folderPath: '/home/user/project', id: 'req-archived-default' }));

      expect((findResponse(sent, 'req-archived-default')!.data as any).sessions).toEqual([expect.objectContaining({ id: 'visible', archived: false })]);
    });

    it('includes archived sessions when includeArchived=true', async () => {
      const sessionRecords = {
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
      } as unknown as SessionRecords;

      const { handler, sent } = createTestHandler('client-1', {
        sessionRecords,
        sessionMetadataStore: createMockSessionMetadataStore(['/tmp/archived.jsonl']),
      });

      await handler.handleMessage(JSON.stringify({ type: 'list_sessions', folderPath: '/home/user/project', includeArchived: true, id: 'req-archived-all' }));

      expect((findResponse(sent, 'req-archived-all')!.data as any).sessions).toEqual([expect.objectContaining({ id: 'archived', archived: true })]);
    });

    it('archives a session and broadcasts session_archived', async () => {
      const sessionRecords = {
        ...createMockSessionRecords(),
        resolveSessionPath: async () => '/tmp/archive-me.jsonl',
      } as unknown as SessionRecords;
      const sessionMetadataStore = createMockSessionMetadataStore();
      const { handler, sent } = createTestHandler('client-1', { sessionRecords, sessionMetadataStore });

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
            getAvailableThinkingLevels: () => [],
            isStreaming: false,
            isCompacting: false,
            sessionFile: sessionFilePath,
            sessionId: reopenedSessionId,
            sessionName: undefined,
            autoCompactionEnabled: false,
            bindExtensions: async () => {},
            modelRuntime: { getAvailable: async () => [] },
            clearQueue: () => ({ steering: [], followUp: [] }),
            sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
          } as any,
        });
        sessions.set(reopenedSessionId, reopened);
        return reopenedSessionId;
      };

      const sessionRecords = {
        ...createMockSessionRecords(),
        resolveSessionPath: async () => sessionPath,
      } as unknown as SessionRecords;
      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const pushService = createMockPushService();
      const sessionMetadataStore = createMockSessionMetadataStore([sessionPath]);
      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, sessionMetadataStore as any, 'client-1', clientRegistry);
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

  describe('view_session — download snapshot', () => {
    it('sends the viewed session pending-download snapshot without treating it as a new offer', async () => {
      const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1', downloads: [pendingDownload] });
      const sessions = new Map([['session-1', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'view_session', sessionId: 'session-1', id: 'req-view-downloads' }));

      expect(findEvents(sent, 'download_update')).toEqual([
        {
          type: 'download_update',
          sessionId: 'session-1',
          cause: 'restored',
          downloads: [pendingDownload],
        },
      ]);
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
        getAvailableThinkingLevels: () => [],
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
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
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
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
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
      // Unlisted cwd: the fallback row is the classified basename with plain defaults.
      expect((replaced[0] as any).folder).toMatchObject({
        name: 'project',
        nature: 'code',
        shortcutCount: 0,
        favorite: false,
        archived: false,
        tags: [],
        missing: false,
        activeSessionCount: 1,
        externalProcessCount: 0,
      });

      const stateChanges = findEvents(sent, 'session_state_changed');
      const oldChange = stateChanges.find((e: any) => e.sessionId === 'old-session');
      const newChange = stateChanges.find((e: any) => e.sessionId === 'new-session');
      expect(oldChange).toBeDefined();
      expect(newChange).toBeDefined();
      expect((oldChange as any).liveStatus).toBeNull();

      expect(sessions.has('old-session')).toBe(false);
      expect(sessions.has('new-session')).toBe(true);
    });

    it('reconciles the session map even when the slot has no owner (#6a — no phantom)', async () => {
      // No connection on the slot (owner disconnected; reset fired via extension).
      // The old code's `slot.connection?.onSessionReset?.()` would no-op, leaving the
      // map keyed under the stale ID. applySessionReset must re-key regardless.
      const mockAgentSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        sessionId: 'orphan-old',
        bindExtensions: async () => {},
        clearQueue: () => ({ steering: [], followUp: [] }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;
      const slot = createMockSlot({ id: 'orphan-old', session: mockAgentSession, connectedClientId: null });
      (slot.runtime as any).newSession = async () => {
        mockAgentSession.sessionId = 'orphan-new';
        return { cancelled: false };
      };
      const sessions = new Map([['orphan-old', slot]]);
      const { handler } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'new_session', sessionId: 'orphan-old', id: 'req-ns' }));

      expect(sessions.has('orphan-old')).toBe(false);
      expect(sessions.has('orphan-new')).toBe(true);
    });

    it('notifies the owning client on reset, not the issuing client (#6b)', async () => {
      const mockAgentSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: 'shared-old',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async () => {},
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;
      const slot = createMockSlot({ id: 'shared-old', session: mockAgentSession, connectedClientId: null });
      (slot.runtime as any).fork = async () => {
        mockAgentSession.sessionId = 'shared-new';
        return { cancelled: false };
      };
      const sessions = new Map([['shared-old', slot]]);
      const clientRegistry: ClientRegistry = new Map();

      // Owner A claims the session.
      const { handler: handlerA, sent: sentA } = createTestHandler('A', { sessions, clientRegistry });
      await handlerA.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/project', sessionId: 'shared-old', id: 'req-claim' }));

      // Issuer B (a different client) issues fork on the same session.
      const { handler: handlerB, sent: sentB } = createTestHandler('B', { sessions, clientRegistry });
      sentA.length = 0;
      sentB.length = 0;
      await handlerB.handleMessage(JSON.stringify({ type: 'fork', sessionId: 'shared-old', entryId: 'e1', id: 'req-fork' }));

      // The owner (A) is told its session was replaced; the issuer (B) is not.
      expect(findEvents(sentA, 'session_replaced')).toHaveLength(1);
      expect(findEvents(sentB, 'session_replaced')).toHaveLength(0);
    });

    it('displaces a colliding occupant when the reset lands on an already-open session ID', async () => {
      // Simulates an extension calling ctx.switchSession(path) onto a file that is
      // already open in another slot: the new ID collides with a live map entry.
      let capturedOnReset: (() => Promise<void>) | undefined;
      const mockAgentSession = {
        sessionId: 'old-session',
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async (bindings: any) => {
          if (bindings.commandContextActions) {
            capturedOnReset = async () => {
              mockAgentSession.sessionId = 'target-session';
              await bindings.commandContextActions.newSession();
            };
          }
        },
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;

      const slot = createMockSlot({ id: 'old-session', session: mockAgentSession, connectedClientId: null });
      (slot.runtime as any).newSession = async () => {
        mockAgentSession.sessionId = 'target-session';
        return { cancelled: false };
      };

      // Occupant slot already holding 'target-session', owned by another client.
      const occupant = createMockSlot({ id: 'target-session', connectedClientId: 'other-client' });

      const sessions = new Map([
        ['old-session', slot],
        ['target-session', occupant],
      ]);
      const sessionManager = createMockSessionManager(sessions);
      (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
        s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
      };
      const closeSpy = vi.fn(async (id: string) => {
        sessions.delete(id);
      });
      (sessionManager as any).closeSession = closeSpy;

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const handler = new WsHandler(sessionManager, createMockSessionRecords(), ws, createMockPushService(), createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
      clientRegistry.set('my-client', handler);

      // Eviction notify is wired at boot in server.ts; mirror it here.
      (sessionManager as any).onSlotEvicted = (sessionId: string) => {
        const ownerClientId = sessions.get(sessionId)?.connection?.connectedClientId;
        if (ownerClientId) clientRegistry.get(ownerClientId)?.sendDisplacedEvent(sessionId);
      };

      // Register the occupant's owning handler so it receives the displaced event.
      const { ws: otherWs, sent: otherSent } = createMockWs();
      const otherHandler = new WsHandler(
        sessionManager,
        createMockSessionRecords(),
        otherWs,
        createMockPushService(),
        createMockSessionMetadataStore() as any,
        'other-client',
        clientRegistry,
      );
      clientRegistry.set('other-client', otherHandler);

      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/project', sessionId: 'old-session', id: 'req-open' }));
      sent.length = 0;
      otherSent.length = 0;

      expect(capturedOnReset).toBeDefined();
      await capturedOnReset!();

      // Occupant's owner was notified its session went away.
      const displaced = findEvents(otherSent, 'session_closed').filter((e: any) => e.reason === 'displaced');
      expect(displaced).toHaveLength(1);
      expect((displaced[0] as any).sessionId).toBe('target-session');

      // The occupant's runtime was disposed before re-keying.
      expect(closeSpy).toHaveBeenCalledWith('target-session');

      // The switching slot now owns the target key.
      expect(sessions.get('target-session')).toBe(slot);
      expect(sessions.has('old-session')).toBe(false);
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
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: '/tmp/session.json',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async (bindings: any) => {
          capturedBindings = bindings;
        },
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        navigateTree: async () => ({ cancelled: false }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
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
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'my-client', clientRegistry);
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

  describe('reload prompt', () => {
    it('waits for reload and sends a full resync with refreshed thinking levels', async () => {
      let finishReload: (() => void) | undefined;
      const reload = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishReload = resolve;
          }),
      );
      const slot = createMockSlot({ id: 'session-reload', connectedClientId: 'client-1' });
      (slot.session as any).reload = reload;
      (slot.session as any).model = { provider: 'genetec-openai-responses', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' };
      (slot.session as any).thinkingLevel = 'high';
      (slot.session as any).getAvailableThinkingLevels = () => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

      const sessions = new Map([['session-reload', slot]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });
      const handling = handler.handleMessage(JSON.stringify({ type: 'prompt', sessionId: 'session-reload', message: '/reload', id: 'req-reload' }));

      await Promise.resolve();
      expect(reload).toHaveBeenCalledOnce();
      expect(findResponse(sent, 'req-reload')).toBeUndefined();

      finishReload!();
      await handling;

      const resync = findEvents(sent, 'full_resync');
      expect(resync).toHaveLength(1);
      expect((resync[0] as any).state.availableThinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(findResponse(sent, 'req-reload')!.success).toBe(true);
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

    it('truncates long previews and falls back to entry type in /tree mapping', async () => {
      const longText = 'x'.repeat(250);
      const tree = [
        {
          entry: {
            id: 'entry-long',
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: longText }],
            },
            timestamp: '2026-04-11T13:00:00.000Z',
          },
          children: [
            {
              entry: {
                id: 'entry-custom',
                type: 'custom',
                timestamp: '2026-04-11T13:01:00.000Z',
              },
              children: [],
            },
          ],
        },
      ];

      const session = createMockSlot({
        id: 'session-tree-truncation',
        connectedClientId: 'client-1',
      });

      (session.session as any).sessionManager = {
        getTree: () => tree,
        getLeafId: () => 'entry-custom',
      };

      const sessions = new Map([['session-tree-truncation', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'prompt',
          sessionId: 'session-tree-truncation',
          message: '/tree',
          id: 'req-tree-truncation',
        }),
      );

      const resp = findResponse(sent, 'req-tree-truncation');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);

      const payload = resp!.data as any;
      expect(payload.tree[0].preview).toHaveLength(200);
      expect(payload.tree[0].preview.endsWith('...')).toBe(true);
      expect(payload.tree[0].children[0]).toMatchObject({
        id: 'entry-custom',
        type: 'custom',
        preview: 'custom',
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
        // Real EventBuffer (not the no-op mock) so tree_navigation lifecycle events
        // flow through the production mapEvent path, not a test-only fallback.
        eventBuffer: new EventBuffer(100),
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          thinkingLevel: 'default',
          getAvailableThinkingLevels: () => [],
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'session-tree-nav',
          sessionName: undefined,
          autoCompactionEnabled: false,
          bindExtensions: async () => {},
          modelRuntime: { getAvailable: async () => [] },
          clearQueue: () => ({ steering: [], followUp: [] }),
          navigateTree,
          sessionManager: {
            appendLabelChange: vi.fn(),
            getTree: () => [],
            getLeafId: () => null,
            getBranch: () => [],
            buildContextEntries: () => [],
          },
        } as any,
      });

      const sessions = new Map([['session-tree-nav', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      // Claim the session so client-1 is the owner whose onSessionReset fires.
      // navigate_tree now routes the resync through the owner (not the issuer).
      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/project', sessionId: 'session-tree-nav', id: 'req-claim' }));
      sent.length = 0;

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
          timestamp: expect.any(String),
          targetId: 'entry-target',
          summarizing: true,
        },
      ]);
      expect(endEvents).toEqual([
        {
          type: 'tree_navigation_end',
          sessionId: 'session-tree-nav',
          cursor: expect.any(Number),
          timestamp: expect.any(String),
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

    it('emits lifecycle events for cancelled navigation and skips full_resync', async () => {
      const refs: { slot: ManagedSlot | null } = { slot: null };
      const navigateTree = vi.fn().mockImplementation(async () => {
        expect(refs.slot?.sessionState.treeNavigationInProgress).toBe(true);
        return { cancelled: true };
      });

      const slot = createMockSlot({
        id: 'session-tree-cancel',
        connectedClientId: 'client-1',
        eventBuffer: new EventBuffer(100),
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          thinkingLevel: 'default',
          getAvailableThinkingLevels: () => [],
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'session-tree-cancel',
          sessionName: undefined,
          autoCompactionEnabled: false,
          bindExtensions: async () => {},
          modelRuntime: { getAvailable: async () => [] },
          clearQueue: () => ({ steering: [], followUp: [] }),
          navigateTree,
          sessionManager: {
            appendLabelChange: vi.fn(),
            getTree: () => [],
            getLeafId: () => null,
            getBranch: () => [],
            buildContextEntries: () => [],
          },
        } as any,
      });

      refs.slot = slot;

      const sessions = new Map([['session-tree-cancel', slot]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'navigate_tree',
          sessionId: 'session-tree-cancel',
          targetId: 'entry-cancel',
          id: 'req-navigate-tree-cancel',
        }),
      );

      expect(navigateTree).toHaveBeenCalledWith('entry-cancel', expect.any(Object));
      expect(slot.sessionState.treeNavigationInProgress).toBe(false);

      const startEvents = findEvents(sent, 'tree_navigation_start');
      const endEvents = findEvents(sent, 'tree_navigation_end');
      expect(startEvents).toEqual([
        {
          type: 'tree_navigation_start',
          sessionId: 'session-tree-cancel',
          cursor: expect.any(Number),
          timestamp: expect.any(String),
          targetId: 'entry-cancel',
          summarizing: false,
        },
      ]);
      expect(endEvents).toEqual([
        {
          type: 'tree_navigation_end',
          sessionId: 'session-tree-cancel',
          cursor: expect.any(Number),
          timestamp: expect.any(String),
        },
      ]);

      expect(findEvents(sent, 'full_resync')).toHaveLength(0);
      expect(findResponse(sent, 'req-navigate-tree-cancel')).toEqual({
        id: 'req-navigate-tree-cancel',
        success: true,
        data: { cancelled: true },
      });
    });

    it('rejects overlapping tree navigation requests for the same session', async () => {
      let resolveNavigation: ((value: { cancelled: boolean; editorText?: string }) => void) | undefined;
      const navigateTree = vi.fn().mockImplementation(
        () =>
          new Promise<{ cancelled: boolean; editorText?: string }>((resolve) => {
            resolveNavigation = resolve;
          }),
      );

      const session = createMockSlot({
        id: 'session-tree-overlap',
        connectedClientId: 'client-1',
        eventBuffer: new EventBuffer(100),
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          thinkingLevel: 'default',
          getAvailableThinkingLevels: () => [],
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'session-tree-overlap',
          sessionName: undefined,
          autoCompactionEnabled: false,
          bindExtensions: async () => {},
          modelRuntime: { getAvailable: async () => [] },
          clearQueue: () => ({ steering: [], followUp: [] }),
          navigateTree,
          sessionManager: {
            appendLabelChange: vi.fn(),
            getTree: () => [],
            getLeafId: () => null,
            getBranch: () => [],
            buildContextEntries: () => [],
          },
        } as any,
      });

      const sessions = new Map([['session-tree-overlap', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      const firstRequest = handler.handleMessage(
        JSON.stringify({
          type: 'navigate_tree',
          sessionId: 'session-tree-overlap',
          targetId: 'entry-first',
          id: 'req-navigate-first',
        }),
      );

      await Promise.resolve();

      await handler.handleMessage(
        JSON.stringify({
          type: 'navigate_tree',
          sessionId: 'session-tree-overlap',
          targetId: 'entry-second',
          id: 'req-navigate-second',
        }),
      );

      expect(findResponse(sent, 'req-navigate-second')).toEqual({
        id: 'req-navigate-second',
        success: false,
        error: 'Tree navigation already in progress',
      });

      expect(findEvents(sent, 'tree_navigation_start')).toHaveLength(1);
      expect(findEvents(sent, 'tree_navigation_end')).toHaveLength(0);

      resolveNavigation?.({ cancelled: true });
      await firstRequest;

      expect(findEvents(sent, 'tree_navigation_end')).toHaveLength(1);
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

    it('treats empty labels as a clear operation', async () => {
      const appendLabelChange = vi.fn();
      const session = createMockSlot({ id: 'session-tree-label-clear', connectedClientId: 'client-1' });
      (session.session as any).sessionManager = {
        appendLabelChange,
        getTree: () => [],
        getLeafId: () => null,
      };

      const sessions = new Map([['session-tree-label-clear', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'set_tree_label',
          sessionId: 'session-tree-label-clear',
          entryId: 'entry-clear',
          label: '',
          id: 'req-set-tree-label-clear',
        }),
      );

      expect(appendLabelChange).toHaveBeenCalledWith('entry-clear', undefined);
      expect(findResponse(sent, 'req-set-tree-label-clear')).toEqual({
        id: 'req-set-tree-label-clear',
        success: true,
        data: { success: true },
      });
    });
  });

  describe('call_end', () => {
    it('routes call_ended to the call owner, not the requesting client (#9)', async () => {
      const slot = createMockSlot({ id: 'call-session', connectedClientId: 'A' });
      const sessions = new Map([['call-session', slot]]);
      const sessionManager = createMockSessionManager(sessions);
      const clientRegistry: ClientRegistry = new Map();

      const endCall = vi.fn(async () => {});
      const orchestrator = { endCall, isCallActive: () => true } as any;

      const { ws: wsA, sent: sentA } = createMockWs();
      const handlerA = new WsHandler(
        sessionManager,
        createMockSessionRecords(),
        wsA,
        createMockPushService(),
        createMockSessionMetadataStore() as any,
        'A',
        clientRegistry,
        orchestrator,
      );
      clientRegistry.set('A', handlerA);

      const { ws: wsB, sent: sentB } = createMockWs();
      const handlerB = new WsHandler(
        sessionManager,
        createMockSessionRecords(),
        wsB,
        createMockPushService(),
        createMockSessionMetadataStore() as any,
        'B',
        clientRegistry,
        orchestrator,
      );
      clientRegistry.set('B', handlerB);

      // Non-owner B ends the call.
      await handlerB.handleMessage(JSON.stringify({ type: 'call_end', sessionId: 'call-session', id: 'req-end' }));

      expect(endCall).toHaveBeenCalledWith({ sessionId: 'call-session', reason: 'user_hangup' });
      // Owner A is told the call ended; requester B is not.
      expect(findEvents(sentA, 'call_ended')).toHaveLength(1);
      expect(findEvents(sentB, 'call_ended')).toHaveLength(0);
      // B still gets its command response.
      expect(findResponse(sentB, 'req-end')!.success).toBe(true);
    });
  });

  describe('get_session_meta', () => {
    it('returns the cached git branch (no synchronous git shell-out on the hot path)', async () => {
      const session = createMockSlot({
        id: 'session-meta',
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          sessionId: 'session-meta',
          getContextUsage: () => null,
          sessionManager: { getEntries: () => [] },
        },
      });
      const sessions = new Map([['session-meta', session]]);
      const { handler, sent, sessionManager } = createTestHandler('client-1', { sessions });
      // Cache populated by the branch poll / open seed; hot path reads it.
      (sessionManager as any).getLastKnownGitBranch = (id: string) => (id === 'session-meta' ? 'feature-x' : null);

      await handler.handleMessage(JSON.stringify({ type: 'get_session_meta', sessionId: 'session-meta', id: 'req-meta' }));

      const resp = findResponse(sent, 'req-meta');
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).meta.gitBranch).toBe('feature-x');
    });

    it('prices the next round-trip lower bound at the model cache-read rate', async () => {
      const session = createMockSlot({
        id: 'session-cost',
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          // cacheRead is USD per MILLION tokens.
          model: { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
          sessionId: 'session-cost',
          getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
          sessionManager: { getEntries: () => [] },
        },
      });
      const sessions = new Map([['session-cost', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'get_session_meta', sessionId: 'session-cost', id: 'req-cost' }));

      const meta = (findResponse(sent, 'req-cost')!.data as any).meta;
      // 50_000 tokens * 0.3 / 1e6 = 0.015
      expect(meta.nextRoundtripCostUsd).toBeCloseTo(0.015, 10);
    });

    it('reports a null next round-trip cost when context tokens or pricing are unknown', async () => {
      const session = createMockSlot({
        id: 'session-nocost',
        session: {
          subscribe: () => () => {},
          dispose: () => {},
          messages: [],
          model: null,
          sessionId: 'session-nocost',
          getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
          sessionManager: { getEntries: () => [] },
        },
      });
      const sessions = new Map([['session-nocost', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(JSON.stringify({ type: 'get_session_meta', sessionId: 'session-nocost', id: 'req-nocost' }));

      const meta = (findResponse(sent, 'req-nocost')!.data as any).meta;
      expect(meta.nextRoundtripCostUsd).toBeNull();
    });
  });

  describe('fork command', () => {
    it('responds with error when sessionId is missing', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          entryId: 'entry-123',
          id: 'req-fork-no-session',
        }),
      );

      const resp = findResponse(sent, 'req-fork-no-session');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('sessionId');
    });

    it('responds with error when session does not exist', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'nonexistent',
          entryId: 'entry-123',
          id: 'req-fork-no-slot',
        }),
      );

      const resp = findResponse(sent, 'req-fork-no-slot');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('not found');
    });

    it('responds with error when entryId is missing', async () => {
      const session = createMockSlot({
        id: 'session-fork',
        connectedClientId: 'client-1',
      });

      const sessions = new Map([['session-fork', session]]);
      const { handler, sent } = createTestHandler('client-1', { sessions });

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'session-fork',
          id: 'req-fork-no-entry',
        }),
      );

      const resp = findResponse(sent, 'req-fork-no-entry');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(false);
      expect(resp!.error).toContain('entryId');
    });

    it('calls runtime.fork with entryId and returns selectedText and cancelled from result', async () => {
      const forkFn = vi.fn().mockResolvedValue({
        cancelled: false,
        selectedText: 'forked message text',
      });

      const mockSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [{ role: 'user', content: [{ type: 'text', text: 'original' }] }],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: 'session-fork-ok',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async () => {},
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;

      const slot = createMockSlot({
        id: 'session-fork-ok',
        connectedClientId: 'client-1',
        session: mockSession,
      });
      (slot.runtime as any).fork = forkFn;

      const sessions = new Map([['session-fork-ok', slot]]);
      const sessionManager = createMockSessionManager(sessions);
      (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
        s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      // First open the session to establish connection
      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-fork-ok',
          id: 'req-open-fork',
        }),
      );

      sent.length = 0;

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'session-fork-ok',
          entryId: 'entry-target-42',
          id: 'req-fork-ok',
        }),
      );

      expect(forkFn).toHaveBeenCalledWith('entry-target-42');

      const resp = findResponse(sent, 'req-fork-ok');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).cancelled).toBe(false);
      expect((resp!.data as any).selectedText).toBe('forked message text');
    });

    it('returns cancelled: true when runtime.fork is cancelled and does not trigger session reset', async () => {
      const forkFn = vi.fn().mockResolvedValue({ cancelled: true });

      const mockSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: 'session-fork-cancel',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async () => {},
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;

      const slot = createMockSlot({
        id: 'session-fork-cancel',
        connectedClientId: 'client-1',
        session: mockSession,
      });
      (slot.runtime as any).fork = forkFn;

      const sessions = new Map([['session-fork-cancel', slot]]);
      const sessionManager = createMockSessionManager(sessions);

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-fork-cancel',
          id: 'req-open-fork-cancel',
        }),
      );

      sent.length = 0;

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'session-fork-cancel',
          entryId: 'entry-cancel-target',
          id: 'req-fork-cancel',
        }),
      );

      const resp = findResponse(sent, 'req-fork-cancel');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).cancelled).toBe(true);
      expect((resp!.data as any).selectedText).toBeUndefined();

      // No session_replaced or full_resync events when cancelled
      expect(findEvents(sent, 'session_replaced')).toHaveLength(0);
      expect(findEvents(sent, 'full_resync')).toHaveLength(0);
    });

    it('triggers session_replaced when fork changes the session ID', async () => {
      const forkFn = vi.fn().mockImplementation(async () => {
        mockSession.sessionId = 'forked-session-new';
        return { cancelled: false, selectedText: 'text from fork' };
      });

      const mockSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: 'session-fork-replace',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async () => {},
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;

      const slot = createMockSlot({
        id: 'session-fork-replace',
        connectedClientId: null,
        session: mockSession,
      });
      (slot.runtime as any).fork = forkFn;

      const sessions = new Map([['session-fork-replace', slot]]);
      const sessionManager = createMockSessionManager(sessions);
      (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
        s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-fork-replace',
          id: 'req-open-fork-replace',
        }),
      );

      sent.length = 0;

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'session-fork-replace',
          entryId: 'entry-fork-target',
          id: 'req-fork-replace',
        }),
      );

      const replaced = findEvents(sent, 'session_replaced');
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as any).oldSessionId).toBe('session-fork-replace');
      expect((replaced[0] as any).newSessionId).toBe('forked-session-new');

      const resp = findResponse(sent, 'req-fork-replace');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).cancelled).toBe(false);
      expect((resp!.data as any).selectedText).toBe('text from fork');
    });

    it('omits selectedText from response when runtime does not provide it', async () => {
      const forkFn = vi.fn().mockResolvedValue({ cancelled: false });

      const mockSession = {
        subscribe: () => () => {},
        dispose: () => {},
        messages: [],
        model: null,
        thinkingLevel: 'default',
        getAvailableThinkingLevels: () => [],
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: 'session-fork-notext',
        sessionName: undefined,
        autoCompactionEnabled: false,
        bindExtensions: async () => {},
        modelRuntime: { getAvailable: async () => [] },
        clearQueue: () => ({ steering: [], followUp: [] }),
        sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      } as any;

      const slot = createMockSlot({
        id: 'session-fork-notext',
        connectedClientId: 'client-1',
        session: mockSession,
      });
      (slot.runtime as any).fork = forkFn;

      const sessions = new Map([['session-fork-notext', slot]]);
      const sessionManager = createMockSessionManager(sessions);
      (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
        s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
      };

      const clientRegistry: ClientRegistry = new Map();
      const { ws, sent } = createMockWs();
      const sessionRecords = createMockSessionRecords();
      const pushService = createMockPushService();

      const handler = new WsHandler(sessionManager, sessionRecords, ws, pushService, createMockSessionMetadataStore() as any, 'client-1', clientRegistry);
      clientRegistry.set('client-1', handler);

      await handler.handleMessage(
        JSON.stringify({
          type: 'open_session',
          folderPath: '/home/user/project',
          sessionId: 'session-fork-notext',
          id: 'req-open-fork-notext',
        }),
      );

      sent.length = 0;

      await handler.handleMessage(
        JSON.stringify({
          type: 'fork',
          sessionId: 'session-fork-notext',
          entryId: 'entry-notext',
          id: 'req-fork-notext',
        }),
      );

      const resp = findResponse(sent, 'req-fork-notext');
      expect(resp).toBeDefined();
      expect(resp!.success).toBe(true);
      expect((resp!.data as any).cancelled).toBe(false);
      expect(resp!.data as any).not.toHaveProperty('selectedText');
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
          getAvailableThinkingLevels: () => [],
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'session-1',
          sessionName: undefined,
          autoCompactionEnabled: false,
          bindExtensions: async () => {},
          modelRuntime: { getAvailable: async () => [] },
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

    it('renames an inactive persisted session via SessionRecords', async () => {
      const renameSession = vi.fn().mockResolvedValue(true);
      const sessionRecords = {
        ...createMockSessionRecords(),
        renameSession,
      } as unknown as SessionRecords;
      const { handler, sent } = createTestHandler('client-1', { sessionRecords });

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

  describe('session name state broadcasts', () => {
    it('sends an explicit empty name when a live session name is cleared', () => {
      const slot = createMockSlot({ id: 'session-1', folderPath: '/home/user/project' });
      (slot.session as any).sessionName = undefined;
      const manager = createMockSessionManager(new Map([['session-1', slot]]));
      const events: PimoteEvent[] = [];
      const clients = new Map([
        [
          'client-1',
          {
            sendToClient: (event: PimoteEvent) => events.push(event),
          } as any,
        ],
      ]) as unknown as ClientRegistry;

      WsHandler.broadcastSidebarUpdate('session-1', '/home/user/project', manager, clients);

      expect(findEvents(events, 'session_state_changed')).toMatchObject([{ sessionId: 'session-1', sessionName: '' }]);
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
        { name: 'tree', description: 'Navigate session history tree', hasArgCompletions: false },
        { name: 'login', description: 'Log in to a model provider', hasArgCompletions: false },
        { name: 'logout', description: 'Log out from a model provider', hasArgCompletions: false },
        { name: 'compact', description: 'Manually compact the session context', hasArgCompletions: false },
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
      expect(commands).toHaveLength(8);
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
      expect(commands).toHaveLength(7);
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
      expect(commands).toHaveLength(8);
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
      expect(commands[4]).toEqual({
        name: 'tree',
        description: 'Navigate session history tree',
        hasArgCompletions: false,
      });
      expect(commands[5]).toEqual({
        name: 'login',
        description: 'Log in to a model provider',
        hasArgCompletions: false,
      });
      expect(commands[6]).toEqual({
        name: 'logout',
        description: 'Log out from a model provider',
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
      expect(commands).toHaveLength(9);
      expect(commands[0].name).toBe('skill:brainstorm');
      expect(commands[1].name).toBe('fix-bug');
      expect(commands[2].name).toBe('deploy');
      expect(commands[3].name).toBe('new');
      expect(commands[4].name).toBe('reload');
      expect(commands[5].name).toBe('tree');
      expect(commands[6].name).toBe('login');
      expect(commands[7].name).toBe('logout');
      expect(commands[8].name).toBe('compact');
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
      // Should still return the built-in commands (new/reload/tree/login/logout/compact)
      expect((resp!.data as any).commands).toHaveLength(7);
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

  describe('list_folders', () => {
    it('includes roots and serves registry FolderInfo rows with live session counts', async () => {
      const repoIndex = { roots: ['/home/user/projects', '/opt/repos'], list: async () => [] } as unknown as RepoIndex;
      const personaRow = folderRow('/home/user/projects/agent', {
        nature: 'persona',
        persona: { name: 'Helper', description: 'helps' },
        favorite: true,
        tags: ['x'],
        userTags: ['x'],
      });
      const folderRegistry = { list: async () => [personaRow, folderRow('/home/user/projects/api')] } as unknown as FolderRegistry;
      const sessions = new Map<string, ManagedSlot>([
        ['s1', createMockSlot({ id: 's1', folderPath: '/home/user/projects/agent' })],
        ['s2', createMockSlot({ id: 's2', folderPath: '/home/user/projects/agent' })],
      ]);
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry, sessions });

      await handler.handleMessage(JSON.stringify({ type: 'list_folders', id: 'req-list' }));

      const resp = findResponse(sent, 'req-list');
      expect(resp!.success).toBe(true);
      const data = resp!.data as { roots: string[]; folders: FolderInfo[] };
      expect(data.roots).toEqual(['/home/user/projects', '/opt/repos']);
      expect(data.folders).toHaveLength(2);
      expect(data.folders[0]).toMatchObject({
        path: '/home/user/projects/agent',
        nature: 'persona',
        persona: { name: 'Helper', description: 'helps' },
        favorite: true,
        tags: ['x'],
        userTags: ['x'],
        activeSessionCount: 2,
      });
      expect(data.folders[1]).toMatchObject({ path: '/home/user/projects/api', nature: 'code', activeSessionCount: 0 });
    });

    it('serves one window through the folder listing service and maps the window fields onto the response', async () => {
      const query = vi.fn(async () => ({ rows: [folderRow('/w/a')], total: 3, more: true, orderToken: 'tok-2', epoch: 5 }));
      const folderListing = {
        pin: async () => ({ token: 'tok-2', epoch: 5 }),
        query,
        buildDelta: async () => ({ type: 'folders_changed' as const, changed: [], removedPaths: [], epoch: 5 }),
        invalidateSessionMetadata: () => {},
      } as unknown as FolderListingService;
      const repoIndex = { roots: ['/w'], list: async () => [] } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [] } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry, folderListing });

      await handler.handleMessage(JSON.stringify({ type: 'list_folders', id: 'req-win', offset: 10, limit: 5, query: 'x', includeArchived: true, orderToken: 'tok-1' }));

      expect(query).toHaveBeenCalledWith({ token: 'tok-1', offset: 10, limit: 5, query: 'x', includeArchived: true });
      const data = findResponse(sent, 'req-win')!.data as { folders: FolderInfo[]; roots: string[]; total: number; orderToken: string; more: boolean };
      expect(data.folders).toEqual([folderRow('/w/a')]);
      expect(data.roots).toEqual(['/w']);
      expect(data.total).toBe(3);
      expect(data.orderToken).toBe('tok-2');
      expect(data.more).toBe(true);
    });
  });

  describe('update_folder', () => {
    it('forwards the curation patch keyed by folderPath', async () => {
      const update = vi.fn(async () => {});
      const repoIndex = { roots: ['/w'], list: async () => [] } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [], update } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'update_folder', id: 'req-up', folderPath: '/w/a', favorite: true, addTags: ['x'], removeTags: ['y'] }));

      expect(update).toHaveBeenCalledWith({ folderPath: '/w/a', favorite: true, archived: undefined, addTags: ['x'], removeTags: ['y'] });
      expect(findResponse(sent, 'req-up')).toMatchObject({ success: true });
    });

    it('surfaces an unknown-folder rejection as an error response', async () => {
      const repoIndex = { roots: ['/w'], list: async () => [] } as unknown as RepoIndex;
      const folderRegistry = {
        list: async () => [],
        update: async () => {
          throw new Error('Unknown folder: /w/nope');
        },
      } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'update_folder', id: 'req-up-err', folderPath: '/w/nope', favorite: true }));

      expect(findResponse(sent, 'req-up-err')).toMatchObject({ success: false, error: 'Unknown folder: /w/nope' });
    });
  });

  describe('create_hub', () => {
    it('rejects a root outside the configured roots without touching the registry', async () => {
      const createHub = vi.fn();
      const invalidate = vi.fn();
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [], createHub } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'create_hub', id: 'req-ch-1', name: 'hub', root: '/tmp/hacked', memberPaths: ['/home/user/projects/a'] }));

      expect(findResponse(sent, 'req-ch-1')).toMatchObject({ success: false, error: 'Root is not a configured scan root' });
      expect(createHub).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('creates the hub with memberPaths, responds with folderPath, and invalidates the repo index', async () => {
      const invalidate = vi.fn();
      const createHub = vi.fn(async () => folderRow('/home/user/projects/hub', { repos: [] }));
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [], createHub } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(
        JSON.stringify({ type: 'create_hub', id: 'req-ch-2', name: 'hub', root: '/home/user/projects', memberPaths: ['/home/user/projects/a', '/home/user/projects/b'] }),
      );

      expect(createHub).toHaveBeenCalledWith({ name: 'hub', root: '/home/user/projects', memberPaths: ['/home/user/projects/a', '/home/user/projects/b'] });
      expect(findResponse(sent, 'req-ch-2')).toMatchObject({ success: true, data: { folderPath: '/home/user/projects/hub' } });
      expect(invalidate).toHaveBeenCalledOnce();
    });

    it('surfaces hub validation errors without invalidating the index', async () => {
      const invalidate = vi.fn();
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = {
        list: async () => [],
        createHub: async () => {
          throw new Error('Unknown repo: /home/user/projects/ghost');
        },
      } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'create_hub', id: 'req-ch-3', name: 'hub', root: '/home/user/projects', memberPaths: ['/home/user/projects/ghost'] }));

      expect(findResponse(sent, 'req-ch-3')).toMatchObject({ success: false, error: 'Unknown repo: /home/user/projects/ghost' });
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('disband_hub', () => {
    it('disbands by folderPath and invalidates the repo index', async () => {
      const invalidate = vi.fn();
      const disbandHub = vi.fn(async () => {});
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [], disbandHub } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'disband_hub', id: 'req-dh-1', folderPath: '/home/user/projects/hub' }));

      expect(disbandHub).toHaveBeenCalledWith('/home/user/projects/hub');
      expect(findResponse(sent, 'req-dh-1')).toMatchObject({ success: true });
      expect(invalidate).toHaveBeenCalledOnce();
    });

    it('surfaces disband errors without invalidating the index', async () => {
      const invalidate = vi.fn();
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = {
        list: async () => [],
        disbandHub: async () => {
          throw new Error('Not a hub folder: /home/user/projects/x');
        },
      } as unknown as FolderRegistry;
      const { handler, sent } = createTestHandler('client-1', { repoIndex, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'disband_hub', id: 'req-dh-2', folderPath: '/home/user/projects/x' }));

      expect(findResponse(sent, 'req-dh-2')).toMatchObject({ success: false, error: 'Not a hub folder: /home/user/projects/x' });
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('folders_changed broadcast', () => {
    it('sends the listing service-built delta to every connected client', async () => {
      const delta = { type: 'folders_changed' as const, changed: [folderRow('/w/a')], removedPaths: ['/w/gone'], epoch: 7 };
      const buildDelta = vi.fn(async () => delta);
      const folderListing = { buildDelta } as unknown as FolderListingService;
      const clientRegistry: ClientRegistry = new Map();
      const a = createTestHandler('A', { clientRegistry });
      const b = createTestHandler('B', { clientRegistry });
      a.sent.length = 0;
      b.sent.length = 0;

      WsHandler.broadcastFoldersChanged(folderListing, ['/w/a'], ['/w/gone'], clientRegistry);
      await flushPromises();

      // Each mutation site reports the paths it touched; only sending happens here.
      expect(buildDelta).toHaveBeenCalledWith(['/w/a'], ['/w/gone']);
      for (const sent of [a.sent, b.sent]) {
        expect(findEvents(sent, 'folders_changed')).toEqual([delta]);
      }
    });
  });

  describe('create_folder', () => {
    it('rejects empty name', async () => {
      const sessionRecords = createMockSessionRecords();
      const { handler, sent } = createTestHandler('client-1', { sessionRecords });

      await handler.handleMessage(JSON.stringify({ type: 'create_folder', root: '/home/user/projects', name: '', id: 'req-cp-1' }));

      const resp = findResponse(sent, 'req-cp-1');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('Invalid folder name');
    });

    it('rejects name with path separators', async () => {
      const sessionRecords = createMockSessionRecords();
      const { handler, sent } = createTestHandler('client-1', { sessionRecords });

      await handler.handleMessage(JSON.stringify({ type: 'create_folder', root: '/home/user/projects', name: 'foo/bar', id: 'req-cp-2' }));

      const resp = findResponse(sent, 'req-cp-2');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('Invalid folder name');
    });

    it('rejects . and .. names', async () => {
      const sessionRecords = createMockSessionRecords();
      const { handler, sent } = createTestHandler('client-1', { sessionRecords });

      await handler.handleMessage(JSON.stringify({ type: 'create_folder', root: '/home/user/projects', name: '..', id: 'req-cp-3' }));

      const resp = findResponse(sent, 'req-cp-3');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('Invalid folder name');
    });

    it('rejects root not in configured roots', async () => {
      // Creation-root checks read config roots from the RepoIndex, not from
      // SessionRecords — the record holder performs no folder discovery.
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [] } as unknown as RepoIndex;
      const { handler, sent } = createTestHandler('client-1', { repoIndex });

      await handler.handleMessage(JSON.stringify({ type: 'create_folder', root: '/tmp/hacked', name: 'evil', id: 'req-cp-4' }));

      const resp = findResponse(sent, 'req-cp-4');
      expect(resp!.success).toBe(false);
      expect(resp!.error).toBe('Root is not a configured scan root');
    });

    it('broadcasts a folders_changed delta naming the created folder and invalidates the repo index', async () => {
      const invalidate = vi.fn();
      const buildDelta = vi.fn(async () => ({ type: 'folders_changed' as const, changed: [folderRow('/home/user/projects/new')], removedPaths: [], epoch: 1 }));
      const folderListing = { buildDelta } as unknown as FolderListingService;
      const repoIndex = { roots: ['/home/user/projects'], list: async () => [], invalidate } as unknown as RepoIndex;
      const folderRegistry = { list: async () => [folderRow('/home/user/projects/new')] } as unknown as FolderRegistry;
      const creators = [
        {
          describe: () => ({ paramSchema: { root: {}, name: {} } }),
          create: async ({ root, name }: { root: string; name: string }) => ({ path: `${root}/${name}` }),
        } as unknown as FolderCreator,
      ];
      const clientRegistry: ClientRegistry = new Map();
      const a = createTestHandler('A', { repoIndex, folderRegistry, creators, clientRegistry, folderListing });
      const b = createTestHandler('B', { repoIndex, folderRegistry, creators, clientRegistry, folderListing });
      a.sent.length = 0;
      b.sent.length = 0;

      await a.handler.handleMessage(JSON.stringify({ type: 'create_folder', root: '/home/user/projects', name: 'new', id: 'req-cp-5' }));

      expect(findResponse(a.sent, 'req-cp-5')).toMatchObject({ success: true, data: { folderPath: '/home/user/projects/new' } });
      expect(invalidate).toHaveBeenCalledOnce();
      await flushPromises();
      // The mutation site reports exactly the path it created.
      expect(buildDelta).toHaveBeenCalledWith(['/home/user/projects/new'], []);
      expect(findEvents(a.sent, 'folders_changed')).toHaveLength(1);
      expect(findEvents(b.sent, 'folders_changed')).toHaveLength(1);
    });
  });

  describe('session folder resolution (session events)', () => {
    it('serves the registry FolderInfo row (persona metadata + curation) in session_opened', async () => {
      const row = folderRow('/home/user/projects/agent', {
        nature: 'persona',
        persona: { name: 'Helper', description: 'helps' },
        shortcutCount: 2,
        favorite: true,
        archived: true,
        tags: ['t'],
        userTags: ['t'],
      });
      const update = vi.fn(async () => {});
      const folderRegistry = { list: async () => [row], update } as unknown as FolderRegistry;
      const sessions = new Map<string, ManagedSlot>([['new-session-id', createMockSlot({ id: 'new-session-id', folderPath: '/home/user/projects/agent' })]]);
      const { handler, sent } = createTestHandler('client-1', { sessions, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: '/home/user/projects/agent', id: 'req-open-listed' }));

      expect(findResponse(sent, 'req-open-listed')).toMatchObject({ success: true, data: { sessionId: 'new-session-id' } });
      const opened = findEvents(sent, 'session_opened');
      expect(opened).toHaveLength(1);
      expect((opened[0] as any).folder).toMatchObject({
        path: '/home/user/projects/agent',
        name: 'agent',
        nature: 'persona',
        persona: { name: 'Helper', description: 'helps' },
        shortcutCount: 2,
        favorite: true,
        archived: true,
        tags: ['t'],
        userTags: ['t'],
        missing: false,
        activeSessionCount: 1,
        externalProcessCount: 0,
      });
    });

    it('classifies an unlisted cwd on the fly and never lists or curates it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pimote-folder-'));
      writeFileSync(join(dir, 'AGENTS.md'), '---\nname: Sidekick\ndescription: runs errands\n---\n\n# Sidekick\n');
      try {
        const update = vi.fn(async () => {});
        const folderRegistry = { list: async () => [], update } as unknown as FolderRegistry;
        const sessions = new Map<string, ManagedSlot>([['new-session-id', createMockSlot({ id: 'new-session-id', folderPath: dir })]]);
        const { handler, sent } = createTestHandler('client-1', { sessions, folderRegistry });

        await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: dir, id: 'req-open-persona' }));

        const opened = findEvents(sent, 'session_opened');
        expect(opened).toHaveLength(1);
        expect((opened[0] as any).folder).toMatchObject({
          path: dir,
          name: basename(dir),
          nature: 'persona',
          persona: { name: 'Sidekick', description: 'runs errands' },
          shortcutCount: 0,
          favorite: false,
          archived: false,
          tags: [],
          missing: false,
          activeSessionCount: 1,
          externalProcessCount: 0,
        });
        // Opening a session in an unlisted cwd neither lists nor curates it.
        expect(update).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('serves an unlisted code cwd as a plain fallback row', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pimote-folder-'));
      try {
        const folderRegistry = { list: async () => [] } as unknown as FolderRegistry;
        const sessions = new Map<string, ManagedSlot>([['new-session-id', createMockSlot({ id: 'new-session-id', folderPath: dir })]]);
        const { handler, sent } = createTestHandler('client-1', { sessions, folderRegistry });

        await handler.handleMessage(JSON.stringify({ type: 'open_session', folderPath: dir, id: 'req-open-code' }));

        const opened = findEvents(sent, 'session_opened');
        expect((opened[0] as any).folder).toMatchObject({
          path: dir,
          name: basename(dir),
          nature: 'code',
          shortcutCount: 0,
          favorite: false,
          archived: false,
          tags: [],
          missing: false,
          activeSessionCount: 1,
        });
        expect((opened[0] as any).folder.persona).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves the folder row for takeover_folder', async () => {
      const row = folderRow('/home/user/projects/agent', { favorite: true, tags: ['kept'] });
      const folderRegistry = { list: async () => [row] } as unknown as FolderRegistry;
      const sessions = new Map<string, ManagedSlot>([['new-session-id', createMockSlot({ id: 'new-session-id', folderPath: '/home/user/projects/agent' })]]);
      const { handler, sent } = createTestHandler('client-1', { sessions, folderRegistry });

      await handler.handleMessage(JSON.stringify({ type: 'takeover_folder', folderPath: '/home/user/projects/agent', id: 'req-takeover' }));

      expect(findResponse(sent, 'req-takeover')).toMatchObject({ success: true, data: { sessionId: 'new-session-id' } });
      const opened = findEvents(sent, 'session_opened');
      expect(opened).toHaveLength(1);
      expect((opened[0] as any).folder).toMatchObject({ path: '/home/user/projects/agent', favorite: true, tags: ['kept'], activeSessionCount: 1 });
    });
  });

  describe('native bash commands', () => {
    it('rejects a bash command without its required session scope', async () => {
      const { handler, sent } = createTestHandler('client-1');

      await handler.handleMessage(JSON.stringify({ type: 'bash', id: 'bash-no-session', command: 'pwd' }));

      expect(findResponse(sent, 'bash-no-session')).toMatchObject({ success: false, error: 'sessionId is required' });
    });

    it('executes a visible bash command while the model streams and returns its native result', async () => {
      const slot = createMockSlot({ id: 'session-bash', connectedClientId: 'client-1' });
      const executeBash = vi.fn(async () => ({ output: 'hello\\n', exitCode: 0, cancelled: false, truncated: false }));
      const recordBashResult = vi.fn();
      const emitUserBash = vi.fn(async () => undefined);
      (slot.session as any).executeBash = executeBash;
      (slot.session as any).recordBashResult = recordBashResult;
      (slot.session as any).extensionRunner = { emitUserBash };
      (slot.session as any).isBashRunning = false;
      (slot.session as any).isStreaming = true;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(
        JSON.stringify({
          type: 'bash',
          id: 'bash-request-1',
          sessionId: slot.sessionState.id,
          command: "printf 'hello\\n'",
          excludeFromContext: false,
        }),
      );

      expect(emitUserBash).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user_bash',
          command: "printf 'hello\\n'",
          excludeFromContext: false,
          cwd: slot.folderPath,
        }),
      );
      expect(executeBash).toHaveBeenCalledWith("printf 'hello\\n'", undefined, {
        id: 'bash-request-1',
        excludeFromContext: false,
        operations: undefined,
      });
      // executeBash records its own native result. Recording it again would
      // duplicate the entry in Pi history.
      expect(recordBashResult).not.toHaveBeenCalled();
      expect(findResponse(sent, 'bash-request-1')).toMatchObject({
        success: true,
        data: { result: { output: 'hello\\n', exitCode: 0, cancelled: false, truncated: false } },
      });
    });

    it('fails closed with a distinct error when the user_bash extension handler throws', async () => {
      const slot = createMockSlot({ id: 'session-bash-throws', connectedClientId: 'client-1' });
      const executeBash = vi.fn();
      const recordBashResult = vi.fn();
      (slot.session as any).executeBash = executeBash;
      (slot.session as any).recordBashResult = recordBashResult;
      (slot.session as any).extensionRunner = {
        emitUserBash: vi.fn(async () => {
          throw new Error('handler boom');
        }),
      };
      (slot.session as any).isBashRunning = false;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(JSON.stringify({ type: 'bash', id: 'bash-request-throws', sessionId: slot.sessionState.id, command: 'pwd' }));

      // Fail-closed: neither local execution nor extension result recording runs.
      expect(executeBash).not.toHaveBeenCalled();
      expect(recordBashResult).not.toHaveBeenCalled();
      // Dispatch flags are reset by the case's finally, so the next command is admissible.
      expect(slot.sessionState.bashDispatchInProgress).toBe(false);
      expect(findResponse(sent, 'bash-request-throws')).toMatchObject({ success: false, error: 'bash_extension_error' });
    });

    it('passes extension-provided operations into native execution', async () => {
      const slot = createMockSlot({ id: 'session-bash-operations', connectedClientId: 'client-1' });
      const executeBash = vi.fn(async () => ({ output: 'remote\\n', exitCode: 0, cancelled: false, truncated: false }));
      const operations = {};
      (slot.session as any).executeBash = executeBash;
      (slot.session as any).extensionRunner = { emitUserBash: vi.fn(async () => ({ operations })) };
      (slot.session as any).isBashRunning = false;
      const { handler } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(JSON.stringify({ type: 'bash', id: 'bash-request-operations', sessionId: slot.sessionState.id, command: 'pwd' }));

      expect(executeBash).toHaveBeenCalledWith('pwd', undefined, expect.objectContaining({ operations }));
    });

    it('records an extension-handled !! result without executing or duplicating native bash', async () => {
      const slot = createMockSlot({ id: 'session-bash-excluded', connectedClientId: 'client-1' });
      const executeBash = vi.fn();
      const recordBashResult = vi.fn();
      const result = {
        output: 'secret\\n',
        exitCode: 17,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/pimote-bash-output.log',
      };
      (slot.session as any).executeBash = executeBash;
      (slot.session as any).recordBashResult = recordBashResult;
      (slot.session as any).extensionRunner = { emitUserBash: vi.fn(async () => ({ result })) };
      (slot.session as any).isBashRunning = false;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(
        JSON.stringify({
          type: 'bash',
          id: 'bash-request-2',
          sessionId: slot.sessionState.id,
          command: 'printf secret',
          excludeFromContext: true,
        }),
      );

      expect(executeBash).not.toHaveBeenCalled();
      expect(recordBashResult).toHaveBeenCalledWith('printf secret', result, { excludeFromContext: true });
      expect(findResponse(sent, 'bash-request-2')).toMatchObject({ success: true, data: { result } });
    });

    it('rejects a second bash while native execution is running without invoking an extension or process', async () => {
      const slot = createMockSlot({ id: 'session-bash-conflict', connectedClientId: 'client-1' });
      const executeBash = vi.fn(async () => ({ output: '', exitCode: 0, cancelled: false, truncated: false }));
      const emitUserBash = vi.fn();
      (slot.session as any).executeBash = executeBash;
      (slot.session as any).extensionRunner = { emitUserBash };
      (slot.session as any).isBashRunning = true;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(JSON.stringify({ type: 'bash', id: 'bash-request-3', sessionId: slot.sessionState.id, command: 'echo second' }));

      expect(emitUserBash).not.toHaveBeenCalled();
      expect(executeBash).not.toHaveBeenCalled();
      expect(findResponse(sent, 'bash-request-3')).toMatchObject({ success: false, error: 'bash_already_running' });
    });

    it('issues native abortBash for abort_bash without aborting the model stream', async () => {
      const slot = createMockSlot({ id: 'session-bash-abort', connectedClientId: 'client-1' });
      const abortBash = vi.fn();
      const abort = vi.fn(async () => {});
      (slot.session as any).abortBash = abortBash;
      (slot.session as any).abort = abort;
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });

      await handler.handleMessage(JSON.stringify({ type: 'abort_bash', id: 'bash-abort-1', sessionId: slot.sessionState.id }));

      expect(abortBash).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
      expect(findResponse(sent, 'bash-abort-1')).toMatchObject({ success: true });
    });
  });
});

describe('abort diagnostics', () => {
  it('clears queued messages before abort and returns them only after settlement', async () => {
    const slot = createMockSlot({ connectedClientId: 'client-1', status: 'working' });
    const queued = { steering: ['first', 'second'], followUp: ['later'] };
    const cancelVoice = vi.fn();
    slot.eventBusRef.current = { emit: cancelVoice } as any;
    const clearQueue = vi.fn(() => {
      expect(cancelVoice).toHaveBeenCalledWith('pimote:voice:cancel-pending', undefined);
      return queued;
    });
    (slot.session as any).clearQueue = clearQueue;
    let finishAbort: () => void = () => {};
    (slot.session as any).abort = vi.fn(() => {
      expect(clearQueue).toHaveBeenCalledOnce();
      return new Promise<void>((resolve) => {
        finishAbort = resolve;
      });
    });
    const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });
    const pending = handler.handleMessage(JSON.stringify({ type: 'abort', id: 'abort-queue', sessionId: slot.sessionState.id }));
    await vi.waitFor(() => expect((slot.session as any).abort).toHaveBeenCalledOnce());
    expect(findResponse(sent, 'abort-queue')).toBeUndefined();
    finishAbort();
    await pending;
    expect(findResponse(sent, 'abort-queue')).toMatchObject({ success: true, data: queued });
  });

  it('returns captured messages when abort rejects', async () => {
    const slot = createMockSlot({ connectedClientId: 'client-1', status: 'working' });
    const queued = { steering: ['unsent'], followUp: [] };
    (slot.session as any).clearQueue = () => queued;
    (slot.session as any).abort = async () => {
      throw new Error('abort failed');
    };
    const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });
    await handler.handleMessage(JSON.stringify({ type: 'abort', id: 'abort-error', sessionId: slot.sessionState.id }));
    expect(findResponse(sent, 'abort-error')).toMatchObject({ success: false, data: queued, error: 'abort failed' });
  });

  it('logs timeout state and returns captured messages without reporting success', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const slot = createMockSlot({ connectedClientId: 'client-1', status: 'working' });
      const unsubscribe = vi.fn();
      (slot.session as any).subscribe = () => unsubscribe;
      (slot.session as any).abort = () => new Promise(() => {});
      (slot.session as any).clearQueue = () => ({ steering: ['unsent'], followUp: [] });
      (slot.session as any).isStreaming = true;
      (slot.session as any).state = { isStreaming: false };
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });
      const pending = handler.handleMessage(JSON.stringify({ type: 'abort', id: 'abort-timeout', sessionId: slot.sessionState.id }));
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      const traces = log.mock.calls.filter(([prefix]) => prefix === '[abort_trace]').map(([, trace]) => JSON.parse(trace as string));
      expect(traces.map((trace) => trace.phase)).toEqual(['requested', 'timeout']);
      expect(traces[1]).toMatchObject({ elapsedMs: 30_000, sdkStreaming: true, coreStreaming: false, serverStatus: 'working' });
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(findResponse(sent, 'abort-timeout')).toMatchObject({ success: false, error: 'abort_timeout', data: { steering: ['unsent'], followUp: [] } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('records run boundaries and removes the diagnostic listener after abort', async () => {
    const slot = createMockSlot({ connectedClientId: 'client-1', status: 'working' });
    const unsubscribe = vi.fn();
    let listener: (event: { type: string }) => void = () => {};
    (slot.session as any).subscribe = vi.fn((onEvent) => {
      listener = onEvent;
      return unsubscribe;
    });
    (slot.session as any).abort = async () => {
      listener({ type: 'agent_end' });
      listener({ type: 'agent_settled' });
    };
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { handler, sent } = createTestHandler('client-1', { sessions: new Map([[slot.sessionState.id, slot]]) });
      await handler.handleMessage(JSON.stringify({ type: 'abort', id: 'abort-trace', sessionId: slot.sessionState.id }));
      const traces = log.mock.calls.filter(([prefix]) => prefix === '[abort_trace]').map(([, trace]) => JSON.parse(trace as string));
      expect(traces.map((trace) => trace.phase)).toEqual(['requested', 'agent_end', 'agent_settled', 'resolved']);
      expect(traces.every((trace) => trace.requestId === 'abort-trace' && trace.sessionId === slot.sessionState.id)).toBe(true);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(findResponse(sent, 'abort-trace')).toMatchObject({ success: true });
    } finally {
      log.mockRestore();
    }
  });
});

describe('panel resync requests', () => {
  function createCapturingBus(): EventBusController & { emits: Array<{ channel: string; data: unknown }> } {
    const emits: Array<{ channel: string; data: unknown }> = [];
    return {
      emits,
      emit: (channel: string, data: unknown) => {
        emits.push({ channel, data });
      },
      on: () => () => {},
      clear: () => {},
    };
  }

  it('emits pimote:panels:sync with reason "claim" when a client claims a session', async () => {
    const bus = createCapturingBus();
    const session = createMockSlot({ id: 'session-1', connectedClientId: 'client-1', eventBus: bus });
    const sessions = new Map([['session-1', session]]);
    const { handler } = createTestHandler('client-1', { sessions });

    await handler.handleMessage(
      JSON.stringify({
        type: 'open_session',
        folderPath: '/home/user/project',
        sessionId: 'session-1',
        id: 'req-claim',
      }),
    );

    const syncs = bus.emits.filter((e) => e.channel === 'pimote:panels:sync');
    expect(syncs).toHaveLength(1);
    expect(syncs[0].data).toEqual({ reason: 'claim' });
  });

  it('emits pimote:panels:sync with reason "reset" after a session replacement rebinds extensions', async () => {
    let capturedOnReset: (() => Promise<void>) | undefined;
    const bus = createCapturingBus();
    const mockAgentSession = {
      sessionId: 'old-session',
      subscribe: () => () => {},
      dispose: () => {},
      messages: [],
      model: null,
      thinkingLevel: 'default',
      getAvailableThinkingLevels: () => [],
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
      modelRuntime: { getAvailable: async () => [] },
      clearQueue: () => ({ steering: [], followUp: [] }),
      navigateTree: async () => ({ cancelled: false }),
      sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
    } as any;

    const slot = createMockSlot({ id: 'old-session', session: mockAgentSession, connectedClientId: null, eventBus: bus });
    (slot.runtime as any).newSession = async () => {
      mockAgentSession.sessionId = 'new-session';
      return { cancelled: false };
    };

    const sessions = new Map([['old-session', slot]]);
    const { handler, sessionManager } = createTestHandler('my-client', { sessions });
    (sessionManager as any).rebuildSessionState = (s: ManagedSlot) => {
      s.sessionState = { ...s.sessionState, id: s.runtime.session.sessionId };
    };

    await handler.handleMessage(
      JSON.stringify({
        type: 'open_session',
        folderPath: '/home/user/project',
        sessionId: 'old-session',
        id: 'req-open',
      }),
    );
    expect(capturedOnReset).toBeDefined();
    await capturedOnReset!();

    const syncs = bus.emits.filter((e) => e.channel === 'pimote:panels:sync');
    expect(syncs.map((s) => (s.data as { reason: string }).reason)).toEqual(['claim', 'reset']);
  });
});
