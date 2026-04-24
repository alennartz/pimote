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
