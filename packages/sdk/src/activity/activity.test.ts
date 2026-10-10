import { describe, it, expect, beforeEach, vi } from 'vitest';
import { answerActivity } from './answer.js';
import { askActivity } from './ask.js';
import type { EventBus, ExtensionAPI } from '@earendil-works/pi-coding-agent';

// --- Helpers ---

function createMockEventBus(): EventBus & { handlers: Map<string, Set<(data: unknown) => void>> } {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    handlers,
    emit(channel: string, data: unknown): void {
      const set = handlers.get(channel);
      if (set) {
        for (const handler of set) handler(data);
      }
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
  };
}

function createMockExtensionAPI(eventBus: EventBus): ExtensionAPI {
  return { events: eventBus } as unknown as ExtensionAPI;
}

/** Install a raw pimote-side responder (no SDK helper) answering the given flag. */
function installRawResponder(eventBus: EventBus, active: boolean): void {
  eventBus.on('pimote:activity:request', () => {
    eventBus.emit('pimote:activity:response', { active });
  });
}

// --- Tests ---

describe('@pimote/activity askActivity', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    eventBus = createMockEventBus();
  });

  it('returns false when no responder is present (fail-open)', () => {
    expect(askActivity(eventBus)).toBe(false);
  });

  it('returns true when a responder reports active work', () => {
    installRawResponder(eventBus, true);
    expect(askActivity(eventBus)).toBe(true);
  });

  it('returns false when a responder reports no work', () => {
    installRawResponder(eventBus, false);
    expect(askActivity(eventBus)).toBe(false);
  });

  it('ORs multiple responder answers — any active holds', () => {
    installRawResponder(eventBus, false);
    installRawResponder(eventBus, true);
    expect(askActivity(eventBus)).toBe(true);
  });

  it('leaves no listener behind after the poll', () => {
    askActivity(eventBus);
    expect(eventBus.handlers.get('pimote:activity:response')?.size ?? 0).toBe(0);
  });
});

describe('@pimote/activity answerActivity', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let pi: ExtensionAPI;

  beforeEach(() => {
    eventBus = createMockEventBus();
    pi = createMockExtensionAPI(eventBus);
  });

  it('answers a raw askActivity poll with the callback result', () => {
    answerActivity(pi, () => true);
    expect(askActivity(eventBus)).toBe(true);

    // Fresh bus with an inactive responder.
    const idleBus = createMockEventBus();
    answerActivity(createMockExtensionAPI(idleBus), () => false);
    expect(askActivity(idleBus)).toBe(false);
  });

  it('answers active when the predicate throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    answerActivity(pi, () => {
      throw new Error('registry unavailable');
    });
    expect(askActivity(eventBus)).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('stops answering after the returned unsubscribe', () => {
    const unsubscribe = answerActivity(pi, () => true);
    unsubscribe();
    expect(askActivity(eventBus)).toBe(false);
  });

  it('reads the callback at poll time, not registration time', () => {
    let live = false;
    answerActivity(pi, () => live);

    expect(askActivity(eventBus)).toBe(false);
    live = true;
    expect(askActivity(eventBus)).toBe(true);
  });
});
