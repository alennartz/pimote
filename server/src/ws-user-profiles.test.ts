import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { QueueOwnership } from './queue-ownership.js';
import { UserProfiles, type SessionRef } from './user-profiles.js';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import { createServer, type PimoteServer } from './server.js';
import { InMemoryStaticHostRegistry } from './static-host/registry.js';
import type { DownloadItem, PimoteEvent, PimoteResponse, PimoteSessionEvent } from '../../shared/dist/index.js';
import type { EventBuffer } from './event-buffer.js';
import type { ManagedSlot, PimoteSessionManager, SessionObserver, SessionState } from './session-manager.js';
import type { SessionRecords } from './session-records.js';

// --- Harness (mirrors ws-handler.test.ts's handler/registry pair construction) ---

function createMockEventBuffer(opts?: { replayResult?: PimoteSessionEvent[] | null }): EventBuffer {
  const events = opts?.replayResult;
  const maxCursor = events && events.length > 0 ? Math.max(...events.map((e) => e.cursor)) : 0;
  return {
    replay: (fromCursor: number) => {
      if (events === null) return null;
      return (events ?? []).filter((e) => e.cursor > fromCursor);
    },
    currentCursor: maxCursor,
    onEvent: () => {},
    expectPromptEcho: () => {},
    invalidateReplay: vi.fn(),
  } as unknown as EventBuffer;
}

function createMockSlot(id: string, folderPath = '/home/user/project'): ManagedSlot {
  const mockSession = {
    subscribe: () => () => {},
    dispose: () => {},
    messages: [],
    model: null,
    thinkingLevel: 'default',
    getAvailableThinkingLevels: () => [],
    isStreaming: false,
    state: { streamingMessage: undefined, pendingToolCalls: new Set<string>() },
    isCompacting: false,
    sessionFile: undefined,
    sessionId: id,
    sessionName: undefined,
    autoCompactionEnabled: false,
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    promptTemplates: [],
    bindExtensions: async () => {},
    modelRuntime: { getAvailable: async () => [] },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sessionManager: { buildContextEntries: () => [], getBranch: () => [], getCwd: () => folderPath },
  };

  const sessionState: SessionState = {
    id,
    eventBuffer: createMockEventBuffer(),
    status: 'idle',
    needsAttention: false,
    idleSince: Date.now(),
    unsubscribe: () => {},
    pendingUiResponses: new Map(),
    extensionsBound: false,
    sessionIdentity: mockSession,
    panelState: new Map(),
    downloads: [] as DownloadItem[],
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
    queueOwnership: new QueueOwnership(),
  };

  const runtime: any = { session: mockSession, rebind: undefined };
  runtime.setRebindSession = () => {};

  const slot: ManagedSlot = {
    runtime,
    folderPath,
    eventBusRef: { current: null },
    observers: new Map(),
    sessionState,
    get session() {
      return this.runtime.session;
    },
  };
  return slot;
}

function createMockSessionManager(sessions: Map<string, ManagedSlot>): PimoteSessionManager {
  return {
    getSession: (id: string) => sessions.get(id),
    getSlot: (id: string) => sessions.get(id) ?? null,
    getAllSessions: () => Array.from(sessions.values()),
    getLastKnownGitBranch: () => null,
    withSessionOperation: async (_id: string, operation: () => Promise<unknown>) => operation(),
    attachObserver: async (id: string, observer: SessionObserver) => {
      sessions.get(id)?.observers.set(observer.clientId, observer);
    },
    detachObserver: (id: string, clientId: string, ws?: SessionObserver['ws']) => {
      const observer = sessions.get(id)?.observers.get(clientId);
      if (!observer || (ws !== undefined && observer.ws !== ws)) return;
      sessions.get(id)?.observers.delete(clientId);
    },
    closeSession: async () => {},
  } as unknown as PimoteSessionManager;
}

function createMockSessionRecords(): SessionRecords {
  return {
    listSessionRecords: async () => [],
    resolveSessionPath: async () => undefined,
  } as unknown as SessionRecords;
}

function createMockSessionMetadataStore() {
  const archived = new Set<string>();
  return {
    isArchived: (path: string) => archived.has(path),
    getArchivedLookup: (paths: string[]) => new Map(paths.map((path) => [path, archived.has(path)])),
    setArchived: async (path: string, next: boolean) => {
      if (next) archived.add(path);
      else archived.delete(path);
    },
  };
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

interface TestContext {
  handler: WsHandler;
  ws: any;
  sent: Array<PimoteEvent | PimoteResponse>;
  user: string;
}

function createTestHandler(
  clientId: string,
  opts: {
    user: string;
    userProfiles: UserProfiles;
    sessions?: Map<string, ManagedSlot>;
    clientRegistry?: ClientRegistry;
    sessionRecords?: SessionRecords;
    sessionMetadataStore?: ReturnType<typeof createMockSessionMetadataStore>;
  },
): TestContext {
  const sessions = opts.sessions ?? new Map();
  const sessionManager = createMockSessionManager(sessions);
  const clientRegistry = opts.clientRegistry ?? new Map();
  const { ws, sent } = createMockWs();
  const handler = new WsHandler(
    '/srv/manager-home',
    sessionManager,
    opts.sessionRecords ?? createMockSessionRecords(),
    ws,
    {} as any,
    (opts.sessionMetadataStore ?? createMockSessionMetadataStore()) as any,
    clientId,
    clientRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.userProfiles,
    opts.user,
  );
  clientRegistry.set(clientId, handler);
  return { handler, ws, sent, user: opts.user };
}

function findResponse(sent: Array<any>, id: string): PimoteResponse | undefined {
  return sent.find((m) => 'id' in m && m.id === id);
}

function userSessionsEvents(sent: Array<any>): Array<{ type: string; sessions: SessionRef[]; fresh: boolean }> {
  return sent.filter((m) => m.type === 'user_sessions_changed');
}

async function open(ctx: TestContext, sessionId: string, id: string): Promise<void> {
  await ctx.handler.handleMessage(JSON.stringify({ type: 'open_session', sessionId, folderPath: '/home/user/project', lastCursor: 0, id }));
  expect(findResponse(ctx.sent, id)).toMatchObject({ success: true });
}

function makeDownloads(): DownloadManagerShape {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    detach: vi.fn(),
    offer: vi.fn(),
    cancel: vi.fn(),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}
type DownloadManagerShape = ReturnType<typeof makeDownloads>;

// --- Shared state ---

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-user-profiles-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function storePath(): string {
  return join(tempDir, 'user-profiles.json');
}

const S1: SessionRef = { sessionId: 'session-1', folderPath: '/home/user/project' };

describe('user profile wire flows', () => {
  it('opens a session for one user and broadcasts the new set to their other connections only (no echo)', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const aliceB = createTestHandler('alice-b', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const bob = createTestHandler('bob', { user: 'bob', userProfiles: store, sessions, clientRegistry });

    await open(aliceA, 'session-1', 'open-a');

    expect(store.get('alice')).toEqual([S1]);
    expect(userSessionsEvents(aliceA.sent)).toEqual([]);
    expect(userSessionsEvents(aliceB.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [S1], fresh: false }]);
    expect(userSessionsEvents(bob.sent)).toEqual([]);

    // A second connection opening the same session reports no profile change — no broadcast.
    const aliceAEventsBefore = userSessionsEvents(aliceA.sent).length;
    const aliceBEventsBefore = userSessionsEvents(aliceB.sent).length;
    await open(aliceB, 'session-1', 'open-b');
    expect(userSessionsEvents(aliceA.sent)).toHaveLength(aliceAEventsBefore);
    expect(userSessionsEvents(aliceB.sent)).toHaveLength(aliceBEventsBefore);
  });

  it('unlinks the requesting user everywhere on detach_session while other users keep their link', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const aliceB = createTestHandler('alice-b', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const bob = createTestHandler('bob', { user: 'bob', userProfiles: store, sessions, clientRegistry });
    await open(aliceA, 'session-1', 'open-a');
    await open(aliceB, 'session-1', 'open-b');
    await open(bob, 'session-1', 'open-bob');

    await aliceA.handler.handleMessage(JSON.stringify({ type: 'detach_session', sessionId: 'session-1', id: 'detach-a' }));

    expect(findResponse(aliceA.sent, 'detach-a')).toMatchObject({ success: true });
    expect(store.get('alice')).toEqual([]);
    expect(store.get('bob')).toEqual([S1]);
    // Alice's other connection dropped the entry and was detached from the session.
    expect(userSessionsEvents(aliceB.sent)).toEqual([
      { type: 'user_sessions_changed', sessions: [S1], fresh: false },
      { type: 'user_sessions_changed', sessions: [], fresh: false },
    ]);
    expect(slot.observers.has('alice-b')).toBe(false);
    // Bob's link and observer are untouched.
    expect(userSessionsEvents(bob.sent)).toEqual([]);
    expect(slot.observers.has('bob')).toBe(true);
    expect(slot.observers.has('alice-a')).toBe(false);
  });

  it('keeps the profile set unchanged when a socket dies', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    await open(aliceA, 'session-1', 'open-a');

    aliceA.handler.cleanup();

    expect(store.get('alice')).toEqual([S1]);
    expect(slot.observers.has('alice-a')).toBe(false);
    expect(slot.observers.has('alice-b')).toBe(false);
  });

  it('removes an archived session from every profile and notifies each affected user, including the archiving connection', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    await store.link('alice', S1);
    await store.link('bob', S1);
    const clientRegistry: ClientRegistry = new Map();
    const sessionMetadataStore = createMockSessionMetadataStore();
    const aliceA = createTestHandler('alice-a', {
      user: 'alice',
      userProfiles: store,
      clientRegistry,
      sessionMetadataStore,
      sessionRecords: { resolveSessionPath: async () => '/tmp/archive-me.jsonl' } as unknown as SessionRecords,
    });
    const bob = createTestHandler('bob', { user: 'bob', userProfiles: store, clientRegistry, sessionMetadataStore });

    await aliceA.handler.handleMessage(JSON.stringify({ type: 'archive_session', folderPath: '/home/user/project', sessionIds: ['session-1'], archived: true, id: 'archive' }));

    expect(findResponse(aliceA.sent, 'archive')).toMatchObject({ success: true });
    expect(store.get('alice')).toEqual([]);
    expect(store.get('bob')).toEqual([]);
    // No exclusion: the archiving connection's user is affected and told too.
    expect(userSessionsEvents(aliceA.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
    expect(userSessionsEvents(bob.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
  });

  it('moves the user profile across a rekey and notifies their other connections, with no echo', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const aliceB = createTestHandler('alice-b', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    await open(aliceA, 'session-1', 'open-a');

    const rekeyed: SessionRef = { sessionId: 'session-2', folderPath: '/home/user/project' };
    const observer = slot.observers.get('alice-a');
    await observer?.onSessionReset?.(slot, { kind: 'rekeyed', oldId: 'session-1', newId: 'session-2', folderPath: '/home/user/project' });

    expect(store.get('alice')).toEqual([rekeyed]);
    // This connection applied the swap locally — no echo. Alice's other
    // connection saw the open broadcast and then the rekeyed set.
    expect(userSessionsEvents(aliceA.sent)).toEqual([]);
    expect(userSessionsEvents(aliceB.sent)).toEqual([
      { type: 'user_sessions_changed', sessions: [S1], fresh: false },
      { type: 'user_sessions_changed', sessions: [rekeyed], fresh: false },
    ]);
  });

  it('removes a closed session from every profile and notifies each affected user', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    await store.link('alice', S1);
    await store.link('bob', S1);
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const bob = createTestHandler('bob', { user: 'bob', userProfiles: store, sessions, clientRegistry });

    await aliceA.handler.handleMessage(JSON.stringify({ type: 'close_session', sessionId: 'session-1', id: 'close-a' }));

    expect(findResponse(aliceA.sent, 'close-a')).toMatchObject({ success: true });
    expect(store.get('alice')).toEqual([]);
    expect(store.get('bob')).toEqual([]);
    expect(userSessionsEvents(aliceA.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
    expect(userSessionsEvents(bob.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
  });

  it('removes a deleted session from every profile and notifies each affected user', async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    await store.link('alice', S1);
    await store.link('bob', S1);
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const aliceA = createTestHandler('alice-a', {
      user: 'alice',
      userProfiles: store,
      sessions,
      clientRegistry,
      sessionRecords: { resolveSessionPath: async () => undefined, deleteSession: async () => true } as unknown as SessionRecords,
    });
    const bob = createTestHandler('bob', { user: 'bob', userProfiles: store, sessions, clientRegistry });

    await aliceA.handler.handleMessage(JSON.stringify({ type: 'delete_session', sessionId: 'session-1', folderPath: '/home/user/project', id: 'delete-a' }));

    expect(findResponse(aliceA.sent, 'delete-a')).toMatchObject({ success: true });
    expect(store.get('alice')).toEqual([]);
    expect(store.get('bob')).toEqual([]);
    expect(userSessionsEvents(aliceA.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
    expect(userSessionsEvents(bob.sent)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: false }]);
  });

  it('survives a restart: a store reloaded over the same path serves the pre-restart sets', async () => {
    const path = storePath();
    const store = new UserProfiles(path);
    await store.load();
    const slot = createMockSlot('session-1');
    const sessions = new Map([['session-1', slot]]);
    const clientRegistry: ClientRegistry = new Map();
    const alice = createTestHandler('alice-a', { user: 'alice', userProfiles: store, sessions, clientRegistry });
    const bob = createTestHandler('bob-a', { user: 'bob', userProfiles: store, sessions, clientRegistry });
    await open(alice, 'session-1', 'open-a');
    await open(bob, 'session-1', 'open-bob');

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.get('alice')).toEqual([S1]);
    expect(reloaded.get('bob')).toEqual([S1]);
    expect(reloaded.isFresh('alice')).toBe(false);
  });
});

describe('connect burst', () => {
  let server: PimoteServer;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    log.mockRestore();
    warn.mockRestore();
    await server?.close();
  });

  function connect(port: number, clientId: string, user: string | null): Promise<{ events: PimoteEvent[]; ws: WebSocket }> {
    return new Promise((resolve, reject) => {
      const suffix = user === null ? '' : `&user=${encodeURIComponent(user)}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${clientId}${suffix}`);
      const events: PimoteEvent[] = [];
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timed out waiting for user_sessions_changed'));
      }, 2000);
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as PimoteEvent;
        events.push(event);
        if (event.type === 'user_sessions_changed') {
          clearTimeout(timer);
          resolve({ events, ws });
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it("delivers the connecting user's set with fresh true exactly when they have no profile; an omitted user param binds default", async () => {
    const store = new UserProfiles(storePath());
    await store.load();
    const aliceSet: SessionRef = { sessionId: 'session-1', folderPath: '/home/user/project' };
    const defaultSet: SessionRef = { sessionId: 'session-2', folderPath: '/home/user/other' };
    await store.link('alice', aliceSet);
    await store.link('default', defaultSet);

    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      { getAllSessions: () => [] } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    await server.start(0);
    const port = (server.httpServer.address() as AddressInfo).port;

    // Existing profile: the burst carries the set with fresh false.
    const alice = await connect(port, 'alice-a', 'alice');
    expect(userSessionsEvents(alice.events)).toEqual([{ type: 'user_sessions_changed', sessions: [aliceSet], fresh: false }]);
    alice.ws.close();

    // No profile yet: the burst carries an empty set with fresh true.
    const bob = await connect(port, 'bob-a', 'bob');
    expect(userSessionsEvents(bob.events)).toEqual([{ type: 'user_sessions_changed', sessions: [], fresh: true }]);
    bob.ws.close();

    // Omitted user param resolves to the default profile's set.
    const anon = await connect(port, 'anon-a', null);
    expect(userSessionsEvents(anon.events)).toEqual([{ type: 'user_sessions_changed', sessions: [defaultSet], fresh: false }]);
    anon.ws.close();
  });
});
