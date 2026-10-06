import { describe, expect, it, vi } from 'vitest';
import type { AgentSession, CreateAgentSessionRuntimeFactory, CreateAgentSessionServicesOptions, ExtensionFactory } from '@earendil-works/pi-coding-agent';

const mock = vi.hoisted(() => ({
  factory: null as CreateAgentSessionRuntimeFactory | null,
  factories: [] as ExtensionFactory[],
  sessions: [] as AgentSession[],
  getSessions: [] as (() => AgentSession)[],
}));

vi.mock('./index.js', () => ({
  createVoiceExtension: (options: { getSession: () => AgentSession }) => {
    mock.getSessions.push(options.getSession);
    return () => {};
  },
}));
vi.mock('../git-branch.js', () => ({ getGitBranch: async () => null }));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  ModelRuntime: { create: async () => ({ getAvailable: async () => [] }) },
  createAgentSessionServices: async (options: CreateAgentSessionServicesOptions) => {
    mock.factories.push(options.resourceLoaderOptions!.extensionFactories![0] as ExtensionFactory);
    return { diagnostics: [] };
  },
  createAgentSessionFromServices: async () => {
    const session = {
      sessionId: `session-${mock.sessions.length}`,
      isStreaming: false,
      messages: [],
      subscribe: () => () => {},
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
    } as unknown as AgentSession;
    mock.sessions.push(session);
    return { session };
  },
  createAgentSessionRuntime: async (factory: CreateAgentSessionRuntimeFactory, args: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
    mock.factory = factory;
    return await factory(args);
  },
}));

import { PimoteSessionManager } from '../session-manager.js';
import type { PushNotificationService } from '../push-notification.js';

describe('voice session ownership', () => {
  it('binds a fresh voice factory to each newly constructed or replacement session', async () => {
    const manager = await PimoteSessionManager.create(
      {
        roots: [],
        managerRoot: '/tmp',
        idleTimeout: 1000,
        bufferSize: 10,
        port: 0,
        voice: { speechmuxSignalUrl: 'http://test', speechmuxLlmWsUrl: 'ws://test' },
        defaultInterpreterModel: 'test/voice',
        defaultWorkerModel: 'test/worker',
      },
      { notify: async () => {} } as unknown as PushNotificationService,
    );
    await manager.openSession('/tmp');
    expect(mock.getSessions[0]()).toBe(mock.sessions[0]);
    await mock.factory!({
      cwd: '/tmp',
      agentDir: '/tmp',
      sessionManager: {} as Parameters<CreateAgentSessionRuntimeFactory>[0]['sessionManager'],
      sessionStartEvent: { type: 'session_start', reason: 'new' },
    });
    expect(mock.factories[1]).not.toBe(mock.factories[0]);
    expect(mock.getSessions[0]()).toBe(mock.sessions[0]);
    expect(mock.getSessions[1]()).toBe(mock.sessions[1]);
  });
});
