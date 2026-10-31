import type { GetTreeResponseData, PimoteCommand, PimoteEvent, PimoteResponse, PimoteTreeNode } from '@pimote/shared';
import type { FindMatch } from '$lib/conversation-find.js';
import { buildBranchMap, segmentsToExpose } from '$lib/branch-tree.js';
import { updateTreeNodeLabel } from '$lib/tree-dialog-utils.js';
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { connection } from './connection.svelte.js';

export interface BranchTreeTransport {
  send(command: PimoteCommand): Promise<PimoteResponse>;
  onEvent(listener: (event: PimoteEvent) => void): () => void;
}

export type BranchSearchScope = 'anchors' | 'all';

export interface BranchTreeState {
  open: boolean;
  sessionId: string | null;
  tree: PimoteTreeNode[];
  currentLeafId: string | null;
  busy: boolean;
  expandedSegmentIds: ReadonlySet<string>;
  selectedId: string | null;
  searchQuery: string;
  searchScope: BranchSearchScope;
  searchMatches: FindMatch[];
  focusedEntryId: string | null;
  error: string | null;
}

interface NavigationState {
  inProgress: boolean;
  summarizing: boolean;
  closeOnResync: boolean;
}

const navigationResult = (data: unknown): { cancelled: boolean; editorText?: string } => {
  if (!data || typeof data !== 'object') return { cancelled: false };
  const value = data as { cancelled?: unknown; editorText?: unknown };
  return {
    cancelled: value.cancelled === true,
    ...(typeof value.editorText === 'string' ? { editorText: value.editorText } : {}),
  };
};

function cloneTree(tree: readonly PimoteTreeNode[]): PimoteTreeNode[] {
  const clones = new SvelteMap<PimoteTreeNode, PimoteTreeNode>();
  const pending = [...tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (clones.has(node)) continue;
    clones.set(node, { ...node, children: [] });
    pending.push(...node.children);
  }

  for (const [node, clone] of clones) {
    clone.children = node.children.map((child) => clones.get(child)!);
  }
  return tree.map((node) => clones.get(node)!);
}

function cloneSnapshot(snapshot: GetTreeResponseData): GetTreeResponseData {
  return { tree: cloneTree(snapshot.tree), currentLeafId: snapshot.currentLeafId };
}

function isConversationNode(node: PimoteTreeNode): boolean {
  return node.type === 'message' && (node.role === 'user' || node.role === 'assistant');
}

function conversationNodes(tree: readonly PimoteTreeNode[]): PimoteTreeNode[] {
  const nodes: PimoteTreeNode[] = [];
  const pending = [...tree].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isConversationNode(node)) nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]);
  }
  return nodes;
}

function findMatches(nodes: readonly PimoteTreeNode[], query: string): FindMatch[] {
  if (query.length === 0) return [];
  const normalized = query.toLowerCase();
  const matches: FindMatch[] = [];

  for (const node of nodes) {
    const text = node.conversationText ?? '';
    const normalizedText = text.toLowerCase();
    let offset = normalizedText.indexOf(normalized);
    while (offset !== -1) {
      matches.push({ messageKey: node.id, blockIndex: 0, offset, length: query.length });
      offset = normalizedText.indexOf(normalized, offset + Math.max(query.length, 1));
    }

    const label = node.label ?? '';
    const normalizedLabel = label.toLowerCase();
    offset = normalizedLabel.indexOf(normalized);
    while (offset !== -1) {
      // Labels are message-level hits. They do not identify a conversation block.
      matches.push({ messageKey: node.id, blockIndex: -1, offset, length: query.length });
      offset = normalizedLabel.indexOf(normalized, offset + Math.max(query.length, 1));
    }
  }

  return matches;
}

/** Coordinates the branch explorer's cached tree snapshot and navigation. */
export class BranchTreeStore {
  state: BranchTreeState = $state({
    open: false,
    sessionId: null,
    tree: [],
    currentLeafId: null,
    busy: false,
    expandedSegmentIds: new SvelteSet<string>(),
    selectedId: null,
    searchQuery: '',
    searchScope: 'anchors',
    searchMatches: [],
    focusedEntryId: null,
    error: null,
  });

  // The cache is deliberately private. Store operations replace snapshots and trees
  // rather than mutating values shared with transport callers.
  private readonly cache = new SvelteMap<string, GetTreeResponseData>();
  private readonly navigationBySession = new SvelteMap<string, NavigationState>();
  private readonly unsubscribeTransport: () => void;

  constructor(private readonly _transport: BranchTreeTransport) {
    this.unsubscribeTransport = _transport.onEvent((event) => this.receiveEvent(event));
  }

  /** Read a session snapshot without opening the explorer. */
  async load(sessionId: string): Promise<GetTreeResponseData | null> {
    const cached = this.cache.get(sessionId);
    if (cached) {
      this.state.error = null;
      return cloneSnapshot(cached);
    }

    try {
      const response = await this._transport.send({ type: 'get_tree', sessionId });
      if (!response.success || !response.data) {
        this.state.error = response.error ?? 'Unable to load the branch tree.';
        return null;
      }
      const data = response.data as GetTreeResponseData;
      if (!Array.isArray(data.tree) || (data.currentLeafId !== null && typeof data.currentLeafId !== 'string')) {
        this.state.error = 'Unable to load the branch tree.';
        return null;
      }
      const snapshot = cloneSnapshot(data);
      this.cache.set(sessionId, snapshot);
      this.state.error = null;
      return cloneSnapshot(snapshot);
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Unable to load the branch tree.';
      return null;
    }
  }

  /** Open a tree, using a supplied snapshot or the per-session cache. */
  async open(sessionId: string, suppliedSnapshot?: GetTreeResponseData): Promise<void> {
    this.resetForOpen(sessionId);
    if (suppliedSnapshot) this.cache.set(sessionId, cloneSnapshot(suppliedSnapshot));

    const snapshot = suppliedSnapshot ? cloneSnapshot(suppliedSnapshot) : await this.load(sessionId);
    if (!snapshot) return;
    this.publishSnapshot(sessionId, snapshot);
  }

  /** Open the explorer and expose the segment containing an entry. */
  async openFocused(sessionId: string, entryId: string, suppliedSnapshot?: GetTreeResponseData): Promise<void> {
    await this.open(sessionId, suppliedSnapshot);
    if (!this.state.open || this.state.sessionId !== sessionId || this.state.error) return;

    this.state.focusedEntryId = entryId;
    this.state.selectedId = entryId;
    this.state.expandedSegmentIds = new SvelteSet(segmentsToExpose(this.state.tree, entryId));
  }

  close(): void {
    this.state.open = false;
    this.state.sessionId = null;
    this.state.tree = [];
    this.state.currentLeafId = null;
    this.state.busy = false;
    this.state.expandedSegmentIds = new SvelteSet();
    this.state.selectedId = null;
    this.state.searchQuery = '';
    this.state.searchScope = 'anchors';
    this.state.searchMatches = [];
    this.state.focusedEntryId = null;
    this.state.error = null;
  }

  toggleSegment(segmentId: string): void {
    const next = new SvelteSet(this.state.expandedSegmentIds);
    if (next.has(segmentId)) next.delete(segmentId);
    else next.add(segmentId);
    this.state.expandedSegmentIds = next;
    if (this.state.searchScope === 'anchors' && this.state.searchQuery.length > 0) {
      this.state.searchMatches = this.anchorMatches(this.state.searchQuery);
    }
  }

  select(entryId: string): void {
    this.state.selectedId = entryId;
  }

  /** Search visible anchors by conversation text and label. */
  setSearch(query: string): void {
    this.state.searchQuery = query;
    this.state.searchScope = 'anchors';
    this.state.searchMatches = this.anchorMatches(query);
  }

  /** Search all conversation text and labels; expose and select matching entries. */
  searchAll(query: string): void {
    this.state.searchQuery = query;
    this.state.searchScope = 'all';
    const matches = findMatches(conversationNodes(this.state.tree), query);
    this.state.searchMatches = matches;

    const matchingIds = [...new SvelteSet(matches.map((match) => match.messageKey))];
    const expanded = new SvelteSet(this.state.expandedSegmentIds);
    for (const entryId of matchingIds) {
      for (const segmentId of segmentsToExpose(this.state.tree, entryId)) expanded.add(segmentId);
    }
    this.state.expandedSegmentIds = expanded;
    this.state.selectedId = matchingIds[0] ?? null;
  }

  /** Navigate with optional compaction. Failures set error and leave the explorer open. */
  async navigate(entryId: string, opts?: { compactionPrompt?: string }): Promise<{ cancelled: boolean; editorText?: string } | null> {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      this.state.error = 'No session is open.';
      return null;
    }
    return this.navigateInSession(sessionId, entryId, opts);
  }

  /** Navigate a session without opening or changing the explorer selection. */
  async navigateInSession(sessionId: string, entryId: string, opts?: { compactionPrompt?: string }): Promise<{ cancelled: boolean; editorText?: string } | null> {
    const command: PimoteCommand = {
      type: 'navigate_tree',
      sessionId,
      targetId: entryId,
      ...(opts ? { summarize: true } : {}),
      ...(opts?.compactionPrompt ? { customInstructions: opts.compactionPrompt, replaceInstructions: false } : {}),
    };

    this.state.busy = true;
    this.state.error = null;
    try {
      const response = await this._transport.send(command);
      if (!response.success || !response.data) {
        this.state.error = response.error ?? 'Navigation failed.';
        this.clearNavigationFailure(sessionId);
        return null;
      }
      const result = navigationResult(response.data);
      if (result.cancelled) this.clearNavigationFailure(sessionId);
      else if (!this.navigationBySession.get(sessionId)?.inProgress && this.state.sessionId === sessionId) this.state.busy = false;
      return result;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Navigation failed.';
      this.clearNavigationFailure(sessionId);
      return null;
    }
  }

  async setLabel(entryId: string, label: string | undefined): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      this.state.error = 'No session is open.';
      return;
    }

    const normalizedLabel = label === '' ? undefined : label;
    try {
      const response = await this._transport.send({
        type: 'set_tree_label',
        sessionId,
        entryId,
        ...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
      });
      if (!response.success) {
        this.state.error = response.error ?? 'Unable to set the branch label.';
        return;
      }

      const labelTimestamp = new SvelteDate().toISOString();
      const cached = this.cache.get(sessionId);
      const baseTree = cached?.tree ?? this.state.tree;
      const nextTree = updateTreeNodeLabel(baseTree, entryId, normalizedLabel, labelTimestamp);
      const snapshot = {
        tree: nextTree,
        currentLeafId: cached ? cached.currentLeafId : this.state.currentLeafId,
      };
      this.cache.set(sessionId, snapshot);
      if (this.state.sessionId === sessionId) {
        this.state.tree = cloneTree(nextTree);
        if (this.state.searchQuery.length > 0) {
          this.state.searchMatches =
            this.state.searchScope === 'all' ? findMatches(conversationNodes(this.state.tree), this.state.searchQuery) : this.anchorMatches(this.state.searchQuery);
        }
      }
      this.state.error = null;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Unable to set the branch label.';
    }
  }

  private resetForOpen(sessionId: string): void {
    this.state.open = true;
    this.state.sessionId = sessionId;
    this.state.tree = [];
    this.state.currentLeafId = null;
    this.state.busy = false;
    this.state.expandedSegmentIds = new SvelteSet();
    this.state.selectedId = null;
    this.state.searchQuery = '';
    this.state.searchScope = 'anchors';
    this.state.searchMatches = [];
    this.state.focusedEntryId = null;
    this.state.error = null;
  }

  private publishSnapshot(sessionId: string, snapshot: GetTreeResponseData): void {
    this.state.tree = cloneTree(snapshot.tree);
    this.state.currentLeafId = snapshot.currentLeafId;
    this.state.selectedId = snapshot.currentLeafId;
    this.state.error = null;
  }

  private anchorMatches(query: string): FindMatch[] {
    if (query.length === 0) return [];
    const rows = buildBranchMap(this.state.tree, this.state.currentLeafId, this.state.expandedSegmentIds);
    const visibleIds = new SvelteSet(rows.filter((row) => row.kind === 'message').map((row) => row.id));
    return findMatches(
      conversationNodes(this.state.tree).filter((node) => visibleIds.has(node.id)),
      query,
    );
  }

  private clearNavigationFailure(sessionId: string): void {
    this.navigationBySession.delete(sessionId);
    if (this.state.sessionId === sessionId) this.state.busy = false;
  }

  private receiveEvent(event: PimoteEvent): void {
    if (!('sessionId' in event) || typeof event.sessionId !== 'string') return;
    const sessionId = event.sessionId;

    if (event.type === 'tree_navigation_start') {
      this.navigationBySession.set(sessionId, {
        inProgress: true,
        summarizing: event.summarizing,
        closeOnResync: false,
      });
      if (this.state.sessionId === sessionId) this.state.busy = true;
      return;
    }

    if (event.type === 'tree_navigation_end') {
      this.navigationBySession.set(sessionId, {
        inProgress: false,
        summarizing: false,
        closeOnResync: true,
      });
      if (this.state.sessionId === sessionId) this.state.busy = false;
      // Preserve the state even when the start event was not observed. The next
      // full resync still closes the explorer for this session.
      return;
    }

    if (event.type !== 'full_resync') return;

    this.cache.delete(sessionId);
    const navigation = this.navigationBySession.get(sessionId);
    if (!navigation) return;

    if (navigation.closeOnResync) {
      this.navigationBySession.delete(sessionId);
      if (this.state.sessionId === sessionId) this.close();
    } else if (this.state.sessionId === sessionId && navigation.inProgress && navigation.summarizing) {
      this.state.busy = true;
    }
  }
}

export const branchTreeStore = new BranchTreeStore({
  send: (command) => connection.send(command),
  onEvent: (listener) => connection.onEvent(listener),
});
