import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceExtension } from './index.js';
import type { IncomingFrame, SpeechmuxClient } from './speechmux-client.js';
import { VOICE_CALL_STARTED_SENTINEL } from './state-machine.js';

function deferred() {
  const result = { resolve: (): void => {} };
  const promise = new Promise<void>((resolve) => {
    result.resolve = resolve;
  });
  return { promise, resolve: () => result.resolve() };
}

async function flush() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

function harness() {
  type Handler = (event: any, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Set<Handler>>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const frameListeners = new Set<(frame: IncomingFrame) => void>();
  const disconnectListeners = new Set<() => void>();
  const idleWaiters = new Set<() => void>();
  const pendingRuns = new Set<ReturnType<typeof deferred>>();
  const calls: { text: string; options: unknown; start: () => Promise<void> }[] = [];
  const status = { idle: true };
  const ctx = {
    isIdle: () => status.idle,
    abort: () => {
      void session.abort();
    },
    modelRegistry: { find: () => ({ provider: 'test', id: 'voice' }) },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
  };
  const session = {
    get isIdle() {
      return status.idle;
    },
    waitForIdle: vi.fn(() => (status.idle ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.add(resolve)))),
    abort: vi.fn(() => session.waitForIdle()),
    sendUserMessage: vi.fn((text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
      const run = deferred();
      calls.push({
        text,
        options,
        start: async () => {
          status.idle = false;
          pendingRuns.add(run);
          await emit('agent_start');
        },
      });
      // Steering a running turn is accepted into the SDK's queue immediately.
      return !status.idle && options?.deliverAs === 'steer' ? Promise.resolve() : run.promise;
    }),
  };
  const client: SpeechmuxClient = {
    send: vi.fn(),
    close: vi.fn(),
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => {
        disconnectListeners.delete(listener);
      };
    },
  };
  const pi = {
    on: (name: string, handler: Handler) => {
      const listeners = handlers.get(name) ?? new Set<Handler>();
      handlers.set(name, listeners);
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    events: {
      on: (name: string, listener: (data: unknown) => void) => {
        busHandlers.set(name, listener);
        return () => {
          busHandlers.delete(name);
        };
      },
      emit: (name: string, data: unknown) => {
        busHandlers.get(name)?.(data);
      },
    },
    registerTool: vi.fn(),
    setModel: vi.fn(async () => true),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: (text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
      void session.sendUserMessage(text, options);
    },
  } as unknown as ExtensionAPI;
  createVoiceExtension({
    defaultInterpreterModel: 'test/voice',
    defaultWorkerModel: 'test/worker',
    speechmuxClientFactory: async () => client,
    getSession: () => session,
  })(pi);

  const settle = async () => {
    status.idle = true;
    for (const run of pendingRuns) run.resolve();
    pendingRuns.clear();
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
    await emit('agent_settled');
    await flush();
  };
  const activate = async () => {
    await emit('before_agent_start', { systemPromptOptions: { sections: {} } });
    pi.events.emit('pimote:voice:activate', { type: 'pimote:voice:activate', sessionId: 'session', speechmuxWsUrl: 'ws://test' });
    await flush();
  };
  return {
    session,
    status,
    calls,
    client,
    pi,
    emit,
    settle,
    activate,
    frame: (frame: IncomingFrame) => {
      for (const listener of frameListeners) listener(frame);
    },
    deactivate: () => pi.events.emit('pimote:voice:deactivate', { type: 'pimote:voice:deactivate', sessionId: 'session' }),
    listeners: (name: string) => handlers.get(name)?.size ?? 0,
    async ready() {
      await activate();
      await calls[0].start();
      await settle();
      calls.length = 0;
      session.abort.mockClear();
      session.waitForIdle.mockClear();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('voice-owned utterance submission', () => {
  it('retains an utterance across an abort teardown longer than two seconds', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'do not lose this' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.calls).toEqual([]);
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual(['do not lose this']);
    h.deactivate();
  });

  it('submits repeated utterances in FIFO order, aborting between their runs', async () => {
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'abort', reason: 'barge_in' });
    h.frame({ type: 'user', text: 'first' });
    h.frame({ type: 'user', text: 'second' });
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual(['first']);
    const aborts = h.session.abort.mock.calls.length;
    await h.calls[0].start();
    expect(h.session.abort.mock.calls.length).toBeGreaterThan(aborts);
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual(['first', 'second']);
    h.deactivate();
  });

  it('serializes utterances that arrive during asynchronous prompt startup', async () => {
    const h = harness();
    await h.ready();
    h.frame({ type: 'user', text: 'first' });
    await flush();
    expect(h.status.idle).toBe(true); // The SDK has not reached agent_start yet.
    h.frame({ type: 'user', text: 'second' });
    await flush();
    expect(h.calls.map((call) => call.text)).toEqual(['first']);
    const aborts = h.session.abort.mock.calls.length;
    await h.calls[0].start();
    expect(h.session.abort.mock.calls.length).toBeGreaterThan(aborts);
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual(['first', 'second']);
    h.deactivate();
  });

  it('cancels unsent utterances when the call ends, without waiting for settlement', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'old call' });
    h.deactivate();
    await flush();
    expect(h.listeners('agent_settled')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.client.close).toHaveBeenCalledTimes(1);
  });

  it('cancels pending utterances on explicit abort without ending the call', async () => {
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'discard this' });
    h.pi.events.emit('pimote:voice:cancel-pending', {});
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.client.close).not.toHaveBeenCalled();
    h.frame({ type: 'user', text: 'new request' });
    await flush();
    expect(h.calls.map((call) => call.text)).toEqual(['new request']);
    h.deactivate();
  });

  it("does not leak a prior call's pending utterance into a replacement call", async () => {
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'old call' });
    h.deactivate();
    await flush();
    await h.activate();
    expect(h.calls.map((call) => call.text)).toEqual([VOICE_CALL_STARTED_SENTINEL]);
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual([VOICE_CALL_STARTED_SENTINEL]);
    h.deactivate();
  });

  it.each(['session_before_switch', 'session_before_fork', 'session_before_tree'])('cancels pending utterances before %s can settle the outgoing run', async (event) => {
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'outgoing branch' });
    await h.emit(event);
    await h.settle();
    expect(h.calls).toEqual([]);
    h.deactivate();
  });

  it('cancels pending utterances and closes speechmux on session shutdown', async () => {
    const h = harness();
    await h.ready();
    h.status.idle = false;
    h.frame({ type: 'user', text: 'old session' });
    await h.emit('session_shutdown');
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.client.close).toHaveBeenCalledTimes(1);
  });

  it('preserves steer-on-activate and opens speechmux without awaiting the greeting run', async () => {
    const h = harness();
    h.status.idle = false;
    await h.activate();
    expect(h.session.abort).not.toHaveBeenCalled();
    expect(h.calls).toMatchObject([{ text: VOICE_CALL_STARTED_SENTINEL, options: { deliverAs: 'steer' } }]);
    h.frame({ type: 'user', text: 'connected' });
    await h.settle();
    expect(h.calls.map((call) => call.text)).toEqual([VOICE_CALL_STARTED_SENTINEL, 'connected']);
    h.deactivate();
  });

  it('reactivation steers a reply already running from the prior call instead of aborting it', async () => {
    const h = harness();
    await h.ready();
    h.frame({ type: 'user', text: 'running reply' });
    await flush();
    await h.calls[0].start();
    h.deactivate();
    await flush();
    const aborts = h.session.abort.mock.calls.length;
    await h.activate();
    expect(h.session.abort.mock.calls.length).toBe(aborts);
    expect(h.calls.map((call) => call.text)).toEqual(['running reply', VOICE_CALL_STARTED_SENTINEL]);
    expect(h.calls[1].options).toEqual({ deliverAs: 'steer' });
    h.deactivate();
    await h.settle();
  });

  it('does not start a stale activation after deactivation overtakes model setup', async () => {
    const h = harness();
    const modelSetup = deferred();
    vi.mocked(h.pi.setModel).mockImplementation(() => modelSetup.promise.then(() => true));
    await h.activate();
    h.deactivate();
    await flush();
    modelSetup.resolve();
    await flush();
    expect(h.calls).toEqual([]);
    h.frame({ type: 'user', text: 'stale client' });
    expect(h.calls).toEqual([]);
  });
});
