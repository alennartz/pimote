import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PimoteCommand, PimoteEvent, PimoteResponse, PimoteTreeNode } from '@pimote/shared';
import { BranchTreeStore, type BranchTreeTransport } from './branch-tree-store.svelte.js';

const TREE: PimoteTreeNode[] = [
  {
    id: 'u1',
    type: 'message',
    role: 'user',
    preview: 'Fix the retry test.',
    conversationText: 'Fix the retry test.',
    timestamp: '2026-04-11T10:00:00.000Z',
    children: [],
  },
];

function makeTransport() {
  const commands: PimoteCommand[] = [];
  let listener: ((event: PimoteEvent) => void) | null = null;
  const transport: BranchTreeTransport = {
    send: vi.fn(async (command: PimoteCommand): Promise<PimoteResponse> => {
      commands.push(command);
      return { id: command.id ?? 'response', success: true, data: { tree: TREE, currentLeafId: 'u1' } };
    }),
    onEvent: vi.fn((next: (event: PimoteEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  return {
    transport,
    commands,
    emit(event: PimoteEvent) {
      listener?.(event);
    },
  };
}

describe('BranchTreeStore', () => {
  let harness: ReturnType<typeof makeTransport>;
  let store: BranchTreeStore;

  beforeEach(() => {
    harness = makeTransport();
    store = new BranchTreeStore(harness.transport);
  });

  it('fetches a tree lazily and reuses the per-session snapshot cache', async () => {
    await store.open('session-1');
    await store.open('session-1');

    expect(harness.commands.filter((command) => command.type === 'get_tree')).toHaveLength(1);
    expect(store.state.tree).toEqual(TREE);
    expect(store.state.currentLeafId).toBe('u1');
  });

  it('fetches a different session and focuses the requested message', async () => {
    await store.openFocused('session-2', 'u1');

    expect(harness.commands).toContainEqual(expect.objectContaining({ type: 'get_tree', sessionId: 'session-2' }));
    expect(store.state.sessionId).toBe('session-2');
    expect(store.state.focusedEntryId).toBe('u1');
    expect(store.state.selectedId).toBe('u1');
  });

  it('tracks segment expansion, selection, and anchor-first search', () => {
    store.toggleSegment('segment-1');
    expect(store.state.expandedSegmentIds).toEqual(new Set(['segment-1']));

    store.select('u1');
    expect(store.state.selectedId).toBe('u1');

    store.setSearch('retry');
    expect(store.state.searchQuery).toBe('retry');
    expect(store.state.searchScope).toBe('anchors');

    store.searchAll('retry');
    expect(store.state.searchQuery).toBe('retry');
    expect(store.state.searchScope).toBe('all');
  });

  it('sends one-click redo without compaction and explicit compaction options', async () => {
    store.state.sessionId = 'session-1';

    await store.navigate('u1');
    await store.navigate('u1', { compactionPrompt: '' });
    await store.navigate('u1', { compactionPrompt: 'Keep the retry diagnosis.' });

    expect(harness.commands).toEqual([
      expect.objectContaining({ type: 'navigate_tree', sessionId: 'session-1', targetId: 'u1' }),
      expect.objectContaining({ type: 'navigate_tree', sessionId: 'session-1', targetId: 'u1', summarize: true }),
      expect.objectContaining({
        type: 'navigate_tree',
        sessionId: 'session-1',
        targetId: 'u1',
        summarize: true,
        customInstructions: 'Keep the retry diagnosis.',
        replaceInstructions: false,
      }),
    ]);
    expect(harness.commands[0]).not.toHaveProperty('summarize');
  });

  it('updates labels through the tree command and preserves an empty label as a clear', async () => {
    store.state.sessionId = 'session-1';

    await store.setLabel('u1', 'important branch');
    await store.setLabel('u1', undefined);

    expect(harness.commands[0]).toEqual(expect.objectContaining({ type: 'set_tree_label', sessionId: 'session-1', entryId: 'u1', label: 'important branch' }));
    expect(harness.commands[1]).toEqual(expect.objectContaining({ type: 'set_tree_label', sessionId: 'session-1', entryId: 'u1' }));
    expect((harness.commands[1] as { label?: string }).label).toBeUndefined();
  });

  it('invalidates the session cache on full resync and tracks tree navigation lifecycle', async () => {
    await store.open('session-1');
    harness.emit({ type: 'tree_navigation_start', sessionId: 'session-1', cursor: 1, targetId: 'u1', summarizing: true });
    expect(store.state.busy).toBe(true);

    harness.emit({ type: 'tree_navigation_end', sessionId: 'session-1', cursor: 2 });
    expect(store.state.busy).toBe(false);

    harness.emit({
      type: 'full_resync',
      sessionId: 'session-1',
      state: {} as never,
      messages: [],
    });
    expect(store.state.open).toBe(false);

    await store.open('session-1');
    expect(harness.commands.filter((command) => command.type === 'get_tree')).toHaveLength(2);
  });
});
