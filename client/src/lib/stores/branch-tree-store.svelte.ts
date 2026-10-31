import type { PimoteCommand, PimoteEvent, PimoteResponse, PimoteTreeNode } from '@pimote/shared';
import type { FindMatch } from '$lib/conversation-find.js';
import { SvelteSet } from 'svelte/reactivity';
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

  constructor(private readonly _transport: BranchTreeTransport) {}

  /** Open a session's tree, fetching it once and reusing the session cache. */
  async open(_sessionId: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Open the explorer and expose the segment containing an entry. */
  async openFocused(_sessionId: string, _entryId: string): Promise<void> {
    throw new Error('not implemented');
  }

  close(): void {
    throw new Error('not implemented');
  }

  toggleSegment(_segmentId: string): void {
    throw new Error('not implemented');
  }

  select(_entryId: string): void {
    throw new Error('not implemented');
  }

  setSearch(_query: string): void {
    throw new Error('not implemented');
  }

  searchAll(_query: string): void {
    throw new Error('not implemented');
  }

  /** Navigate without compaction, or with default/custom summarization. */
  async navigate(_entryId: string, _opts?: { compactionPrompt?: string }): Promise<void> {
    throw new Error('not implemented');
  }

  async setLabel(_entryId: string, _label: string | undefined): Promise<void> {
    throw new Error('not implemented');
  }
}

export const branchTreeStore = new BranchTreeStore({
  send: (command) => connection.send(command),
  onEvent: (listener) => connection.onEvent(listener),
});
