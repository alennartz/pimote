import { describe, expect, it } from 'vitest';
import { discoverProvider, registerProvider } from './provider.js';
import type { SubagentPresentationProvider } from './presentation.js';

type Handler = (data: unknown) => void;

function createBus() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(channel: string, handler: Handler) {
      const set = handlers.get(channel) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel: string, data: unknown) {
      for (const handler of Array.from(handlers.get(channel) ?? [])) {
        handler(data);
      }
    },
  };
}

function fakeProvider(): SubagentPresentationProvider {
  const rejected = () => Promise.reject(new Error('unused'));
  return {
    snapshot: () => ({ sequence: 0, ready: true, nodes: [] }),
    subscribe: () => () => undefined,
    presenters: {
      toolNames: [],
      customTypes: [],
      presentToolCall: () => undefined,
      presentMessage: () => undefined,
      runningToolProgress: () => undefined,
    },
    acquire: rejected,
    teardown: rejected,
    stop: rejected,
    setHold: rejected,
    resurrect: rejected,
  };
}

describe('subagent provider discovery', () => {
  it('reports a provider registered before discovery starts', () => {
    const bus = createBus();
    const provider = fakeProvider();
    registerProvider(bus, provider);
    const discovery = discoverProvider(bus);
    expect(discovery.provider).toBe(provider);
  });

  it('reports a provider registered after discovery starts', () => {
    const bus = createBus();
    const discovery = discoverProvider(bus);
    const seen: Array<SubagentPresentationProvider | undefined> = [];
    discovery.subscribe((provider) => seen.push(provider));
    const provider = fakeProvider();
    registerProvider(bus, provider);
    expect(seen).toEqual([provider]);
  });

  it('reports removal and then a replacement', () => {
    const bus = createBus();
    const discovery = discoverProvider(bus);
    const seen: Array<SubagentPresentationProvider | undefined> = [];
    discovery.subscribe((provider) => seen.push(provider));
    const first = fakeProvider();
    const unregister = registerProvider(bus, first);
    unregister();
    const second = fakeProvider();
    registerProvider(bus, second);
    expect(seen).toEqual([first, undefined, second]);
    expect(discovery.provider).toBe(second);
  });

  it('stops answering requests after unregister', () => {
    const bus = createBus();
    registerProvider(bus, fakeProvider())();
    expect(discoverProvider(bus).provider).toBeUndefined();
  });

  it('delivers nothing after close', () => {
    const bus = createBus();
    const discovery = discoverProvider(bus);
    const seen: Array<SubagentPresentationProvider | undefined> = [];
    discovery.subscribe((provider) => seen.push(provider));
    discovery.close();
    registerProvider(bus, fakeProvider());
    expect(seen).toEqual([]);
  });
});
