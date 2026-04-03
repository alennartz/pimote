import { describe, it, expect, beforeEach } from 'vitest';
import { PanelStore } from './panel-store.svelte.js';
import type { Card } from '@pimote/shared';

function makeCard(id: string, title: string): Card {
  return { id, header: { title } };
}

describe('PanelStore', () => {
  let store: PanelStore;

  beforeEach(() => {
    store = new PanelStore();
  });

  describe('initial state', () => {
    it('starts with empty cards', () => {
      expect(store.cards).toEqual([]);
    });

    it('hasCards is false when empty', () => {
      expect(store.hasCards).toBe(false);
    });
  });

  describe('handlePanelUpdate', () => {
    it('replaces cards with the provided list', () => {
      const cards = [makeCard('c1', 'Card 1'), makeCard('c2', 'Card 2')];
      store.handlePanelUpdate(cards);
      expect(store.cards).toEqual(cards);
    });

    it('subsequent update replaces previous cards', () => {
      store.handlePanelUpdate([makeCard('c1', 'First')]);
      store.handlePanelUpdate([makeCard('c2', 'Second')]);
      expect(store.cards).toEqual([makeCard('c2', 'Second')]);
    });

    it('update with empty array clears cards', () => {
      store.handlePanelUpdate([makeCard('c1', 'Card')]);
      store.handlePanelUpdate([]);
      expect(store.cards).toEqual([]);
    });

    it('hasCards reflects current state after update', () => {
      expect(store.hasCards).toBe(false);
      store.handlePanelUpdate([makeCard('c1', 'Card')]);
      expect(store.hasCards).toBe(true);
      store.handlePanelUpdate([]);
      expect(store.hasCards).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all cards', () => {
      store.handlePanelUpdate([makeCard('c1', 'Card 1'), makeCard('c2', 'Card 2')]);
      store.reset();
      expect(store.cards).toEqual([]);
    });

    it('hasCards is false after reset', () => {
      store.handlePanelUpdate([makeCard('c1', 'Card')]);
      store.reset();
      expect(store.hasCards).toBe(false);
    });

    it('reset on empty store is a no-op', () => {
      store.reset();
      expect(store.cards).toEqual([]);
    });
  });

  describe('card data integrity', () => {
    it('preserves full card structure including optional fields', () => {
      const card: Card = {
        id: 'agent-1',
        color: 'success',
        header: { title: 'Scout Agent', tag: 'running' },
        body: [
          { content: 'Searching codebase...', style: 'text' },
          { content: 'grep -rn "pattern"', style: 'code' },
        ],
        footer: ['3 files found', '12s elapsed'],
      };
      store.handlePanelUpdate([card]);
      expect(store.cards[0]).toEqual(card);
    });

    it('preserves cards with only required fields', () => {
      const card: Card = { id: 'minimal', header: { title: 'Minimal Card' } };
      store.handlePanelUpdate([card]);
      expect(store.cards[0]).toEqual(card);
    });
  });
});
