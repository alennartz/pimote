import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  AgentSession,
  type AgentSessionConfig,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type Extension,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

// Exercise the installed SDK, not a copy of its lifecycle implementation.
// All model responses, resources, settings, and session storage are local/in-memory.
const model: Model<'openai-completions'> = {
  id: 'settlement-test',
  name: 'Settlement test model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  input: ['text'],
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function makeSession(options: { cacheWarmer?: AgentSessionConfig['cacheWarmer']; extensions?: Extension[] } = {}) {
  const startListeners: ((stream: { finish: (reason: 'stop' | 'aborted') => void }) => void)[] = [];
  const started = new Promise<{ finish: (reason: 'stop' | 'aborted') => void }>((resolve) => {
    startListeners.push(resolve);
  });
  const streams: { finish: (reason: 'stop' | 'aborted') => void }[] = [];
  const agent = new Agent({
    initialState: { model },
    streamFn: (_model, _context, streamOptions) => {
      const stream = createAssistantMessageEventStream();
      const state = { finished: false };
      const finish = (reason: 'stop' | 'aborted') => {
        if (state.finished) return;
        state.finished = true;
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason,
          timestamp: Date.now(),
        };
        stream.push(reason === 'aborted' ? { type: 'error', reason, error: message } : { type: 'done', reason, message });
        stream.end(message);
      };
      streams.push({ finish });
      streamOptions?.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
      if (streamOptions?.signal?.aborted) finish('aborted');
      for (const resolve of startListeners.splice(0)) resolve({ finish });
      return stream;
    },
  });
  const extensions = { extensions: options.extensions ?? [], errors: [], runtime: createExtensionRuntime() };
  const session = new AgentSession({
    agent,
    sessionManager: SessionManager.inMemory('/tmp'),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      getSystemPromptSource: () => undefined,
      getAppendSystemPromptSources: () => [],
      reload: async () => {},
      extendResources: () => {},
    },
    cwd: '/tmp',
    modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true } as unknown as AgentSessionConfig['modelRuntime'],
    initialActiveToolNames: [],
    cacheWarmer: options.cacheWarmer,
  });
  return { agent, session, started, streams };
}

function observeIdle(session: AgentSession) {
  const waiters = { idle: false, abort: false };
  const idle = session.waitForIdle().then(() => {
    waiters.idle = true;
  });
  const abort = session.abort().then(() => {
    waiters.abort = true;
  });
  return { waiters, idle, abort };
}

async function expectIdle(session: AgentSession, agent: Agent, observation: ReturnType<typeof observeIdle>) {
  // Flush promise reactions without waiting forever if a regression strands a waiter.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(agent.state.isStreaming).toBe(false);
  expect(session.isStreaming).toBe(false);
  expect(session.isIdle).toBe(true);
  expect(observation.waiters).toEqual({ idle: true, abort: true });
  await Promise.all([observation.idle, observation.abort, agent.waitForIdle()]);
}

function throwOnPendingCustomMessage(session: AgentSession, error: unknown) {
  session.subscribe((event) => {
    if (event.type === 'agent_end') {
      void session.sendCustomMessage({ customType: 'late-note', content: 'queued during agent_end', display: true }, { triggerTurn: false });
    }
    if (event.type === 'message_start' && event.message.role === 'custom') throw error;
  });
}

function throwingSettledExtension(): Extension {
  return {
    path: '<settlement-test>',
    resolvedPath: '<settlement-test>',
    sourceInfo: createSyntheticSourceInfo('<settlement-test>', { source: 'settlement-test' }),
    handlers: new Map([
      [
        'agent_settled',
        [
          () => {
            throw new Error('extension settlement failed');
          },
        ],
      ],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function runResult(session: AgentSession) {
  // Install a rejection handler before completing/aborting the stream.
  return session.prompt('hello').then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

describe('installed SDK exception-safe settlement', () => {
  it('settles and releases existing idle/abort waiters when final custom-message dispatch throws', async () => {
    const { session, agent, started } = makeSession();
    const cleanupError = new Error('host custom-message listener failed');
    const settled = vi.fn();
    throwOnPendingCustomMessage(session, cleanupError);
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled();
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'rejected', error: cleanupError });
      expect(settled).toHaveBeenCalledTimes(1);
      await expectIdle(session, agent, observation);
      expect(session.sessionManager.getBranch().some((entry) => entry.type === 'custom_message' && entry.customType === 'late-note')).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('settles when persistence throws while flushing a pending bash result', async () => {
    const { session, agent, started } = makeSession();
    const cleanupError = new Error('bash-result persistence failed');
    const appendMessage = session.sessionManager.appendMessage.bind(session.sessionManager);
    vi.spyOn(session.sessionManager, 'appendMessage').mockImplementation((message) => {
      if (message.role === 'bashExecution') throw cleanupError;
      return appendMessage(message);
    });
    session.subscribe((event) => {
      if (event.type === 'agent_end') session.recordBashResult('test command', { output: 'result', exitCode: 0, cancelled: false, truncated: false });
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'rejected', error: cleanupError });
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });

  it.each([new Error('original cleanup failure'), undefined])('preserves the original cleanup rejection even if agent_settled also throws (%s)', async (cleanupError) => {
    const { session, agent, started } = makeSession();
    const settlementError = new Error('host settlement listener failed');
    const settled = vi.fn(() => {
      throw settlementError;
    });
    throwOnPendingCustomMessage(session, cleanupError);
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled();
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      const result = await run;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error).toBe(cleanupError);
      expect(settled).toHaveBeenCalledTimes(1);
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });

  it('releases existing idle waiters and preserves a public agent_settled listener error', async () => {
    const { session, agent, started } = makeSession();
    const error = new Error('host settlement listener failed');
    session.subscribe((event) => {
      if (event.type === 'agent_settled') throw error;
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'rejected', error });
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });

  it('releases idle waiters when the extension error reporter throws during settlement', async () => {
    const { session, agent, started } = makeSession({ extensions: [throwingSettledExtension()] });
    const error = new Error('extension error reporter failed');
    session.extensionRunner!.onError(() => {
      throw error;
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'rejected', error });
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });

  it('clears streaming and releases idle waiters if the cache warmer settlement callback throws', async () => {
    const error = new Error('cache warmer settlement failed');
    const { session, agent, started } = makeSession({
      cacheWarmer: {
        cancel: () => {},
        status: { state: 'inactive' },
        onModeChanged: () => {},
        onAgentSettled: () => {
          throw error;
        },
      },
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'rejected', error });
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });

  it('does not release idle waiters before a deferred settlement continuation completes', async () => {
    const { session, agent, started, streams } = makeSession();
    const state = { settled: 0, idle: false };
    session.subscribe((event) => {
      if (event.type !== 'agent_settled') return;
      state.settled++;
      if (state.settled === 1) void session.sendCustomMessage({ customType: 'continuation', content: 'continue', display: true }, { triggerTurn: true });
    });
    try {
      const run = runResult(session);
      const first = await started;
      const idle = session.waitForIdle().then(() => {
        state.idle = true;
      });
      first.finish('stop');
      await vi.waitFor(() => expect(streams).toHaveLength(2));
      expect(session.isStreaming).toBe(true);
      expect(state.idle).toBe(false);
      streams[1].finish('stop');
      expect(await run).toEqual({ status: 'fulfilled' });
      await idle;
      expect(agent.state.isStreaming).toBe(false);
      expect(session.isIdle).toBe(true);
      expect(state).toEqual({ settled: 2, idle: true });
    } finally {
      session.dispose();
    }
  });

  it('still completes successful final custom-message cleanup before agent_settled', async () => {
    const { session, agent, started } = makeSession();
    const events: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'agent_end') void session.sendCustomMessage({ customType: 'late-note', content: 'note', display: true }, { triggerTurn: false });
      if (event.type === 'message_start' && event.message.role === 'custom') events.push('custom');
      if (event.type === 'agent_settled') {
        events.push('settled');
        expect(session.isStreaming).toBe(false);
      }
    });
    try {
      const run = runResult(session);
      await started;
      const observation = observeIdle(session);
      expect(await run).toEqual({ status: 'fulfilled' });
      expect(events).toEqual(['custom', 'settled']);
      await expectIdle(session, agent, observation);
    } finally {
      session.dispose();
    }
  });
});
