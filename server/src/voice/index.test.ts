// Minimal smoke test for `createVoiceExtension`. The heavy behaviour is
// exercised via the pure reducer tests (`extension-runtime.test.ts`) and
// walk-back tests; this file only verifies that the factory returns a
// function which, when invoked with a mock `ExtensionAPI`, registers the
// expected hooks and the `speak` tool without throwing.

import { describe, expect, it, vi } from 'vitest';
import { createVoiceExtension } from './index.js';

function createMockPi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools: string[] = [];
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();

  const pi = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerTool: vi.fn((tool: { name: string }) => {
      tools.push(tool.name);
    }),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(async () => true),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn((channel: string, data: unknown) => {
        for (const h of busHandlers.get(channel) ?? []) h(data);
      }),
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {
          const cur = busHandlers.get(channel) ?? [];
          busHandlers.set(
            channel,
            cur.filter((h) => h !== handler),
          );
        };
      }),
    },
  };

  return { pi, handlers, tools, busHandlers };
}

describe('createVoiceExtension', () => {
  it('returns a factory that registers speak tool and core hooks', async () => {
    const factory = createVoiceExtension({
      defaultInterpreterModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      defaultWorkerModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    });
    expect(typeof factory).toBe('function');

    const { pi, handlers, tools } = createMockPi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await factory(pi as any);

    expect(tools).toContain('speak');
    const registeredHooks = Array.from(handlers.keys()).sort();
    for (const hook of ['before_agent_start', 'context', 'tool_call', 'turn_end', 'message_update']) {
      expect(registeredHooks).toContain(hook);
    }
  });
});

describe('createVoiceExtension speak streaming', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Frame = any;

  function setupActive() {
    const sent: Frame[] = [];
    const fakeClient = {
      send: (f: Frame) => {
        sent.push(f);
      },
      onFrame: () => () => {},
      close: () => {},
    };
    const factory = createVoiceExtension({
      defaultInterpreterModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      defaultWorkerModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      speechmuxClientFactory: async () => fakeClient,
    });
    const { pi, handlers, busHandlers } = createMockPi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(pi as any);
    return { sent, handlers, busHandlers };
  }

  async function activate(busHandlers: Map<string, Array<(d: unknown) => void>>): Promise<void> {
    const list = busHandlers.get('pimote:voice:activate') ?? [];
    for (const h of list) h({ type: 'pimote:voice:activate', sessionId: 's1', speechmuxWsUrl: 'ws://x' });
    // Let the open_speechmux microtask resolve.
    await new Promise((r) => setTimeout(r, 0));
  }

  function emitMessageUpdate(handlers: Map<string, Array<(...args: unknown[]) => unknown>>, ame: Frame): void {
    const list = handlers.get('message_update') ?? [];
    for (const h of list) h({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: ame }, {});
  }

  it('streams speak() argument fragments to speechmux as JSON deltas arrive', async () => {
    const { sent, handlers, busHandlers } = setupActive();
    await activate(busHandlers);

    // Drain the activation-time frames (none yet, but be defensive).
    sent.length = 0;

    const partial = { content: [{ type: 'tool_use', name: 'speak', id: 'tu_1' }] };
    emitMessageUpdate(handlers, { type: 'start', partial: { content: [] } });
    emitMessageUpdate(handlers, { type: 'toolcall_start', contentIndex: 0, partial });
    // Fragments of {"text":"Hello, world"} split arbitrarily.
    emitMessageUpdate(handlers, { type: 'toolcall_delta', contentIndex: 0, delta: '{"te', partial });
    emitMessageUpdate(handlers, { type: 'toolcall_delta', contentIndex: 0, delta: 'xt":"Hello,', partial });
    emitMessageUpdate(handlers, { type: 'toolcall_delta', contentIndex: 0, delta: ' world"}', partial });
    emitMessageUpdate(handlers, {
      type: 'toolcall_end',
      contentIndex: 0,
      partial,
      toolCall: { id: 'tu_1', name: 'speak', arguments: { text: 'Hello, world' } },
    });

    // We should have received one or more `token` frames whose concatenated
    // texts equal the full speak argument.
    const tokenTexts = sent.filter((f) => f.type === 'token').map((f) => f.text as string);
    expect(tokenTexts.length).toBeGreaterThan(0);
    expect(tokenTexts.join('')).toBe('Hello, world');

    // Now the `tool_call` hook fires — must NOT re-send the full text.
    const toolCallHandlers = handlers.get('tool_call') ?? [];
    sent.length = 0;
    for (const h of toolCallHandlers) {
      await h({ type: 'tool_call', toolName: 'speak', toolCallId: 'tu_1', input: { text: 'Hello, world' } }, {});
    }
    const postToolCallTokens = sent.filter((f) => f.type === 'token');
    expect(postToolCallTokens).toEqual([]);
  });

  it('falls back to bulk send in tool_call when no streaming deltas were observed', async () => {
    const { sent, handlers, busHandlers } = setupActive();
    await activate(busHandlers);
    sent.length = 0;

    const toolCallHandlers = handlers.get('tool_call') ?? [];
    for (const h of toolCallHandlers) {
      await h({ type: 'tool_call', toolName: 'speak', toolCallId: 'tu_2', input: { text: 'fallback path' } }, {});
    }
    expect(sent).toEqual([{ type: 'token', text: 'fallback path' }]);
  });

  it('buffers speak tokens that arrive before the WS opens and flushes them on open (pre-warm)', async () => {
    // Held-open client factory: resolves only when we call `release()`. This
    // simulates speechmux WS still handshaking while the interpreter LLM
    // greeting is already streaming.
    const sent: Frame[] = [];
    const fakeClient = {
      send: (f: Frame) => {
        sent.push(f);
      },
      onFrame: () => () => {},
      close: () => {},
    };
    let release: () => void = () => {};
    const clientReady = new Promise<typeof fakeClient>((resolve) => {
      release = () => resolve(fakeClient);
    });
    const factory = createVoiceExtension({
      defaultInterpreterModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      defaultWorkerModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      speechmuxClientFactory: () => clientReady,
    });
    const { pi, handlers, busHandlers } = createMockPi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(pi as any);

    // Fire activate. The wiring's executeActions runs set_model, then
    // send_user_message (sync), then awaits clientReady for open_speechmux
    // — but since executeActions itself isn't awaited by the bus handler
    // caller, control returns to us immediately.
    const list = busHandlers.get('pimote:voice:activate') ?? [];
    for (const h of list) h({ type: 'pimote:voice:activate', sessionId: 's1', speechmuxWsUrl: 'ws://x' });
    // Yield so sync portions of executeActions run.
    await new Promise((r) => setTimeout(r, 0));

    // Now simulate the interpreter LLM already streaming the greeting
    // while the WS is still handshaking. These token frames must be
    // buffered, not dropped.
    const partial = { content: [{ type: 'tool_use', name: 'speak', id: 'tu_pre' }] };
    const update = (ame: Frame) =>
      (handlers.get('message_update') ?? []).forEach((h) => h({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: ame }, {}));
    update({ type: 'start', partial: { content: [] } });
    update({ type: 'toolcall_start', contentIndex: 0, partial });
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"text":"Hey', partial });
    update({ type: 'toolcall_delta', contentIndex: 0, delta: ', I\'m here."}', partial });

    // WS is still not open — nothing should have been sent yet.
    expect(sent).toEqual([]);

    // Release the WS handshake. The executor should flush the buffered
    // frames into the newly-opened client before anything else.
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const tokenTexts = sent.filter((f) => f.type === 'token').map((f) => f.text as string);
    expect(tokenTexts.join('')).toBe("Hey, I'm here.");
  });

  it('does not stream non-speak tool calls', async () => {
    const { sent, handlers, busHandlers } = setupActive();
    await activate(busHandlers);
    sent.length = 0;

    const partial = { content: [{ type: 'tool_use', name: 'bash', id: 'tu_3' }] };
    emitMessageUpdate(handlers, { type: 'start', partial: { content: [] } });
    emitMessageUpdate(handlers, { type: 'toolcall_start', contentIndex: 0, partial });
    emitMessageUpdate(handlers, { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"ls"}', partial });
    emitMessageUpdate(handlers, {
      type: 'toolcall_end',
      contentIndex: 0,
      partial,
      toolCall: { id: 'tu_3', name: 'bash', arguments: { command: 'ls' } },
    });

    const tokenFrames = sent.filter((f) => f.type === 'token');
    expect(tokenFrames).toEqual([]);
  });
});
