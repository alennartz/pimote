import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const config = { roots: ['/workspace'], idleTimeout: 60_000, bufferSize: 10, port: 3000, vapidPublicKey: 'public', vapidPrivateKey: 'private' };
  const folderIndex = {
    roots: ['/workspace'],
    scan: vi.fn(async () => [{ path: '/workspace/project' }]),
    listSessionRecords: vi.fn(async () => [{ id: 'session-1' }]),
  };
  const sessionManager = {
    startIdleCheck: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const server = {
    clientRegistry: new Map(),
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const staticHostRegistry = {};
  const staticHostFactory = (() => undefined) as any;
  const downloadManager = {};
  const downloadFactory = (() => undefined) as any;
  const updateChecker = { getStatus: vi.fn(async () => null) };
  return {
    config,
    folderIndex,
    sessionManager,
    server,
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

vi.mock('./config.js', () => ({ loadConfig: mocks.loadConfig, ensureVapidKeys: mocks.ensureVapidKeys }));
vi.mock('./server.js', () => ({ createServer: mocks.createServer }));
vi.mock('./folder-index.js', () => ({
  FolderIndex: vi.fn(function () {
    return mocks.folderIndex;
  }),
}));
vi.mock('./session-manager.js', () => ({
  PimoteSessionManager: {
    create: vi.fn(async () => mocks.sessionManager),
  },
}));
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
    return { initialize: vi.fn(async () => undefined) };
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
vi.mock('./cli.js', () => ({ getVersion: mocks.getVersion }));
vi.mock('./update-check.js', () => ({
  createUpdateChecker: mocks.createUpdateChecker,
  fetchLatestVersionFromNpm: mocks.fetchLatestVersionFromNpm,
}));

import { main } from './index.js';
import { PimoteSessionManager } from './session-manager.js';

function resetMocks(): void {
  mocks.folderIndex.scan.mockReset().mockResolvedValue([{ path: '/workspace/project' }]);
  mocks.folderIndex.listSessionRecords.mockReset().mockResolvedValue([{ id: 'session-1' }]);
  mocks.sessionManager.startIdleCheck.mockReset();
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
    expect(PimoteSessionManager.create).toHaveBeenCalledWith(mocks.config, expect.anything(), expect.objectContaining({ fileDownloadFactory: mocks.downloadFactory }));
    expect(mocks.createServer).toHaveBeenCalledWith(
      mocks.config,
      mocks.sessionManager,
      mocks.folderIndex,
      expect.anything(),
      expect.anything(),
      undefined,
      mocks.staticHostRegistry,
      mocks.downloadManager,
      mocks.updateChecker,
    );
  });

  it('passes a null allow-list to download bootstrap when session enumeration fails, preserving all persisted registrations', async () => {
    mocks.folderIndex.scan.mockRejectedValueOnce(new Error('temporary I/O failure'));

    await main();

    expect(mocks.bootstrapFileDownloads).toHaveBeenCalledWith(expect.objectContaining({ validSessionIds: null }));
  });
});
