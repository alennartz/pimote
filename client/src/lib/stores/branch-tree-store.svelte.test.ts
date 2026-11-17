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

  it('exposes hidden focus targets and searches visible anchors before full text and labels', async () => {
    const leaf = { ...TREE[0], id: 'last', conversationText: 'Last anchor', preview: 'Last anchor' };
    const hidden = { ...TREE[0], id: 'hidden', conversationText: 'Hidden needle', label: 'secret label', children: [leaf] };
    const first = { ...TREE[0], id: 'first', children: [hidden] };
    vi.mocked(harness.transport.send).mockResolvedValue({ id: 'tree', success: true, data: { tree: [first], currentLeafId: 'last' } });
    await store.open('session-1');
    store.setSearch('needle');
    expect(store.state.searchMatches).toEqual([]);
    store.searchAll('needle');
    expect(store.state.searchMatches.map((match) => match.messageKey)).toContain('hidden');
    expect(store.state.selectedId).toBe('hidden');
    expect(store.state.expandedSegmentIds.size).toBeGreaterThan(0);
    store.searchAll('secret');
    expect(store.state.searchMatches.map((match) => match.messageKey)).toContain('hidden');
    await store.openFocused('session-1', 'hidden');
    expect(store.state.selectedId).toBe('hidden');
    expect(store.state.expandedSegmentIds.size).toBeGreaterThan(0);
    store.setSearch('secret');
    expect(store.state.searchMatches.map((match) => match.messageKey)).toContain('hidden');
  });

  it.each(['response', 'rejection'])('keeps the explorer open and reports %s failures on open and navigate', async (failure) => {
    if (failure === 'response') vi.mocked(harness.transport.send).mockResolvedValue({ id: 'failed', success: false, error: 'Unavailable' });
    else vi.mocked(harness.transport.send).mockRejectedValue(new Error('Unavailable'));
    await store.open('session-1').catch(() => {});
    expect(store.state.open).toBe(true);
    expect(store.state.error).toBeTruthy();
    vi.mocked(harness.transport.send).mockResolvedValue({ id: 'ok', success: true, data: { tree: TREE, currentLeafId: 'u1' } });
    await store.open('session-1');
    if (failure === 'response') vi.mocked(harness.transport.send).mockResolvedValue({ id: 'failed', success: false, error: 'Unavailable' });
    else vi.mocked(harness.transport.send).mockRejectedValue(new Error('Unavailable'));
    await store.navigate('u1').catch(() => {});
    expect(store.state.open).toBe(true);
    expect(store.state.error).toBeTruthy();
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

  it('invalidates a child tree cache and closes it after a child snapshot resync', async () => {
    const surface = { rootSessionId: 'root', path: ['worker'] };
    await store.open('root', undefined, surface);
    harness.emit({
      type: 'subagent_view_event',
      sessionId: 'root',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc',
      viewCursor: 1,
      event: { type: 'tree_navigation_start', sessionId: 'child', cursor: 1, targetId: 'u1', summarizing: false },
    } as PimoteEvent);
    harness.emit({
      type: 'subagent_view_event',
      sessionId: 'root',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc',
      viewCursor: 2,
      event: { type: 'tree_navigation_end', sessionId: 'child', cursor: 2 },
    } as PimoteEvent);
    expect(store.state.busy).toBe(false);
    harness.emit({
      type: 'subagent_view_snapshot',
      sessionId: 'root',
      childSessionId: 'child',
      path: ['worker'],
      incarnation: 'inc',
      viewCursor: 3,
      state: {} as never,
      messages: [],
    });
    expect(store.state.open).toBe(false);
    await store.open('root', undefined, surface);
    expect(harness.commands.filter((command) => command.type === 'get_tree')).toHaveLength(2);
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
