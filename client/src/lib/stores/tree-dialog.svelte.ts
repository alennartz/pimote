import type { PimoteTreeNode } from '@pimote/shared';
import { SvelteSet } from 'svelte/reactivity';

export type TreeFilterMode = 'default' | 'user-only' | 'all' | 'labeled-only';

export interface TreeDialogState {
  open: boolean;
  sessionId: string | null;
  tree: PimoteTreeNode[] | null;
  currentLeafId: string | null;
  loading: boolean;
  filterMode: TreeFilterMode;
  searchQuery: string;
}

/** Check whether a single node passes the filter mode and search query. */
function nodeMatches(node: PimoteTreeNode, mode: TreeFilterMode, query: string): boolean {
  // Mode filter
  switch (mode) {
    case 'user-only':
      if (node.role !== 'user') return false;
      break;
    case 'labeled-only':
      if (!node.label) return false;
      break;
    case 'default': {
      // Match the pi TUI: default mode hides settings/bookkeeping entries
      // (labels, custom entries, model/thinking-level changes, session
      // info) and keeps everything else — including assistant messages.
      const settingsTypes = new Set(['label', 'custom', 'model_change', 'thinking_level_change', 'session_info']);
      if (settingsTypes.has(node.type)) return false;
      break;
    }
    case 'all':
      break;
  }

  // Search query filter
  if (query) {
    const haystack = (node.preview + ' ' + (node.label ?? '')).toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  return true;
}

export class TreeDialogStore {
  state: TreeDialogState = $state({
    open: false,
    sessionId: null,
    tree: null,
    currentLeafId: null,
    loading: false,
    filterMode: 'default',
    searchQuery: '',
  });

  selectedNodeId: string | null = $state(null);
  expandedNodeIds: SvelteSet<string> = $state(new SvelteSet());

  openDialog(sessionId: string, tree: PimoteTreeNode[], currentLeafId: string | null): void {
    this.state.open = true;
    this.state.sessionId = sessionId;
    this.state.tree = tree;
    this.state.currentLeafId = currentLeafId;
    this.state.loading = false;
    this.state.filterMode = 'default';
    this.state.searchQuery = '';
    this.selectedNodeId = currentLeafId;
    this.expandedNodeIds = new SvelteSet();
  }

  closeDialog(): void {
    this.state.open = false;
    this.state.sessionId = null;
    this.state.tree = null;
    this.state.currentLeafId = null;
    this.state.loading = false;
    this.selectedNodeId = null;
    this.expandedNodeIds = new SvelteSet();
  }

  setLoading(loading: boolean): void {
    this.state.loading = loading;
  }

  setSelectedNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
  }

  toggleExpanded(nodeId: string): void {
    const next = new SvelteSet(this.expandedNodeIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    this.expandedNodeIds = next;
  }

  setFilterMode(mode: TreeFilterMode): void {
    this.state.filterMode = mode;
    this.expandedNodeIds = new SvelteSet();
  }

  setSearchQuery(query: string): void {
    this.state.searchQuery = query;
    this.expandedNodeIds = new SvelteSet();
  }

  setNodeLabel(entryId: string, label: string | undefined): void {
    if (!this.state.tree) return;
    const update = (nodes: PimoteTreeNode[]): PimoteTreeNode[] =>
      nodes.map((node) => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral Date, not stored reactively
        const updated = node.id === entryId ? { ...node, label, labelTimestamp: new Date().toISOString() } : node;
        return updated.children.length > 0 ? { ...updated, children: update(updated.children) } : updated;
      });
    this.state.tree = update(this.state.tree);
  }

  getFilteredTree(): PimoteTreeNode[] {
    const tree = this.state.tree;
    if (!tree) return [];

    const mode = this.state.filterMode;
    const query = this.state.searchQuery.toLowerCase().trim();

    // 'all' with no search query — return the full tree
    if (mode === 'all' && !query) return tree;

    // Recursive filter: keep a node if it matches or any descendant matches.
    // This preserves tree structure (ancestors of matching nodes are kept).
    const filterNodes = (nodes: PimoteTreeNode[]): PimoteTreeNode[] => {
      const result: PimoteTreeNode[] = [];
      for (const node of nodes) {
        const filteredChildren = filterNodes(node.children);
        const selfMatches = nodeMatches(node, mode, query);
        if (selfMatches || filteredChildren.length > 0) {
          result.push(filteredChildren.length !== node.children.length ? { ...node, children: filteredChildren } : node);
        }
      }
      return result;
    };

    return filterNodes(tree);
  }
}

export const treeDialogStore = new TreeDialogStore();
