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

  setNodeLabel(_entryId: string, _label: string | undefined): void {
    throw new Error('setNodeLabel not implemented');
  }

  getFilteredTree(): PimoteTreeNode[] {
    throw new Error('getFilteredTree not implemented');
  }
}

export const treeDialogStore = new TreeDialogStore();
