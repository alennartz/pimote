import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

const mocks = vi.hoisted(() => {
  const config = { roots: ['/workspace'], managerRoot: '/srv/manager-home', idleTimeout: 60_000, bufferSize: 10, port: 3000, vapidPublicKey: 'public', vapidPrivateKey: 'private' };
  const sessionRecords = {
    listSessionRecords: vi.fn(async () => [{ id: 'session-1' }]),
    resolveSessionPath: vi.fn(async () => undefined),
  };
  // Default sparse tree: one discovered code folder below the configured root.
  const scanFolderModel = vi.fn(async () => ({
    occurrences: [
      {
        path: '/workspace/project',
        via: 'scan',
        entry: { path: '/workspace/project', name: 'project', nature: 'code' },
        children: [],
      },
    ],
  }));
  const sessionManager = {
    startIdleCheck: vi.fn(),
    dispose: vi.fn(async () => undefined),
    getModelRuntime: vi.fn(() => ({})),
    getAllSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    closeSession: vi.fn(async () => undefined),
    openSession: vi.fn(async () => 'session-new'),
  };
  const sessionMetadataStore = {
    initialize: vi.fn(async () => undefined),
    getArchivedLookup: vi.fn(() => new Map<string, boolean>()),
    setArchived: vi.fn(async () => undefined),
  };
  const folderRegistry = {
    list: vi.fn(async () => []),
  };
  const server = {
    clientRegistry: new Map(),
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const sessionManagerCreate = vi.fn(async (_config: unknown, _pushNotificationService: unknown, _options: { managerExtensionFactory?: (pi: unknown) => void }) => sessionManager);
  const realpath = vi.fn(async (path: string) => path);
  const mkdir = vi.fn(async () => undefined);
  const seedManagerRoot = vi.fn(async () => undefined);
  const staticHostRegistry = {};
  const staticHostFactory = (() => undefined) as any;
  const downloadManager = {};
  const downloadFactory = (() => undefined) as any;
  const updateChecker = { getStatus: vi.fn(async () => null) };
  return {
    config,
    sessionRecords,
    scanFolderModel,
    sessionManager,
    sessionMetadataStore,
    folderRegistry,
    server,
    sessionManagerCreate,
    realpath,
    mkdir,
    seedManagerRoot,
    staticHostRegistry,
    staticHostFactory,
    downloadManager,
    downloadFactory,
    updateChecker,
    getVersion: vi.fn(async () => '0.11.0'),
    createUpdateChecker: vi.fn(() => updateChecker),
    fetchLatestVersionFromNpm: vi.fn(async () => '0.11.0'),
    loadConfig: vi.fn(async () => config),
    ensureVapidKeys: vi.fn(async (nextConfig) => nextConfig),
    migratePushSubscriptionStore: vi.fn(async () => undefined),
    gcStaticHostStore: vi.fn(async () => undefined),
    createStaticHostExtension: vi.fn(() => staticHostFactory),
    bootstrapFileDownloads: vi.fn(async () => ({ manager: downloadManager, extensionFactory: downloadFactory })),
    createServer: vi.fn(async () => server),
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: mocks.loadConfig,
  ensureVapidKeys: mocks.ensureVapidKeys,
}));
vi.mock('./server.js', () => ({ createServer: mocks.createServer }));
vi.mock('./session-records.js', () => ({
  SessionRecords: vi.fn(function () {
    return mocks.sessionRecords;
  }),
}));
vi.mock('./folder-model/index.js', () => ({ scanFolderModel: mocks.scanFolderModel }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal()), realpath: mocks.realpath, mkdir: mocks.mkdir }));
vi.mock('./manager/index.js', async (importOriginal) => ({ ...(await importOriginal()), seedManagerRoot: mocks.seedManagerRoot }));
vi.mock('./session-manager.js', () => ({
  PimoteSessionManager: {
    create: mocks.sessionManagerCreate,
  },
}));
vi.mock('./folder-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./folder-registry.js')>();
  return {
    ...actual,
    FolderRegistry: vi.fn(function () {
      return mocks.folderRegistry;
    }),
  };
});
vi.mock('./push-notification.js', () => ({
  PushNotificationService: vi.fn(function () {
    return { initialize: vi.fn(async () => undefined) };
  }),
}));
vi.mock('./push-infrastructure.js', () => ({
  FilePushSubscriptionStore: vi.fn(function () {
    return {};
  }),
  WebPushSender: vi.fn(function () {
    return {};
  }),
  migratePushSubscriptionStore: mocks.migratePushSubscriptionStore,
}));
vi.mock('./session-metadata.js', () => ({
  FileSessionMetadataStore: vi.fn(function () {
    return mocks.sessionMetadataStore;
  }),
}));
vi.mock('./voice-orchestrator-boot.js', () => ({ buildVoiceOrchestrator: vi.fn(() => null) }));
vi.mock('./static-host/index.js', () => ({
  InMemoryStaticHostRegistry: vi.fn(function () {
    return mocks.staticHostRegistry;
  }),
  FileStaticHostStore: vi.fn(function () {
    return {};
  }),
  gcStaticHostStore: mocks.gcStaticHostStore,
  createStaticHostExtension: mocks.createStaticHostExtension,
}));
vi.mock('./file-download/bootstrap.js', () => ({ bootstrapFileDownloads: mocks.bootstrapFileDownloads }));
vi.mock('./version.js', () => ({ getVersion: mocks.getVersion }));
vi.mock('./update-check.js', () => ({
  createUpdateChecker: mocks.createUpdateChecker,
  fetchLatestVersionFromNpm: mocks.fetchLatestVersionFromNpm,
}));

import { main } from './index.js';
import { PimoteSessionManager } from './session-manager.js';

function resetMocks(): void {
  mocks.config.updateCheck = undefined;
  mocks.sessionRecords.listSessionRecords.mockReset().mockResolvedValue([{ id: 'session-1' }]);
  mocks.sessionRecords.resolveSessionPath.mockReset().mockResolvedValue(undefined);
  mocks.scanFolderModel.mockReset().mockImplementation(async () => ({
    occurrences: [
      {
        path: '/workspace/project',
        via: 'scan',
        entry: { path: '/workspace/project', name: 'project', nature: 'code' },
        children: [],
      },
    ],
  }));
  mocks.sessionManager.startIdleCheck.mockReset();
  mocks.sessionManager.getAllSessions.mockReset().mockReturnValue([]);
  mocks.sessionManager.getSession.mockReset().mockReturnValue(undefined);
  mocks.sessionManager.closeSession.mockReset().mockResolvedValue(undefined);
  mocks.sessionManager.openSession.mockReset().mockResolvedValue('session-new');
  mocks.sessionMetadataStore.getArchivedLookup.mockReset().mockReturnValue(new Map<string, boolean>());
  mocks.sessionMetadataStore.setArchived.mockReset().mockResolvedValue(undefined);
  mocks.folderRegistry.list.mockReset().mockResolvedValue([]);
  mocks.sessionManagerCreate.mockReset().mockResolvedValue(mocks.sessionManager);
  mocks.realpath.mockReset().mockImplementation(async (path: string) => path);
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.seedManagerRoot.mockReset().mockResolvedValue(undefined);
  mocks.server.clientRegistry.clear();
  mocks.server.start.mockReset().mockResolvedValue(undefined);
  mocks.bootstrapFileDownloads.mockReset().mockResolvedValue({ manager: mocks.downloadManager, extensionFactory: mocks.downloadFactory });
  mocks.createServer.mockReset().mockResolvedValue(mocks.server);
  mocks.gcStaticHostStore.mockReset().mockResolvedValue(undefined);
  mocks.createStaticHostExtension.mockReset().mockReturnValue(mocks.staticHostFactory);
  mocks.getVersion.mockReset().mockResolvedValue('0.11.0');
  mocks.createUpdateChecker.mockReset().mockReturnValue(mocks.updateChecker);
  mocks.fetchLatestVersionFromNpm.mockReset().mockResolvedValue('0.11.0');
  mocks.updateChecker.getStatus.mockReset().mockResolvedValue(null);
}

describe('main — file download bootstrap wiring', () => {
  let processOn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processOn.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });

  it('shares the bootstrapped manager between the HTTP route and every session extension factory', async () => {
    await main({ portOverride: 4321 });

    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: new Set(['session-1']) }));
    expect(mocks.scanFolderModel).toHaveBeenCalledWith({ roots: ['/workspace'], onWarning: expect.any(Function) });
    expect(PimoteSessionManager.create).toHaveBeenCalledWith(
      mocks.config,
      expect.anything(),
      expect.objectContaining({ fileDownloadFactory: mocks.downloadFactory, managerExtensionFactory: expect.anything() }),
    );
    expect(mocks.createServer).toHaveBeenCalledWith(
      mocks.config,
      mocks.sessionManager,
      mocks.sessionRecords,
      expect.anything(),
      expect.anything(),
      undefined,
      mocks.staticHostRegistry,
      mocks.downloadManager,
      mocks.updateChecker,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(), // folderListing
    );
  });

  it('does not construct or warm the update checker when update checks are disabled', async () => {
    mocks.config.updateCheck = false;

    await main();

    expect(mocks.getVersion).not.toHaveBeenCalled();
    expect(mocks.createUpdateChecker).not.toHaveBeenCalled();
    expect(mocks.fetchLatestVersionFromNpm).not.toHaveBeenCalled();
    expect(mocks.updateChecker.getStatus).not.toHaveBeenCalled();
    expect(mocks.createServer).toHaveBeenCalledWith(
      mocks.config,
      mocks.sessionManager,
      mocks.sessionRecords,
      expect.anything(),
      expect.anything(),
      undefined,
      mocks.staticHostRegistry,
      mocks.downloadManager,
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(), // folderListing
    );
  });

  it('passes a null allow-list to download bootstrap when strict session enumeration fails, preserving all persisted registrations', async () => {
    mocks.sessionRecords.listSessionRecords.mockRejectedValueOnce(new Error('temporary I/O failure'));

    await main();

    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: null }));
    expect(mocks.gcStaticHostStore).not.toHaveBeenCalled();
  });

  it('suppresses the sweep when a scanner warning reports root-access failure', async () => {
    mocks.scanFolderModel.mockImplementationOnce(async (options: { onWarning: (warning: unknown) => void }) => {
      options.onWarning({ path: '/workspace', operation: 'readdir', error: new Error('EACCES: permission denied') });
      return {
        occurrences: [
          {
            path: '/workspace/project',
            via: 'scan',
            entry: { path: '/workspace/project', name: 'project', nature: 'code' },
            children: [],
          },
        ],
      };
    });

    await main();

    // The root's sessions could not be enumerated — never a partial allow-list.
    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: null }));
    expect(mocks.gcStaticHostStore).not.toHaveBeenCalled();
    expect(mocks.sessionRecords.listSessionRecords).not.toHaveBeenCalled();
  });

  it('permits the sweep on below-root and AGENTS.md content warnings', async () => {
    mocks.scanFolderModel.mockImplementationOnce(async (options: { onWarning: (warning: unknown) => void }) => {
      options.onWarning({ path: '/workspace/unreadable-sub', operation: 'readdir', error: new Error('EACCES') });
      options.onWarning({ path: '/workspace/dangling', operation: 'realpath', error: new Error('ENOENT') });
      options.onWarning({ path: '/workspace/project/AGENTS.md', operation: 'readFile', error: new Error('EACCES') });
      // A content warning at a root path is still content, not root access.
      options.onWarning({ path: '/workspace', operation: 'readFile', error: new Error('EACCES') });
      return {
        occurrences: [
          {
            path: '/workspace/project',
            via: 'scan',
            entry: { path: '/workspace/project', name: 'project', nature: 'code' },
            children: [],
          },
        ],
      };
    });

    await main();

    expect(mocks.gcStaticHostStore).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: new Set(['session-1']) }));
    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: new Set(['session-1']) }));
  });

  it('enumerates canonical entry paths and reach paths exactly once each', async () => {
    const sharedEntry = { path: '/workspace/shared', name: 'shared', nature: 'code' };
    const sharedChildren = [{ path: '/workspace/shared/member', via: 'shortcut', entry: { path: '/external/member', name: 'member', nature: 'code' }, children: [] }];
    mocks.scanFolderModel.mockImplementationOnce(async () => ({
      occurrences: [
        { path: '/workspace/shared', via: 'scan', entry: sharedEntry, children: sharedChildren },
        // Same entry again via a shortcut occurrence reusing first-discovery children.
        { path: '/workspace/other/shared-link', via: 'shortcut', entry: sharedEntry, children: sharedChildren },
      ],
    }));
    // The manager root is outside discovery: its records are enumerated
    // separately, once.
    mocks.sessionRecords.listSessionRecords.mockImplementation(async (folderPath: string) =>
      folderPath === '/srv/manager-home' ? [{ id: 'manager-session' }] : [{ id: 'session-1' }],
    );

    await main();

    // Identity and reach paths alike: pi's session-directory encoding is
    // lexical, so alias/reach paths hold their own session directories — the
    // sweep must never drop registrations recorded there. Duplicate
    // occurrences collapse to one enumeration per path.
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledTimes(5);
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/workspace/shared', { failOnError: true });
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/external/member', { failOnError: true });
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/workspace/shared/member', { failOnError: true });
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/workspace/other/shared-link', { failOnError: true });
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/srv/manager-home', { failOnError: true });
    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: new Set(['session-1', 'manager-session']) }));
  });

  it('suppresses the sweep when the scan work budget was exceeded', async () => {
    mocks.scanFolderModel.mockImplementationOnce(async (options: { onWarning: (warning: unknown) => void }) => {
      options.onWarning({ path: '/workspace/huge', operation: 'budget', error: new Error('visit budget exceeded') });
      return {
        occurrences: [
          {
            path: '/workspace/project',
            via: 'scan',
            entry: { path: '/workspace/project', name: 'project', nature: 'code' },
            children: [],
          },
        ],
      };
    });

    await main();

    // A truncated scan cannot prove its own completeness — never a partial
    // allow-list.
    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: null }));
    expect(mocks.gcStaticHostStore).not.toHaveBeenCalled();
    expect(mocks.sessionRecords.listSessionRecords).not.toHaveBeenCalled();
  });
});

// The manager toolset's port wiring: drive the tools registered at the
// single ManagerToolContext construction site through the real extension
// factory main() hands to the normal session manager, against the mocked
// server internals the construction site composes over.
describe('main — manager toolset port wiring', () => {
  let processOn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  interface FakeToolDef {
    name: string;
    parameters: { type?: string; properties?: Record<string, unknown> };
    annotations: { readOnlyHint?: boolean };
    execute: (...args: unknown[]) => Promise<{ details: any }>;
  }

  /** Run main(), then register the manager extension's tools against a fake
   *  ExtensionAPI and return them for direct execution. */
  async function registeredManagerTools(): Promise<FakeToolDef[]> {
    await main({ portOverride: 4321 });
    expect(mocks.sessionManagerCreate).toHaveBeenCalledTimes(1);
    const { managerExtensionFactory } = mocks.sessionManagerCreate.mock.calls[0][2];
    const toolDefs: FakeToolDef[] = [];
    (managerExtensionFactory as (pi: unknown) => void)({
      registerTool(def: FakeToolDef) {
        toolDefs.push(def);
      },
      on() {},
      events: { emit() {}, on: () => () => {} },
    });
    return toolDefs;
  }

  function toolNamed(tools: FakeToolDef[], name: string): FakeToolDef {
    const def = tools.find((tool) => tool.name === name);
    if (!def) throw new Error(`${name} not registered`);
    return def;
  }

  const alphaFolder = { path: '/workspace/alpha', name: 'alpha', nature: 'code' as const };
  const betaFolder = { path: '/workspace/beta', name: 'beta', nature: 'code' as const };

  beforeEach(() => {
    resetMocks();
    processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processOn.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });

  it('registers exactly the pinned manager toolset, with pimote_folder_tree read-only and zero-argument', async () => {
    const tools = await registeredManagerTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'pimote_list_folders',
      'pimote_folder_tree',
      'pimote_list_repos',
      'pimote_list_sessions',
      'pimote_search_sessions',
      'pimote_start_session',
      'pimote_archive_sessions',
      'pimote_create_persona',
      'pimote_list_personas',
    ]);
    const tree = toolNamed(tools, 'pimote_folder_tree');
    expect(tree.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(tree.parameters.properties ?? {})).toHaveLength(0);
  });

  it('wires pimote_folder_tree through the shared cached discovery walk, not its own scanner', async () => {
    const tree = {
      occurrences: [
        {
          path: '/workspace/shared',
          via: 'scan',
          entry: { path: '/workspace/shared', name: 'shared', nature: 'code' },
          children: [{ path: '/workspace/shared/link', via: 'shortcut', entry: { path: '/external/member', name: 'member', nature: 'code' }, children: [] }],
        },
      ],
    };
    mocks.scanFolderModel.mockImplementation(async () => tree);

    const tools = await registeredManagerTools();
    const def = toolNamed(tools, 'pimote_folder_tree');
    const result = await def.execute('call-1', {}, undefined, undefined, {});

    expect(result.details).toEqual(tree);
    // Finite and JSON-safe end to end.
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(tree);
    // Shared cached walk: repeated executions reuse the discovery retained by
    // the repo index instead of rescanning, and the repo listing joins the
    // same walk. Manager tree consumers accept trees up to one TTL old.
    const scansBefore = mocks.scanFolderModel.mock.calls.length;
    const changedTree = { occurrences: [{ path: '/workspace/changed', via: 'scan', entry: { path: '/workspace/changed', name: 'changed', nature: 'code' }, children: [] }] };
    mocks.scanFolderModel.mockImplementation(async () => changedTree);
    const second = await def.execute('call-2', {}, undefined, undefined, {});
    expect(second.details).toEqual(tree); // stale-but-accepted within the TTL — no rescan
    await toolNamed(tools, 'pimote_list_repos').execute('call-3', {}, undefined, undefined, {});
    expect(mocks.scanFolderModel.mock.calls.length).toBe(scansBefore);
    // The walk still goes through the folder-model seam from config.roots.
    expect(mocks.scanFolderModel).toHaveBeenLastCalledWith({ roots: ['/workspace'], onWarning: expect.any(Function) });
  });

  it('wires pimote_list_folders: FolderInfo defaults materialized and live counts enriched through the session manager', async () => {
    mocks.folderRegistry.list.mockResolvedValue([
      { path: '/workspace/alpha', name: 'alpha', nature: 'code' },
      { path: '/workspace/personas/ada', name: 'ada', nature: 'persona', persona: { name: 'Ada' } },
    ]);
    mocks.sessionManager.getAllSessions.mockReturnValue([
      { sessionState: { id: 's1', status: 'idle', needsAttention: false }, folderPath: '/workspace/alpha' },
      { sessionState: { id: 's2', status: 'working', needsAttention: true }, folderPath: '/workspace/alpha' },
    ]);

    const result = await toolNamed(await registeredManagerTools(), 'pimote_list_folders').execute('call-1', {}, undefined, undefined, {});

    expect(result.details).toEqual([
      {
        path: '/workspace/alpha',
        name: 'alpha',
        nature: 'code',
        shortcutCount: 0,
        favorite: false,
        archived: false,
        tags: [],
        missing: false,
        activeSessionCount: 2,
        externalProcessCount: 0,
      },
      {
        path: '/workspace/personas/ada',
        name: 'ada',
        nature: 'persona',
        persona: { name: 'Ada' },
        shortcutCount: 0,
        favorite: false,
        archived: false,
        tags: [],
        missing: false,
        activeSessionCount: 0,
        externalProcessCount: 0,
      },
    ]);
  });

  it('wires listDiskSessions: search lists every folder through SessionRecords and enriches with the archived lookup', async () => {
    mocks.folderRegistry.list.mockResolvedValue([alphaFolder, betaFolder]);
    mocks.sessionRecords.listSessionRecords.mockImplementation(async (folderPath: string) =>
      folderPath === '/workspace/alpha'
        ? [
            {
              id: 's1',
              path: '/sessions/s1.jsonl',
              name: 'Fix login',
              created: new Date('2025-06-01T00:00:00Z'),
              modified: new Date('2025-06-02T00:00:00Z'),
              messageCount: 3,
              firstMessage: 'login broken',
            },
          ]
        : [],
    );
    mocks.sessionMetadataStore.getArchivedLookup.mockReturnValue(new Map([['/sessions/s1.jsonl', true]]));

    const result = await toolNamed(await registeredManagerTools(), 'pimote_search_sessions').execute('call-1', { query: 'login' }, undefined, undefined, {});

    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/workspace/alpha');
    expect(mocks.sessionRecords.listSessionRecords).toHaveBeenCalledWith('/workspace/beta');
    expect(mocks.sessionMetadataStore.getArchivedLookup).toHaveBeenCalledWith(['/sessions/s1.jsonl']);
    expect(result.details.results).toEqual([
      {
        id: 's1',
        name: 'Fix login',
        firstMessage: 'login broken',
        modified: '2025-06-02T00:00:00.000Z',
        folderPath: '/workspace/alpha',
        open: false,
        archived: true,
        messageCount: 3,
      },
    ]);
  });

  it('wires openSession: start_session opens through the session manager and prompts the firstMessage', async () => {
    mocks.folderRegistry.list.mockResolvedValue([alphaFolder]);
    mocks.sessionManager.openSession.mockResolvedValue('sess-9');
    const prompt = vi.fn(async () => undefined);
    mocks.sessionManager.getSession.mockReturnValue({ session: { sessionFile: '/sessions/sess-9.jsonl', prompt }, folderPath: '/workspace/alpha' });

    const tools = await registeredManagerTools();
    const withMessage = await toolNamed(tools, 'pimote_start_session').execute(
      'call-1',
      { folderPath: '/workspace/alpha', firstMessage: 'do the thing' },
      undefined,
      undefined,
      {},
    );
    const withoutMessage = await toolNamed(tools, 'pimote_start_session').execute('call-2', { folderPath: '/workspace/alpha' }, undefined, undefined, {});

    expect(mocks.sessionManager.openSession).toHaveBeenNthCalledWith(1, '/workspace/alpha');
    expect(mocks.sessionManager.openSession).toHaveBeenNthCalledWith(2, '/workspace/alpha');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith('do the thing');
    expect(withMessage.details).toEqual({ sessionId: 'sess-9', folderPath: '/workspace/alpha', firstMessageSent: true });
    expect(withoutMessage.details).toEqual({ sessionId: 'sess-9', folderPath: '/workspace/alpha', firstMessageSent: false });
  });

  it('wires openSession for a persona folder', async () => {
    mocks.folderRegistry.list.mockResolvedValue([{ path: '/workspace/personas/ada', name: 'ada', nature: 'persona', persona: { name: 'Ada' } }]);
    mocks.sessionManager.openSession.mockResolvedValue('sess-10');

    const result = await toolNamed(await registeredManagerTools(), 'pimote_start_session').execute('call-1', { folderPath: '/workspace/personas/ada' }, undefined, undefined, {});

    expect(mocks.sessionManager.openSession).toHaveBeenCalledWith('/workspace/personas/ada');
    expect(result.details).toEqual({ sessionId: 'sess-10', folderPath: '/workspace/personas/ada', firstMessageSent: false });
  });

  it('wires archiveSessions for an open session: canonical archive on the slot file, slot evicted, clients notified', async () => {
    mocks.folderRegistry.list.mockResolvedValue([alphaFolder]);
    mocks.sessionManager.getSession.mockReturnValue({ session: { sessionFile: '/sessions/s1.jsonl' }, folderPath: '/workspace/alpha' });
    const broadcast = vi.fn();
    mocks.server.clientRegistry.set('client-1', { sendToClient: broadcast });

    const result = await toolNamed(await registeredManagerTools(), 'pimote_archive_sessions').execute('call-1', { sessionIds: ['s1'] }, undefined, undefined, {});

    expect(mocks.sessionMetadataStore.setArchived).toHaveBeenCalledWith('/sessions/s1.jsonl', true);
    expect(mocks.sessionManager.closeSession).toHaveBeenCalledWith('s1');
    // The live slot's session file wins; no disk scan is needed.
    expect(mocks.sessionRecords.resolveSessionPath).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({ type: 'session_archived', sessionId: 's1', folderPath: '/workspace/alpha', archived: true });
    expect(result.details.results).toEqual([{ sessionId: 's1', outcome: 'open_slot_evicted' }]);
  });

  it('wires archiveSessions for a closed session: resolves the record across folders, archives on disk, leaves no slot to evict', async () => {
    mocks.folderRegistry.list.mockResolvedValue([alphaFolder, betaFolder]);
    mocks.sessionRecords.resolveSessionPath.mockImplementation(async (_folderPath: string, sessionId: string) => (sessionId === 's2' ? '/sessions/s2.jsonl' : undefined));

    const result = await toolNamed(await registeredManagerTools(), 'pimote_archive_sessions').execute('call-1', { sessionIds: ['s2'] }, undefined, undefined, {});

    expect(mocks.sessionRecords.resolveSessionPath).toHaveBeenCalledWith('/workspace/alpha', 's2');
    expect(mocks.sessionMetadataStore.setArchived).toHaveBeenCalledWith('/sessions/s2.jsonl', true);
    expect(mocks.sessionManager.closeSession).not.toHaveBeenCalled();
    expect(result.details.results).toEqual([{ sessionId: 's2', outcome: 'archived' }]);
  });

  it('wires archiveSessions for an unknown session id: reports not_found without touching the metadata store', async () => {
    mocks.folderRegistry.list.mockResolvedValue([alphaFolder]);

    const result = await toolNamed(await registeredManagerTools(), 'pimote_archive_sessions').execute('call-1', { sessionIds: ['ghost'] }, undefined, undefined, {});

    expect(mocks.sessionMetadataStore.setArchived).not.toHaveBeenCalled();
    expect(mocks.sessionManager.closeSession).not.toHaveBeenCalled();
    expect(result.details.results).toEqual([{ sessionId: 'ghost', outcome: 'not_found' }]);
  });

  it('passes the canonical managerRoot to the session manager without scanning it', async () => {
    await main({ portOverride: 4321 });

    const config = mocks.sessionManagerCreate.mock.calls[0][0];
    expect(mocks.realpath).toHaveBeenCalledWith('/srv/manager-home');
    expect(config.managerRoot).toBe('/srv/manager-home');
    // The manager root is the persona's working directory — never a scan root.
    expect(mocks.scanFolderModel).toHaveBeenCalledWith({ roots: ['/workspace'], onWarning: expect.any(Function) });
  });

  it('keeps the manager-root entry out of the assembled tree while discovery sees it', async () => {
    // Discovery walks both entries (the manager root sits inside a scan root);
    // the listing assembly must never surface the manager-root entry.
    const discovered = {
      occurrences: [
        {
          path: '/workspace/manager-home',
          via: 'scan',
          entry: { path: '/srv/manager-home', name: 'manager-home', nature: 'persona', persona: { name: 'manager' } },
          children: [],
        },
        {
          path: '/workspace/project',
          via: 'scan',
          entry: { path: '/workspace/project', name: 'project', nature: 'code' },
          children: [],
        },
      ],
    };
    mocks.scanFolderModel.mockResolvedValue(discovered);

    const result = await toolNamed(await registeredManagerTools(), 'pimote_folder_tree').execute('call-1', {}, undefined, undefined, {});

    const rendered = JSON.stringify(result.details);
    expect(rendered).toContain('/workspace/project');
    expect(rendered).not.toContain('/srv/manager-home');
  });
});

describe('main — manager-root boot guard (review finding 1)', () => {
  let processOn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processOn.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });

  it('refuses to boot when the manager root is or contains the home directory, and never seeds', async () => {
    mocks.loadConfig.mockResolvedValueOnce({ ...mocks.config, managerRoot: homedir() });

    await expect(main({ portOverride: 4321 })).rejects.toThrow(/must not be or contain the home directory/);
    expect(mocks.seedManagerRoot).not.toHaveBeenCalled();
  });

  it('boots when the manager root is nested inside a scan root', async () => {
    mocks.loadConfig.mockResolvedValueOnce({ ...mocks.config, managerRoot: '/workspace/manager' });

    await main({ portOverride: 4321 });

    expect(mocks.seedManagerRoot).toHaveBeenCalledWith('/workspace/manager');
  });

  it('boots when the manager root equals a scan root', async () => {
    mocks.loadConfig.mockResolvedValueOnce({ ...mocks.config, managerRoot: '/workspace' });

    await main({ portOverride: 4321 });

    expect(mocks.seedManagerRoot).toHaveBeenCalledWith('/workspace');
  });

  it('creates the manager root before canonicalizing and seeding it', async () => {
    await main({ portOverride: 4321 });

    expect(mocks.mkdir).toHaveBeenCalledWith('/srv/manager-home', { recursive: true });
    expect(mocks.mkdir.mock.invocationCallOrder[0]).toBeLessThan(mocks.realpath.mock.invocationCallOrder[0]);
    expect(mocks.seedManagerRoot).toHaveBeenCalledWith('/srv/manager-home');
  });
});
