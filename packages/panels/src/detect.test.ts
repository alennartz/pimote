import { describe, it, expect, beforeEach } from 'vitest';
import { detect } from './detect.js';
import type { Card } from './types.js';
import type { EventBus, ExtensionAPI } from '@mariozechner/pi-coding-agent';

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

/** Simulate pimote server detection listener on the EventBus */
function installDetectionListener(eventBus: EventBus): void {
  eventBus.on('pimote:detect:request', () => {
    eventBus.emit('pimote:detect:response', { detected: true });
  });
}

function makeCard(id: string, title: string): Card {
  return { id, header: { title } };
}

// --- Tests ---

describe('@pimote/panels detect', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let pi: ExtensionAPI;

  beforeEach(() => {
    eventBus = createMockEventBus();
    pi = createMockExtensionAPI(eventBus);
  });

  describe('detection protocol', () => {
    it('returns null when no pimote listener is present', () => {
      const handle = detect(pi, 'test');
      expect(handle).toBeNull();
    });

    it('returns a PanelHandle when pimote listener is registered', () => {
      installDetectionListener(eventBus);
      const handle = detect(pi, 'test');
      expect(handle).not.toBeNull();
    });
  });

  describe('handle lifecycle', () => {
    it('second detect with same key deactivates previous handle', () => {
      installDetectionListener(eventBus);
      const handle1 = detect(pi, 'agents');
      const handle2 = detect(pi, 'agents');

      expect(handle1).not.toBeNull();
      expect(handle2).not.toBeNull();
      expect(handle1).not.toBe(handle2);

      // handle1 should be deactivated — no events emitted
      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handle1!.updateCards([makeCard('c1', 'Card 1')]);
      expect(received).toHaveLength(0);

      // handle2 should be active
      handle2!.updateCards([makeCard('c1', 'Card 1')]);
      expect(received).toHaveLength(1);
    });

    it('different keys produce independent handles', () => {
      installDetectionListener(eventBus);
      const handleA = detect(pi, 'alpha');
      const handleB = detect(pi, 'beta');

      expect(handleA).not.toBeNull();
      expect(handleB).not.toBeNull();

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handleA!.updateCards([makeCard('a1', 'Alpha Card')]);
      handleB!.updateCards([makeCard('b1', 'Beta Card')]);

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ type: 'cards', namespace: 'alpha', cards: [makeCard('a1', 'Alpha Card')] });
      expect(received[1]).toEqual({ type: 'cards', namespace: 'beta', cards: [makeCard('b1', 'Beta Card')] });
    });
  });

  describe('PanelHandle.updateCards', () => {
    it('emits cards event on pimote:panels channel', () => {
      installDetectionListener(eventBus);
      const handle = detect(pi, 'test-ns');

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      const cards = [makeCard('c1', 'First'), makeCard('c2', 'Second')];
      handle!.updateCards(cards);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        type: 'cards',
        namespace: 'test-ns',
        cards,
      });
    });

    it('replaces previous cards on subsequent calls', () => {
      installDetectionListener(eventBus);
      const handle = detect(pi, 'test-ns');

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handle!.updateCards([makeCard('c1', 'First')]);
      handle!.updateCards([makeCard('c2', 'Replaced')]);

      expect(received).toHaveLength(2);
      expect(received[1]).toEqual({
        type: 'cards',
        namespace: 'test-ns',
        cards: [makeCard('c2', 'Replaced')],
      });
    });
  });

  describe('PanelHandle.clear', () => {
    it('emits clear event on pimote:panels channel', () => {
      installDetectionListener(eventBus);
      const handle = detect(pi, 'test-ns');

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handle!.clear();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        type: 'clear',
        namespace: 'test-ns',
      });
    });
  });

  describe('deactivated handle', () => {
    it('updateCards is a no-op on a deactivated handle', () => {
      installDetectionListener(eventBus);
      const handle1 = detect(pi, 'key');
      detect(pi, 'key'); // deactivates handle1

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handle1!.updateCards([makeCard('c1', 'Should not emit')]);
      expect(received).toHaveLength(0);
    });

    it('clear is a no-op on a deactivated handle', () => {
      installDetectionListener(eventBus);
      const handle1 = detect(pi, 'key');
      detect(pi, 'key'); // deactivates handle1

      const received: unknown[] = [];
      eventBus.on('pimote:panels', (data) => received.push(data));

      handle1!.clear();
      expect(received).toHaveLength(0);
    });
  });
});
