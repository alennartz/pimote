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
import { describe, expect, it, vi } from 'vitest';
import { VoiceUtteranceQueue } from './utterance-queue.js';

const model: Model<'openai-completions'> = {
  id: 'voice-test',
  name: 'Voice test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  input: ['text'],
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function harness(options: { delayInput?: boolean; failInput?: boolean } = {}) {
  const streams: { finish: (reason: 'stop' | 'aborted') => void; aborted: boolean }[] = [];
  const errors: unknown[] = [];
  const sessionRef: { current: AgentSession | null } = { current: null };
  const gate = { release: (): void => {}, blocked: Boolean(options.delayInput), fail: Boolean(options.failInput) };
  const inputGate = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const queue = new VoiceUtteranceQueue(
    () => sessionRef.current!,
    (error) => errors.push(error),
  );
  const runtime = createExtensionRuntime();
  const extension: Extension = {
    path: '<voice-test>',
    resolvedPath: '<voice-test>',
    sourceInfo: createSyntheticSourceInfo('<voice-test>', { source: 'voice-test' }),
    handlers: new Map([
      ['agent_start', [() => queue.agentStarted()]],
      [
        'input',
        [
          async (event: any) => {
            if (event.text !== 'first') return;
            if (gate.blocked) await inputGate;
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
  const agent = new Agent({
    initialState: { model },
    streamFn: (_model, _context, streamOptions) => {
      const stream = createAssistantMessageEventStream();
      const state = { finished: false };
      const entry = {
        aborted: false,
        finish: (reason: 'stop' | 'aborted') => {
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
        },
      };
      streamOptions?.signal?.addEventListener(
        'abort',
        () => {
          entry.aborted = true;
        },
        { once: true },
      );
      entry.aborted = Boolean(streamOptions?.signal?.aborted);
      streams.push(entry);
      return stream;
    },
  });
  const session = new AgentSession({
    agent,
    sessionManager: SessionManager.inMemory('/tmp'),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    cwd: '/tmp',
    modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true } as unknown as AgentSessionConfig['modelRuntime'],
    initialActiveToolNames: [],
    resourceLoader: {
      getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
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
  });
  if (gate.fail) {
    vi.spyOn(session, 'sendUserMessage').mockImplementationOnce(async () => {
      await inputGate;
      throw new Error('prompt preflight rejected');
    });
  }
  sessionRef.current = session;
  await session.bindExtensions({});
  return { queue, session, streams, errors, gate, userTexts: () => session.messages.filter((message) => message.role === 'user').map((message) => message.content) };
}

describe('voice queue against the installed session interface', () => {
  it('retains FIFO utterances through abort settlement without entering SDK queues', async () => {
    const h = await harness();
    try {
      const original = h.session.prompt('original');
      await vi.waitFor(() => expect(h.streams).toHaveLength(1));
      h.queue.submit('first');
      h.queue.submit('second');
      expect(h.session.pendingMessageCount).toBe(0);
      expect(h.streams[0].aborted).toBe(true);
      h.streams[0].finish('aborted');
      await original;
      await vi.waitFor(() => expect(h.streams).toHaveLength(2));
      expect(h.streams[1].aborted).toBe(true);
      expect(h.session.pendingMessageCount).toBe(0);
      h.streams[1].finish('aborted');
      await vi.waitFor(() => expect(h.streams).toHaveLength(3));
      expect(h.streams[2].aborted).toBe(false);
      h.streams[2].finish('stop');
      await h.session.waitForIdle();
      expect(h.userTexts()).toEqual(['original', 'first', 'second'].map((text) => [{ type: 'text', text }]));
      expect(h.errors).toEqual([]);
    } finally {
      h.queue.cancelPending();
      h.session.dispose();
    }
  });

  it('serializes async preflight and aborts its first run when the next utterance is pending', async () => {
    const h = await harness({ delayInput: true });
    try {
      h.queue.submit('first');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.session.isIdle).toBe(true);
      h.queue.submit('second');
      expect(h.streams).toEqual([]);
      h.gate.release();
      await vi.waitFor(() => expect(h.streams).toHaveLength(1));
      expect(h.streams[0].aborted).toBe(true);
      h.streams[0].finish('aborted');
      await vi.waitFor(() => expect(h.streams).toHaveLength(2));
      h.streams[1].finish('stop');
      await h.session.waitForIdle();
      expect(h.userTexts()).toEqual(['first', 'second'].map((text) => [{ type: 'text', text }]));
      expect(h.errors).toEqual([]);
    } finally {
      h.queue.cancelPending();
      h.session.dispose();
    }
  });

  it('reports preflight failure and preserves the remaining backlog for the next request', async () => {
    const h = await harness({ delayInput: true, failInput: true });
    try {
      h.queue.submit('first');
      h.queue.submit('second');
      h.gate.release();
      await vi.waitFor(() => expect(h.errors).toHaveLength(1));
      expect(h.streams).toEqual([]);
      h.queue.submit('third');
      await vi.waitFor(() => expect(h.streams).toHaveLength(1));
      expect(h.streams[0].aborted).toBe(true);
      h.streams[0].finish('aborted');
      await vi.waitFor(() => expect(h.streams).toHaveLength(2));
      h.streams[1].finish('stop');
      await h.session.waitForIdle();
      expect(h.userTexts()).toEqual(['second', 'third'].map((text) => [{ type: 'text', text }]));
    } finally {
      h.queue.cancelPending();
      h.session.dispose();
    }
  });

  it('aborts a cancelled preflight as soon as it reaches agent_start and never submits its backlog', async () => {
    const h = await harness({ delayInput: true });
    try {
      h.queue.submit('first');
      h.queue.submit('second');
      await new Promise<void>((resolve) => setImmediate(resolve));
      h.queue.cancelPending();
      h.gate.release();
      await vi.waitFor(() => expect(h.streams).toHaveLength(1));
      expect(h.streams[0].aborted).toBe(true);
      h.streams[0].finish('aborted');
      await h.session.waitForIdle();
      expect(h.userTexts()).toEqual([[{ type: 'text', text: 'first' }]]);
      expect(h.session.pendingMessageCount).toBe(0);
      expect(h.streams).toHaveLength(1);
    } finally {
      h.queue.cancelPending();
      h.session.dispose();
    }
  });
});
