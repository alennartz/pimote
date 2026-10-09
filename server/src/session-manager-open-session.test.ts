import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent';
import type { PushNotificationService } from './push-notification.js';
import type { PimoteConfig } from './config.js';

const { modelRuntime, modelRuntimeCreate, runtimeArgs, serviceArgs, openedSessionManagers, gitBranchSpy } = vi.hoisted(() => {
  const modelRuntime = { getAvailable: vi.fn(async () => []) };
  return {
    modelRuntime,
    modelRuntimeCreate: vi.fn(async () => modelRuntime),
    runtimeArgs: [] as Array<{ cwd: string; agentDir: string; sessionManager: { getCwd(): string } }>,
    serviceArgs: [] as Array<{ modelRuntime?: unknown; resourceLoaderOptions?: { extensionFactories?: unknown[] } }>,
    openedSessionManagers: [] as Array<{ getCwd(): string }>,
    gitBranchSpy: vi.fn(() => 'main'),
  };
});

vi.mock('./git-branch.js', () => ({
  getGitBranch: gitBranchSpy,
}));

vi.mock('@earendil-works/pi-coding-agent', () => {
  const fakeSession = {
    sessionId: 'session-1',
    sessionFile: '/tmp/session.jsonl',
    isStreaming: false,
    messages: [],
    model: undefined,
    subscribe: vi.fn(() => () => {}),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(() => undefined),
    setSteeringMode: vi.fn(() => undefined),
    setFollowUpMode: vi.fn(() => undefined),
  };

  return {
    ModelRuntime: { create: modelRuntimeCreate },
    getAgentDir: vi.fn(() => '/agent-dir'),
    createEventBus: vi.fn(() => ({
      on: vi.fn(() => () => {}),
      emit: vi.fn(() => undefined),
    })),
    createAgentSessionServices: vi.fn(async (args: { cwd: string; agentDir: string; modelRuntime?: unknown; resourceLoaderOptions?: { extensionFactories?: unknown[] } }) => {
      serviceArgs.push(args);
      return {
        cwd: args.cwd,
        agentDir: args.agentDir,
        modelRuntime: args.modelRuntime,
        settingsManager: {},
        resourceLoader: {},
        diagnostics: [],
      };
    }),
    createAgentSessionFromServices: vi.fn(async () => ({
      session: fakeSession,
    })),
    createAgentSessionRuntime: vi.fn(async (factory: any, options: any) => {
      runtimeArgs.push({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
      const created = await factory({
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager: options.sessionManager,
        sessionStartEvent: { type: 'session_start', reason: 'startup' },
      });
      return {
        ...created,
        session: fakeSession,
      };
    }),
    SessionManager: {
      open: vi.fn((sessionFilePath: string) => {
        expect(sessionFilePath).toBe('/tmp/session.jsonl');
        const manager = {
          getCwd: () => '/tmp/pi-repro-resume-cwd/demo',
        };
        openedSessionManagers.push(manager);
        return manager;
      }),
      create: vi.fn((folderPath: string) => ({
        getCwd: () => folderPath,
      })),
    },
  };
});

import { PimoteSessionManager } from './session-manager.js';

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

describe('PimoteSessionManager.openSession', () => {
  it('uses the reopened session cwd instead of the requested folder path when opening a session file', async () => {
    runtimeArgs.length = 0;
    serviceArgs.length = 0;
    openedSessionManagers.length = 0;
    gitBranchSpy.mockClear();

    const manager = await PimoteSessionManager.create(createTestConfig(), createMockPushService());
    const sessionId = await manager.openSession('/home/user/project', '/tmp/session.jsonl');
    const slot = manager.getSession(sessionId);

    expect(modelRuntimeCreate).toHaveBeenCalledOnce();
    expect(openedSessionManagers).toHaveLength(1);
    expect(runtimeArgs).toHaveLength(1);
    expect(runtimeArgs[0]?.cwd).toBe('/tmp/pi-repro-resume-cwd/demo');
    expect(slot?.folderPath).toBe('/tmp/pi-repro-resume-cwd/demo');
    expect(gitBranchSpy).toHaveBeenCalledWith('/tmp/pi-repro-resume-cwd/demo');
    expect(slot?.sessionState.downloads).toEqual([]);
    expect(serviceArgs[0]?.modelRuntime).toBe(modelRuntime);
  });

  it('assembles manager sessions with the exclusive extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-assembly-'));
    runtimeArgs.length = 0;
    serviceArgs.length = 0;
    try {
      const managerExtensionFactory = (() => undefined) as any;
      const manager = await PimoteSessionManager.create(createTestConfig({ managerRoot: root }), createMockPushService(), { managerExtensionFactory });
      const sessionId = await manager.openSession(root);
      expect(PiSessionManager.create).toHaveBeenCalledWith(root);
      expect(manager.getSession(sessionId)?.folderPath).toBe(root);
      // `?? []` keeps the assertion non-vacuous: vitest's toContain passes on undefined.
      expect(serviceArgs[0]?.resourceLoaderOptions?.extensionFactories ?? []).toContain(managerExtensionFactory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps manager sessions in ordinary persisted slots across viewer loss and reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-reconnect-'));
    runtimeArgs.length = 0;
    try {
      const manager = await PimoteSessionManager.create(createTestConfig({ managerRoot: root }), createMockPushService());
      const sessionId = await manager.openSession(root);
      const slot = manager.getSession(sessionId)!;
      expect(slot.folderPath).toBe(root);
      expect(slot.session.sessionFile).toBe('/tmp/session.jsonl');
      // The public slot carries viewer ownership, not session ownership.
      slot.connection = { ws: { send: vi.fn(), readyState: 1 }, connectedClientId: 'viewer-1', onSessionReset: null };
      slot.connection = null;
      expect(manager.getAllSessions()).toContain(slot);
      expect(await manager.openSession(root, slot.session.sessionFile)).toBe(sessionId);
      expect(manager.getSession(sessionId)).toBe(slot);
      expect(runtimeArgs).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not inject manager tools into ordinary folder sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-exclusive-'));
    serviceArgs.length = 0;
    try {
      const managerExtensionFactory = (() => undefined) as any;
      const manager = await PimoteSessionManager.create(createTestConfig({ managerRoot: root }), createMockPushService(), { managerExtensionFactory });
      await manager.openSession(tmpdir());
      expect(serviceArgs[0]?.resourceLoaderOptions?.extensionFactories ?? []).not.toContain(managerExtensionFactory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('threads the dedicated download extension factory alongside static hosting into every runtime', async () => {
    runtimeArgs.length = 0;
    serviceArgs.length = 0;
    const staticHostFactory = (() => undefined) as any;
    const fileDownloadFactory = (() => undefined) as any;
    const manager = await PimoteSessionManager.create(createTestConfig(), createMockPushService(), { staticHostFactory, fileDownloadFactory });

    await manager.openSession('/home/user/project');
    await manager.openSession('/home/user/second-project');

    expect(serviceArgs).toHaveLength(2);
    expect(serviceArgs.map((args) => args.modelRuntime)).toEqual([modelRuntime, modelRuntime]);
    expect(serviceArgs[0]?.resourceLoaderOptions?.extensionFactories).toEqual([staticHostFactory, fileDownloadFactory]);
    expect(serviceArgs[1]?.resourceLoaderOptions?.extensionFactories).toEqual([staticHostFactory, fileDownloadFactory]);
  });
});
