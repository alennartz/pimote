import { describe, it, expect, beforeEach } from 'vitest';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import type { Card } from '@pimote/shared';

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
  });

  describe('getMergedPanelCards', () => {
    it('returns empty array when panelState is empty', () => {
      expect(getMergedPanelCards(panelState)).toEqual([]);
    });

    it('returns cards from a single namespace', () => {
      panelState.set('agents', [makeCard('a1', 'Agent 1'), makeCard('a2', 'Agent 2')]);

      expect(getMergedPanelCards(panelState)).toEqual([makeCard('a1', 'Agent 1'), makeCard('a2', 'Agent 2')]);
    });

    it('merges cards from multiple namespaces in insertion order', () => {
      panelState.set('agents', [makeCard('a1', 'Agent')]);
      panelState.set('metrics', [makeCard('m1', 'Metric')]);

      expect(getMergedPanelCards(panelState)).toEqual([makeCard('a1', 'Agent'), makeCard('m1', 'Metric')]);
    });

    it('preserves card order within each namespace', () => {
      panelState.set('agents', [makeCard('a1', 'First'), makeCard('a2', 'Second'), makeCard('a3', 'Third')]);

      const merged = getMergedPanelCards(panelState);
      expect(merged.map((c) => c.id)).toEqual(['a1', 'a2', 'a3']);
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
      expect(merged).toEqual([makeCard('f1', 'Filled')]);
    });
  });
});
