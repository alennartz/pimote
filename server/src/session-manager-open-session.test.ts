import { describe, expect, it, vi } from 'vitest';
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
