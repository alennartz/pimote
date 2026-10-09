import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { createManagerExtension } from './manager/index.js';
import type { FolderInfo, ManagerToolContext } from './manager/index.js';

// pi-065 regression (docs/bugs/pi-065-extension-newsession-broken.md), test
// contract from docs/plans/manager-lifecycle.md as ruled at verification:
// replace a runtime session (runtime.newSession()) with a pimote extension
// loaded, then pin the installed SDK's fail-fast contract:
// 1. a stale pi.* call — the ExtensionAPI captured at load time — throws
//    synchronously after replacement, never silently no-ops;
// 2. the disposed session receives zero events and executes zero tools (no
//    ghost work);
// 3. the replacement session still prompts normally through its own ctx.
//
// SDK ^1.1.0 fixed the dangerous half of the bug (silent ghost execution)
// upstream as loud rejection; pimote does not extend the patch-package patch.
// All model responses, resources, settings, and session storage are local or
// in-memory; the extension runner, runtime bindings, and session replacement
// are the installed SDK's own machinery.

const model: Model<'openai-completions'> = {
  id: 'pi-065-test',
  name: 'pi-065 test model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  input: ['text'],
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function makeManagerContext(): ManagerToolContext {
  return {
    sessions: {
      getAllSessions: vi.fn(() => []),
      listDiskSessions: vi.fn(async () => []),
      openSession: vi.fn(async () => 'session-new'),
      archiveSessions: vi.fn(async () => []),
    },
    folders: {
      list: vi.fn(async () => [] as FolderInfo[]),
      update: vi.fn(async () => undefined),
      createHub: vi.fn(async () => ({}) as FolderInfo),
      disbandHub: vi.fn(async () => undefined),
    },
    repos: { list: vi.fn(async () => []), invalidateListing: vi.fn() },
    tree: { tree: vi.fn(async () => ({ occurrences: [] })) },
    config: { roots: ['/tmp'], managerRoot: '/srv/manager-home', idleTimeout: 1_000, bufferSize: 10, port: 3000 },
  };
}

interface Generation {
  streamCalls: number;
}

/** Deterministic fake-model harness: every agent run is a controlled local
 *  stream, recorded per runtime generation. */
function makeHarness() {
  const generations: Generation[] = [];
  const capturedApis: ExtensionAPI[] = [];
  const streamFinishers: Array<() => void> = [];
  let notifyRunStarted!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    notifyRunStarted = resolve;
  });

  const managerFactory = createManagerExtension(makeManagerContext());
  const captureFactory: ExtensionFactory = (api) => {
    capturedApis.push(api);
    managerFactory(api);
  };

  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }): Promise<CreateAgentSessionRuntimeResult> => {
    const generation: Generation = { streamCalls: 0 };
    generations.push(generation);
    // Deterministic ModelRuntime stand-in: the known surface plus a generic
    // fallback so unused SDK queries stay inert.
    const modelRuntime = new Proxy(
      {
        getModel: () => model,
        getModels: () => [model],
        getAllModels: () => [model],
        getAvailableSnapshot: () => [model],
        getAvailable: async () => [model],
        getAllAvailable: async () => [model],
        hasConfiguredAuth: () => true,
        getError: () => undefined,
        registerProvider: () => undefined,
        registerNativeProvider: () => undefined,
        refresh: async () => undefined,
        streamSimple: async () => {
          generation.streamCalls++;
          notifyRunStarted();
          const stream = createAssistantMessageEventStream();
          streamFinishers.push(() => {
            const message: AssistantMessage = {
              role: 'assistant',
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'stop',
              timestamp: Date.now(),
            };
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          });
          return stream;
        },
      } as object,
      {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          return () => undefined;
        },
      },
    ) as unknown as ModelRuntime;

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { eventBus: createEventBus(), extensionFactories: [captureFactory] },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    await result.session.bindExtensions({});
    return { ...result, services, diagnostics: services.diagnostics };
  };

  return {
    generations,
    capturedApis,
    firstRunStarted,
    finishAllStreams: () => {
      for (const finish of streamFinishers.splice(0)) finish();
    },
    factory,
    async cleanup() {
      // Nothing global to release; kept for symmetric teardown.
    },
  };
}

describe('pi-065: pi.* after runtime.newSession()', () => {
  it('rejects stale ctx calls loudly, runs no ghost work on the disposed session, and prompts the new session normally', async () => {
    const harness = makeHarness();
    const root = await mkdtemp(join(tmpdir(), 'pi-065-'));
    try {
      const runtime = await createAgentSessionRuntime(harness.factory, {
        cwd: root,
        agentDir: root,
        sessionManager: SessionManager.inMemory(root),
      });
      const loadedApi = harness.capturedApis[0];
      expect(loadedApi).toBeDefined();

      const oldSession = runtime.session;
      const oldEvents: unknown[] = [];
      const unsubscribeOld = oldSession.subscribe((event) => oldEvents.push(event));

      await runtime.newSession();
      const newSession = runtime.session;
      expect(newSession).not.toBe(oldSession);
      const oldEventCountAfterReplacement = oldEvents.length;

      // (1) A stale pi.* call throws synchronously — it never silently no-ops.
      expect(() => loadedApi.sendUserMessage('after replacement')).toThrow();

      // (2) The disposed session receives zero events and executes zero tools.
      expect(harness.generations[0].streamCalls).toBe(0);
      expect(oldEvents.length).toBe(oldEventCountAfterReplacement);

      // (3) The replacement session still prompts normally through its own ctx.
      const newEvents: unknown[] = [];
      const unsubscribeNew = newSession.subscribe((event) => newEvents.push(event));
      harness.capturedApis[1].sendUserMessage('after replacement');
      await harness.firstRunStarted;
      harness.finishAllStreams();
      await newSession.waitForIdle();
      unsubscribeNew();
      unsubscribeOld();

      expect(harness.generations[1].streamCalls).toBe(1);
      expect(newEvents.length).toBeGreaterThan(0);
      expect(JSON.stringify(newSession.messages)).toContain('after replacement');
      // Still no ghost work on the disposed session after the live run.
      expect(harness.generations[0].streamCalls).toBe(0);
      expect(oldEvents.length).toBe(oldEventCountAfterReplacement);
    } finally {
      await rm(root, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});
