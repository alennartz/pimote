import { beforeEach, describe, expect, it } from 'vitest';
import { TreeDialogStore } from './tree-dialog.svelte.js';
import type { PimoteTreeNode } from '@pimote/shared';

function node(overrides: Partial<PimoteTreeNode> & Pick<PimoteTreeNode, 'id' | 'type' | 'preview' | 'timestamp'>): PimoteTreeNode {
  return {
    role: undefined,
    customType: undefined,
    label: undefined,
    labelTimestamp: undefined,
    children: [],
    ...overrides,
  };
}

describe('TreeDialogStore', () => {
  let store: TreeDialogStore;

  beforeEach(() => {
    store = new TreeDialogStore();
  });

  it('starts closed with no tree data', () => {
    expect(store.state.open).toBe(false);
    expect(store.state.sessionId).toBeNull();
    expect(store.state.tree).toBeNull();
    expect(store.state.currentLeafId).toBeNull();
    expect(store.selectedNodeId).toBeNull();
  });

  it('opens with session-scoped tree data and selects the active leaf', () => {
    const tree: PimoteTreeNode[] = [
      node({ id: 'u1', type: 'message', role: 'user', preview: 'Root user message', timestamp: '2026-04-11T10:00:00.000Z' }),
      node({ id: 'a1', type: 'message', role: 'assistant', preview: 'Assistant response', timestamp: '2026-04-11T10:01:00.000Z' }),
    ];

    store.openDialog('session-123', tree, 'a1');

    expect(store.state.open).toBe(true);
    expect(store.state.sessionId).toBe('session-123');
    expect(store.state.tree).toEqual(tree);
    expect(store.state.currentLeafId).toBe('a1');
    expect(store.selectedNodeId).toBe('a1');
    expect(store.state.loading).toBe(false);
  });

  it('resets fold state when filter mode changes', () => {
    store.openDialog('session-123', [], null);
    store.toggleExpanded('u1');
    expect(store.expandedNodeIds.has('u1')).toBe(true);

    store.setFilterMode('all');

    expect(store.state.filterMode).toBe('all');
    expect(store.expandedNodeIds.size).toBe(0);
  });

  it('resets fold state when search query changes', () => {
    store.openDialog('session-123', [], null);
    store.toggleExpanded('u1');
    expect(store.expandedNodeIds.has('u1')).toBe(true);

    store.setSearchQuery('summary');

    expect(store.state.searchQuery).toBe('summary');
    expect(store.expandedNodeIds.size).toBe(0);
  });

  it('filters out label/custom entries in default mode and keeps user/assistant history', () => {
    store.openDialog(
      'session-123',
      [
        node({ id: 'm1', type: 'message', role: 'user', preview: 'Question', timestamp: '2026-04-11T10:00:00.000Z' }),
        node({ id: 'm2', type: 'message', role: 'assistant', preview: 'Answer', timestamp: '2026-04-11T10:01:00.000Z' }),
        node({ id: 'l1', type: 'label', preview: 'bookmark', timestamp: '2026-04-11T10:02:00.000Z' }),
        node({ id: 'c1', type: 'custom', customType: 'trace', preview: 'debug details', timestamp: '2026-04-11T10:03:00.000Z' }),
      ],
      'm2',
    );

    store.setFilterMode('default');
    expect(store.getFilteredTree().map((n) => n.id)).toEqual(['m1', 'm2']);
  });

  it('applies label edits locally without requiring a full tree refetch', () => {
    store.openDialog('session-123', [node({ id: 'm1', type: 'message', preview: 'Question', timestamp: '2026-04-11T10:00:00.000Z' })], 'm1');

    store.setNodeLabel('m1', 'Important branch');

    expect(store.state.tree?.[0].label).toBe('Important branch');
  });

  it('closes and clears all state', () => {
    store.openDialog('session-123', [node({ id: 'm1', type: 'message', preview: 'Question', timestamp: '2026-04-11T10:00:00.000Z' })], 'm1');
    store.setLoading(true);
    store.toggleExpanded('m1');

    store.closeDialog();

    expect(store.state.open).toBe(false);
    expect(store.state.sessionId).toBeNull();
    expect(store.state.tree).toBeNull();
    expect(store.state.currentLeafId).toBeNull();
    expect(store.state.loading).toBe(false);
    expect(store.selectedNodeId).toBeNull();
    expect(store.expandedNodeIds.size).toBe(0);
  });
});
