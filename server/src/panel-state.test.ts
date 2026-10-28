import { describe, it, expect, beforeEach } from 'vitest';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import type { Card } from '../../shared/dist/index.js';

function makeCard(id: string, title: string): Card {
  return { id, header: { title } };
}

describe('Panel State', () => {
  let panelState: Map<string, Card[]>;

  beforeEach(() => {
    panelState = new Map();
  });

  describe('applyPanelMessage', () => {
    it('stores cards for a namespace on cards message', () => {
      const cards = [makeCard('c1', 'Card 1'), makeCard('c2', 'Card 2')];
      applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards });

      expect(panelState.get('agents')).toEqual(cards);
    });

    it('replaces cards on subsequent update to same namespace', () => {
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'agents',
        cards: [makeCard('c1', 'Old')],
      });
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'agents',
        cards: [makeCard('c2', 'New')],
      });

      expect(panelState.get('agents')).toEqual([makeCard('c2', 'New')]);
    });

    it('stores cards independently for different namespaces', () => {
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'agents',
        cards: [makeCard('a1', 'Agent Card')],
      });
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'metrics',
        cards: [makeCard('m1', 'Metric Card')],
      });

      expect(panelState.get('agents')).toEqual([makeCard('a1', 'Agent Card')]);
      expect(panelState.get('metrics')).toEqual([makeCard('m1', 'Metric Card')]);
    });

    it('removes namespace on clear message', () => {
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'agents',
        cards: [makeCard('c1', 'Card')],
      });
      applyPanelMessage(panelState, { type: 'clear', namespace: 'agents' });

      expect(panelState.has('agents')).toBe(false);
    });

    it('clear on non-existent namespace is a no-op', () => {
      applyPanelMessage(panelState, { type: 'clear', namespace: 'nonexistent' });

      expect(panelState.size).toBe(0);
    });

    it('empty cards array sets the namespace with empty list', () => {
      applyPanelMessage(panelState, {
        type: 'cards',
        namespace: 'agents',
        cards: [],
      });

      expect(panelState.has('agents')).toBe(true);
      expect(panelState.get('agents')).toEqual([]);
    });

    it.each([
      undefined,
      null,
      {},
      { type: 'cards', namespace: 'agents' },
      { type: 'cards', namespace: 'agents', cards: null },
      { type: 'cards', namespace: 'agents', cards: {} },
      { type: 'cards', namespace: 'agents', cards: 1 },
      { type: 'cards', namespace: 'agents', cards: [null] },
      { type: 'cards', namespace: 'agents', cards: [{}] },
      { type: 'cards', namespace: 'agents', cards: [{ id: 'card', header: null }] },
      { type: 'cards', namespace: 'agents', cards: [{ id: 'card', header: { title: 'Card' }, body: [{ content: 'bad', style: 'unknown' }] }] },
      { type: 'cards', namespace: 'agents', cards: [{ id: 'card', header: { title: 'Card' }, footer: [1] }] },
      { type: 'cards', namespace: 'agents', cards: [{ id: 1, header: { title: 'Card' } }] },
      { type: 'cards', namespace: 1, cards: [] },
      { type: 'unknown', namespace: 'agents' },
    ])('rejects malformed messages atomically: %o', (message) => {
      const oldCards = [makeCard('old', 'Old')];
      panelState.set('agents', oldCards);

      expect(applyPanelMessage(panelState, message as unknown)).toBe(false);
      expect(panelState.get('agents')).toBe(oldCards);
    });

    it('snapshots valid cards instead of retaining caller-owned references', () => {
      const card = {
        id: 'card',
        color: 'active' as const,
        header: { title: 'Card', tag: 'tag' },
        body: [{ content: 'body', style: 'code' as const }],
        footer: ['footer'],
        href: 'not-a-url',
      };
      const cards: Card[] = [card];

      expect(applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards })).toBe(true);
      card.id = 'mutated';
      card.header.title = 'Mutated';
      card.body[0]!.content = 'mutated';
      card.footer[0] = 'mutated';
      cards.push(makeCard('new', 'New'));

      expect(panelState.get('agents')).toEqual([
        {
          id: 'card',
          color: 'active',
          header: { title: 'Card', tag: 'tag' },
          body: [{ content: 'body', style: 'code' }],
          footer: ['footer'],
          href: 'not-a-url',
        },
      ]);
    });

    it('accepts and snapshots every schema field, including empty strings', () => {
      const card = {
        id: '',
        color: 'muted' as const,
        header: { title: '', tag: '' },
        body: [{ content: '', style: 'secondary' as const }],
        footer: [''],
        href: 'javascript:not-validated',
      };
      const cards = [card];

      expect(applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards })).toBe(true);
      expect(panelState.get('agents')).toEqual(cards);
      expect(panelState.get('agents')).not.toBe(cards);
      expect(panelState.get('agents')?.[0]).not.toBe(card);
    });

    it('snapshots getter-backed schema fields before the caller can change them', () => {
      let id = 'card';
      const card: Record<string, unknown> = {
        header: { title: 'Card' },
      };
      Object.defineProperty(card, 'id', { get: () => id });

      expect(applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards: [card] } as unknown)).toBe(true);
      id = 'mutated';

      expect(panelState.get('agents')).toEqual([{ id: 'card', header: { title: 'Card' } }]);
    });

    it('rejects a throwing known getter without replacing the namespace', () => {
      const oldCards = [makeCard('old', 'Old')];
      panelState.set('agents', oldCards);
      const card: Record<string, unknown> = { header: { title: 'Card' } };
      Object.defineProperty(card, 'id', {
        get() {
          throw new Error('id getter failed');
        },
      });

      expect(applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards: [card] } as unknown)).toBe(false);
      expect(panelState.get('agents')).toBe(oldCards);
    });

    it('does not partially replace a namespace when a later card is invalid', () => {
      const oldCards = [makeCard('old', 'Old')];
      panelState.set('agents', oldCards);

      expect(
        applyPanelMessage(panelState, {
          type: 'cards',
          namespace: 'agents',
          cards: [makeCard('new', 'New'), null],
        }),
      ).toBe(false);
      expect(panelState.get('agents')).toBe(oldCards);
    });

    it('ignores circular unknown properties and custom iterators', () => {
      const card: Record<string, unknown> = {
        id: 'card',
        header: { title: 'Card' },
        extra: undefined,
      };
      card.extra = card;
      Object.defineProperty(card, 'poison', {
        get() {
          throw new Error('unknown getter must not be read');
        },
      });
      const cards = [card] as unknown as Array<Record<string, unknown>>;
      Object.defineProperty(cards, Symbol.iterator, {
        value: () => {
          throw new Error('iterator must not be used');
        },
      });

      expect(applyPanelMessage(panelState, { type: 'cards', namespace: 'agents', cards } as unknown)).toBe(true);
      expect(panelState.get('agents')).toEqual([{ id: 'card', header: { title: 'Card' } }]);
    });
  });

  describe('getMergedPanelCards', () => {
    it('returns empty array when panelState is empty', () => {
      expect(getMergedPanelCards(panelState)).toEqual([]);
    });

    it('returns cards from a single namespace with prefixed IDs', () => {
      panelState.set('agents', [makeCard('a1', 'Agent 1'), makeCard('a2', 'Agent 2')]);

      expect(getMergedPanelCards(panelState)).toEqual([makeCard('agents:a1', 'Agent 1'), makeCard('agents:a2', 'Agent 2')]);
    });

    it('merges cards from multiple namespaces in insertion order with prefixed IDs', () => {
      panelState.set('agents', [makeCard('a1', 'Agent')]);
      panelState.set('metrics', [makeCard('m1', 'Metric')]);

      expect(getMergedPanelCards(panelState)).toEqual([makeCard('agents:a1', 'Agent'), makeCard('metrics:m1', 'Metric')]);
    });

    it('preserves card order within each namespace', () => {
      panelState.set('agents', [makeCard('a1', 'First'), makeCard('a2', 'Second'), makeCard('a3', 'Third')]);

      const merged = getMergedPanelCards(panelState);
      expect(merged.map((c) => c.id)).toEqual(['agents:a1', 'agents:a2', 'agents:a3']);
    });

    it('returns empty array after all namespaces are cleared', () => {
      panelState.set('agents', [makeCard('a1', 'Agent')]);
      panelState.delete('agents');

      expect(getMergedPanelCards(panelState)).toEqual([]);
    });

    it('skips namespaces with empty card arrays', () => {
      panelState.set('empty', []);
      panelState.set('filled', [makeCard('f1', 'Filled')]);

      const merged = getMergedPanelCards(panelState);
      expect(merged).toEqual([makeCard('filled:f1', 'Filled')]);
    });
  });
});
