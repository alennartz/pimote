// FolderStore — manages folder, repo, and session listing
import type {
  ListFoldersResponseData,
  ListReposResponseData,
  FolderInfo,
  FoldersChangedEvent,
  PimoteEvent,
  RepoInfo,
  SessionInfo,
  SessionStateChangedEvent,
  SessionDeletedEvent,
  SessionRenamedEvent,
  SessionArchivedEvent,
} from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { getShowArchived, setShowArchived } from './persistence.js';
import { sessionRegistry } from './session-registry.svelte.js';

interface OpenSessionActivity {
  readonly folderPath: string;
  readonly modified: string | null;
}

interface InFlightSessionLoad {
  includeArchived: boolean;
  requestId: number;
  promise: Promise<void>;
}

interface FolderWindowContext {
  readonly generation: number;
  readonly offset: number;
  readonly query: string;
  readonly includeArchived: boolean;
  readonly orderToken?: string;
  readonly repin: boolean;
}

function mergeFolderRows(current: readonly FolderInfo[], changed: readonly FolderInfo[], removedPaths: readonly string[] = []): FolderInfo[] {
  const removed = new Set(removedPaths);
  // Local projection only. The store owns the resulting reactive cache.
  const rows = new Map(current.filter((row) => !removed.has(row.path)).map((row) => [row.path, row])); // eslint-disable-line svelte/prefer-svelte-reactivity -- local pure projection, not reactive state
  for (const row of changed) {
    if (!removed.has(row.path)) rows.set(row.path, row);
  }
  return [...rows.values()];
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sortSessionsByRecency(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => toTimestamp(b.modified) - toTimestamp(a.modified) || toTimestamp(b.created) - toTimestamp(a.created) || a.id.localeCompare(b.id));
}

export class FolderStore {
  constructor(private readonly readOpenSessionActivity: () => readonly OpenSessionActivity[] = () => []) {}

  folders: FolderInfo[] = $state([]);
  repos: RepoInfo[] = $state([]);
  roots: string[] = $state([]);
  sessions = $state(new SvelteMap<string, SessionInfo[]>());
  loading: boolean = $state(false);
  showArchived: boolean = $state(getShowArchived());
  /** Server match count, independent of the accumulating cache size. */
  total: number = $state(0);
  more: boolean = $state(false);
  private loadedForCurrentConnection = false;
  private orderToken: string | undefined;
  private nextOffset = 0;
  /** Paths served in the current window scan — the fetched prefix the next
   *  offset continues into. */
  private fetchedPrefix = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- pagination bookkeeping, not reactive UI state
  private activeQuery: string = $state('');
  private queryMatchPaths: string[] = $state([]);
  private querySessionMatches = new SvelteMap<string, string[] | undefined>();
  private requestGeneration = 0;
  private folderWindowInFlight: { context: FolderWindowContext; promise: Promise<void> } | null = null;
  /** A window the epoch guard discarded: re-issued once the in-flight slot
   *  frees, so a delta that raced the response cannot stall the view. A
   *  sustained delta storm must not turn recovery into an unbounded request
   *  loop, so consecutive retries are capped and reset on every accepted
   *  window. */
  private staleWindowRetry: FolderWindowContext | null = null;
  private staleRetryBudget = 5;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchWaiters: Array<() => void> = [];
  private reposLoadInFlight: Promise<void> | null = null;
  private sessionLoadsInFlight: Map<string, InFlightSessionLoad> = new Map(); // eslint-disable-line svelte/prefer-svelte-reactivity -- in-flight request registry, not reactive UI state
  private nextSessionRequestId = 0;
  /** Newest wire epoch seen. Older response computations cannot overwrite deltas. */
  private foldersEpoch = 0;
  /** Per-folder count of structural session changes (deletes, archive-filter
   *  transitions). A listing taken before the bump is superseded by events and
   *  must be discarded and refetched, never applied. */
  private sessionStructuralEpoch: Map<string, number> = new Map(); // eslint-disable-line svelte/prefer-svelte-reactivity -- staleness bookkeeping, not reactive UI state
  /** Per-folder ids whose local entries were mutated by session_state_changed /
   *  session_renamed while a listing was in flight. A fresh listing must merge
   *  these event updates in instead of replacing them wholesale. */
  private touchedSessions: Map<string, Set<string>> = new Map(); // eslint-disable-line svelte/prefer-svelte-reactivity -- staleness bookkeeping, not reactive UI state

  /**
   * Folders with the archived filter applied, favorites first. Within each
   * tier, most recent activity — live sessions first, then the row's carried
   * `lastActivity` (the ordering fact the pinned order sorts on), then loaded
   * session lists — name as tiebreak. Mirrors the server's pinned order from
   * row data alone, so rows rank correctly before lazy session lists load.
   */
  get visibleFolders(): FolderInfo[] {
    const list = this.folders.filter((folder) => (this.showArchived || !folder.archived) && (!this.activeQuery || this.queryMatchPaths.includes(folder.path)));
    const openActivity = this.readOpenSessionActivity();
    const recency = (folder: FolderInfo): number => {
      if (folder.activeSessionCount > 0) return Number.MAX_SAFE_INTEGER;
      return Math.max(
        0,
        ...(this.sessions.get(folder.path) ?? []).map((session) => toTimestamp(session.modified)),
        ...openActivity.filter((session) => session.folderPath === folder.path).map((session) => (session.modified ? toTimestamp(session.modified) : Number.MAX_SAFE_INTEGER)),
        folder.lastActivity ?? 0,
      );
    };
    return [...list].sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true) || recency(b) - recency(a) || a.name.localeCompare(b.name));
  }

  /** Active server query, for views that remount with a cleared toolbar. */
  get query(): string {
    return this.activeQuery;
  }

  /** Fetch one initial window per connection, then serve the warm cache. */
  async ensureLoaded(): Promise<void> {
    if (this.loadedForCurrentConnection) return;
    await this.fetchFolderWindow(0);
  }

  /** Continue the filtered pin. Offset tracks response rows, not unique cache rows. */
  async fetchNextWindow(): Promise<void> {
    if (this.searchTimer !== null) return;
    if (!this.loadedForCurrentConnection) return this.ensureLoaded();
    if (!this.more) return;
    await this.fetchFolderWindow(this.nextOffset);
  }

  /**
   * The view nears the fetched frontier — the display position where the next
   * window's rows insert — so the scan must continue. The display tail is not
   * the trigger: rows merged from search or deltas can sit below unfetched
   * territory, and continuation rows land at their sorted positions, which can
   * lie behind the view. Triggering at the frontier keeps merged rows ahead of
   * a scrolling view, so no row silently skips between two frames.
   */
  shouldFetchNextWindow(lastVisibleIndex: number): boolean {
    return this.more && lastVisibleIndex >= this.frontierIndex - 10;
  }

  /** Display rows belonging to the fetched prefix — where unfetched rows insert. */
  private get frontierIndex(): number {
    let count = 0;
    for (const row of this.folders) {
      if ((this.showArchived || !row.archived) && (!this.activeQuery || this.queryMatchPaths.includes(row.path)) && this.fetchedPrefix.has(row.path)) count++;
    }
    return count;
  }

  /** Coalesce callers into one server query without discarding accumulated rows. */
  search(query: string): Promise<void> {
    this.activeQuery = query.trim();
    this.requestGeneration++;
    this.queryMatchPaths = [];
    this.querySessionMatches.clear();
    this.nextOffset = 0;
    this.fetchedPrefix.clear();
    this.more = false;
    this.staleRetryBudget = 5;
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    const promise = new Promise<void>((resolve) => this.searchWaiters.push(resolve));
    const generation = this.requestGeneration;
    this.searchTimer = setTimeout(() => void this.fetchSearchWindow(generation), 250);
    return promise;
  }

  private async fetchSearchWindow(generation: number): Promise<void> {
    this.searchTimer = null;
    const waiters = this.searchWaiters;
    this.searchWaiters = [];
    try {
      if (generation === this.requestGeneration) await this.fetchFolderWindow(0);
    } finally {
      for (const resolve of waiters) resolve();
    }
  }

  /** Folder-tier matches are unrestricted. Session-tier matches use server ids. */
  visibleSessions(folderPath: string): SessionInfo[] {
    const sessions = this.sessions.get(folderPath) ?? [];
    const ids = this.activeQuery ? this.querySessionMatches.get(folderPath) : undefined;
    return ids ? sessions.filter((session) => ids.includes(session.id)) : sessions;
  }

  /** Retain useful rows, but never adopt a response from the closed connection. */
  invalidateConnection(): void {
    this.loadedForCurrentConnection = false;
    this.requestGeneration++;
    this.orderToken = undefined;
    this.nextOffset = 0;
    this.fetchedPrefix.clear();
    this.more = false;
    this.foldersEpoch = 0;
    this.folderWindowInFlight = null;
    this.staleWindowRetry = null;
    this.loading = false;
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    for (const resolve of this.searchWaiters) resolve();
    this.searchWaiters = [];
  }

  /** Only an explicit refresh replaces an established connection pin. */
  async loadFolders(): Promise<void> {
    const existing = this.folderWindowInFlight;
    if (existing?.context.generation === this.requestGeneration && existing.context.offset === 0 && (existing.context.repin || !this.loadedForCurrentConnection)) {
      return existing.promise;
    }
    this.requestGeneration++;
    await this.fetchFolderWindow(0, this.loadedForCurrentConnection);
  }

  private fetchFolderWindow(offset: number, repin = false): Promise<void> {
    const existing = this.folderWindowInFlight;
    if (existing?.context.generation === this.requestGeneration) return existing.promise;
    const context: FolderWindowContext = {
      generation: this.requestGeneration,
      offset,
      query: this.activeQuery,
      includeArchived: this.showArchived,
      orderToken: this.orderToken,
      repin,
    };
    if (this.folders.length === 0) this.loading = true;
    const promise = this.requestFolderWindow(context).finally(() => {
      if (this.folderWindowInFlight?.context === context) {
        this.folderWindowInFlight = null;
        this.loading = false;
        if (this.staleWindowRetry === context) {
          // Re-issue the discarded window right after the slot frees: its
          // rows were out-aged by a delta, but the view must not stall on
          // them. The scan position is re-read at retry time — a delta that
          // restarted the scan in the meantime is honored. The generation
          // guard drops the retry once newer requests (a new query, a
          // refresh, a reconnect) supersede it.
          this.staleWindowRetry = null;
          const generation = context.generation;
          queueMicrotask(() => {
            if (generation !== this.requestGeneration) return;
            // Offset-0 windows (archive toggle, refresh, search) retry at
            // their own offset — the replace/merge and filter semantics hang
            // on it. Continuation windows follow the current scan position:
            // a delta may have restarted the scan since the request went out.
            this.fetchFolderWindow(context.offset === 0 ? 0 : this.nextOffset, context.repin);
          });
        }
      }
    });
    this.folderWindowInFlight = { context, promise };
    return promise;
  }

  private async requestFolderWindow(context: FolderWindowContext): Promise<void> {
    try {
      const response = await connection.send({
        type: 'list_folders',
        offset: context.offset,
        query: context.query,
        includeArchived: context.includeArchived,
        ...(context.orderToken ? { orderToken: context.orderToken } : {}),
        ...(context.repin ? { repin: true } : {}),
      });
      if (context.generation !== this.requestGeneration || !response.success || !response.data) return;
      const data = response.data as ListFoldersResponseData;
      if (data.epoch < this.foldersEpoch) {
        // The delta that out-aged this response moved rows; discard its data
        // and re-request the same window for a current computation.
        if (this.staleRetryBudget > 0) {
          this.staleRetryBudget -= 1;
          this.staleWindowRetry = context;
        }
        return;
      }
      this.staleRetryBudget = 5;
      this.applyFolderWindow(context, data);
    } catch (error) {
      console.error('[FolderStore] Failed to load folders:', error);
    }
  }

  /** One mutation point adopts accepted window data and continuation state. */
  private applyFolderWindow(context: FolderWindowContext, data: ListFoldersResponseData): void {
    // A transparent re-pin serves this window under a different order than
    // the one its offset counts into. Restart the scan at 0 under the adopted
    // token: path-keyed merging makes re-sent rows duplicate-safe and no row
    // can be skipped. (Named follow-up if refetch churn shows up: offset
    // correction instead of restart.)
    const orderReplaced = context.offset > 0 && context.orderToken !== undefined && data.orderToken !== context.orderToken;
    // A continuation window reporting a smaller match count than the previous
    // response observes a filtered-order shrink the delta channel never
    // reported (a session edit dropping a session-tier match). The window may
    // already have skipped a shifted row; restarting at 0 refetches it.
    // Accepted residual: a shrink and a growth netting zero between two
    // windows stay masked — the keyset/offset-correction follow-up kills this
    // bug class for good.
    const orderShrunk = context.offset > 0 && data.total < this.total;
    const restart = orderReplaced || orderShrunk;
    // An explicit refresh or a fresh connection load is authoritative for the
    // unfiltered view: replace the cache so rows deleted while deltas were
    // lost cannot survive a manual refresh or a reconnect. Continuation
    // windows, query windows, and filter toggles of an established cache keep
    // merging into the accumulated rows.
    if (context.offset === 0 && !context.query && (context.repin || !this.loadedForCurrentConnection)) {
      this.folders = [...data.folders];
    } else {
      this.folders = mergeFolderRows(this.folders, data.folders);
    }
    this.roots = data.roots ?? [];
    connection.managerRoot = data.managerRoot || null;
    this.orderToken = data.orderToken;
    this.nextOffset = restart ? 0 : context.offset + data.folders.length;
    this.total = data.total;
    this.more = restart ? true : data.more;
    if (context.offset === 0 || restart) this.fetchedPrefix.clear();
    for (const row of data.folders) this.fetchedPrefix.add(row.path);
    this.loadedForCurrentConnection = true;
    if (context.offset === 0) {
      this.queryMatchPaths = [];
      this.querySessionMatches.clear();
    }
    if (context.query) {
      this.queryMatchPaths = [...new Set([...this.queryMatchPaths, ...data.folders.map((row) => row.path)])]; // eslint-disable-line svelte/prefer-svelte-reactivity -- local deduplication, result stored as reactive array
      for (const row of data.folders) this.querySessionMatches.set(row.path, row.matchedSessionIds);
    }
  }

  /** Single-flight: branch chips and missing-detection read this listing. */
  loadRepos(): Promise<void> {
    this.reposLoadInFlight ??= (async () => {
      try {
        const response = await connection.send({ type: 'list_repos' });
        if (response.success && response.data) {
          this.repos = (response.data as ListReposResponseData).repos;
        }
      } catch (e) {
        console.error('[FolderStore] Failed to load repos:', e);
      } finally {
        this.reposLoadInFlight = null;
      }
    })();
    return this.reposLoadInFlight;
  }

  /** Delta application driven by the server's folders_changed broadcast:
   *  merge `changed` rows by canonical path (rows sorting past the fetched
   *  frontier sit in cache and appear when scrolled to) and drop
   *  `removedPaths` from the cache. Bumps the staleness guard so any list
   *  response taken before this event is discarded. */
  applyFoldersChanged(event: FoldersChangedEvent): void {
    if (event.epoch < this.foldersEpoch) return;
    this.foldersEpoch = event.epoch;
    // A delta that shrinks the filtered order inside the fetched prefix moves
    // rows up across the scan frontier — continuing the offsets would skip
    // them, so restart the scan at 0 (merging keeps the re-send duplicate-safe).
    // Removals at or past the frontier skip nothing; additions arrive at the
    // pin tail. Under an active query any touched fetched row may have left
    // the match set. A completed scan has nothing left to skip.
    const shrank =
      event.removedPaths.some((path) => this.fetchedPrefix.has(path)) ||
      event.changed.some((row) => this.fetchedPrefix.has(row.path) && ((row.archived && !this.showArchived) || this.activeQuery !== ''));
    if (shrank) this.restartScan();
    this.folders = mergeFolderRows(this.folders, event.changed, event.removedPaths);
    this.queryMatchPaths = this.queryMatchPaths.filter((path) => !event.removedPaths.includes(path));
    for (const path of event.removedPaths) this.querySessionMatches.delete(path);
  }

  applySessionStateChange(event: SessionStateChangedEvent, myClientId: string): void {
    const folder = this.folders.find((f) => f.path === event.folderPath);
    if (folder) {
      folder.activeSessionCount = event.folderActiveSessionCount;
    }

    const isOwnedByMe = event.connectedClientId === myClientId;
    const folderSessions = this.sessions.get(event.folderPath);
    if (folderSessions) {
      const idx = folderSessions.findIndex((s) => s.id === event.sessionId);
      if (idx >= 0) {
        this.touchSession(event.folderPath, event.sessionId);
        // Update in place — merge event metadata with existing entry
        this.sessions.set(
          event.folderPath,
          folderSessions.map((s, i) =>
            i === idx
              ? {
                  ...s,
                  liveStatus: event.liveStatus,
                  isOwnedByMe,
                  name: event.sessionName ?? s.name,
                  firstMessage: event.firstMessage ?? s.firstMessage,
                  messageCount: event.messageCount ?? s.messageCount,
                }
              : s,
          ),
        );
      } else if (event.liveStatus !== null) {
        // New active session — add directly from event data
        this.touchSession(event.folderPath, event.sessionId);
        const now = nowIso();
        const updated = [
          ...folderSessions,
          {
            id: event.sessionId,
            name: event.sessionName ?? '',
            firstMessage: event.firstMessage,
            messageCount: event.messageCount ?? 0,
            created: now,
            modified: now,
            archived: false,
            isOwnedByMe,
            liveStatus: event.liveStatus,
          },
        ];
        this.sessions.set(event.folderPath, sortSessionsByRecency(updated));
      }
    } else if (event.liveStatus !== null) {
      // Sessions for this folder not loaded yet — seed with this entry
      this.touchSession(event.folderPath, event.sessionId);
      const now = nowIso();
      this.sessions.set(event.folderPath, [
        {
          id: event.sessionId,
          name: event.sessionName ?? '',
          firstMessage: event.firstMessage,
          messageCount: event.messageCount ?? 0,
          created: now,
          modified: now,
          archived: false,
          isOwnedByMe,
          liveStatus: event.liveStatus,
        },
      ]);
    }
  }

  applySessionDeleted(event: SessionDeletedEvent): void {
    this.bumpStructuralEpoch(event.folderPath);
    this.restartScanOnMatchLoss(event.folderPath, event.sessionId);
    const folderSessions = this.sessions.get(event.folderPath);
    if (folderSessions) {
      const filtered = folderSessions.filter((s) => s.id !== event.sessionId);
      this.sessions.set(event.folderPath, filtered);
    }
  }

  applySessionRenamed(event: SessionRenamedEvent): void {
    // Before the loaded-list guard: a matched session can drive its row's
    // search membership without its session list ever being loaded.
    this.restartScanOnMatchLoss(event.folderPath, event.sessionId);
    const folderSessions = this.sessions.get(event.folderPath);
    if (!folderSessions || !folderSessions.some((s) => s.id === event.sessionId)) return;
    this.touchSession(event.folderPath, event.sessionId);
    this.sessions.set(
      event.folderPath,
      folderSessions.map((s) => (s.id === event.sessionId ? { ...s, name: event.name } : s)),
    );
  }

  applySessionArchived(event: SessionArchivedEvent): void {
    this.bumpStructuralEpoch(event.folderPath);
    if (this.sessions.has(event.folderPath)) {
      // Any same-filter request already in flight predates the archive-filter
      // transition; its structural epoch is stale, so its result gets discarded
      // and a fresh request follows (single-flight reuse alone would serve the
      // pre-archive listing here).
      void this.loadSessions(event.folderPath);
    }
  }

  /** A delete/rename can strip the query text that made this session a
   *  session-tier match, taking its row out of the server's filtered order —
   *  without any folders_changed delta. Conservative: a rename restarts even
   *  when the new text still matches (duplicate-safe), and only sole matched
   *  sessions of fetched rows trigger — unrelated session churn never refetches
   *  scans. Accepted residual: a match leaving and another entering between
   *  two windows net to an unchanged total — the keyset/offset-correction
   *  follow-up kills that class for good. */
  private restartScanOnMatchLoss(folderPath: string, sessionId: string): void {
    if (!this.activeQuery || !this.fetchedPrefix.has(folderPath)) return;
    const matched = this.querySessionMatches.get(folderPath);
    // Folder-tier matches are unrestricted; only a sole session-tier match
    // can take its row out of the filtered order.
    if (!matched || matched.length !== 1 || matched[0] !== sessionId) return;
    this.restartScan();
  }

  /** Restart the window scan at 0 when a shrink moved rows across the scan
   *  frontier mid-scan. Merging keeps the re-send duplicate-safe; a completed
   *  scan has nothing left to skip. */
  private restartScan(): void {
    if (!this.more) return;
    this.nextOffset = 0;
    this.fetchedPrefix.clear();
  }

  /** Record an event-mutated session id so an in-flight listing merges it in. */
  private touchSession(folderPath: string, sessionId: string): void {
    let touched = this.touchedSessions.get(folderPath);
    if (!touched) {
      touched = new Set(); // eslint-disable-line svelte/prefer-svelte-reactivity -- staleness bookkeeping, not reactive UI state
      this.touchedSessions.set(folderPath, touched);
    }
    touched.add(sessionId);
  }

  private bumpStructuralEpoch(folderPath: string): void {
    this.sessionStructuralEpoch.set(folderPath, (this.sessionStructuralEpoch.get(folderPath) ?? 0) + 1);
  }

  /** Apply a listing response, reconciling event updates seen while it was in
   *  flight: event-touched entries win over their listing rows (and survive
   *  their absence from the listing while still live). With nothing touched
   *  this is a plain replace + sort. */
  private applySessionListing(folderPath: string, listing: SessionInfo[]): void {
    const touched = this.touchedSessions.get(folderPath);
    let rows = listing;
    if (touched && touched.size > 0) {
      const local = this.sessions.get(folderPath) ?? [];
      rows = listing.map((row) => {
        const localEntry = touched.has(row.id) ? local.find((s) => s.id === row.id) : undefined;
        return localEntry ? { ...row, ...localEntry } : row;
      });
      for (const id of touched) {
        if (rows.some((r) => r.id === id)) continue;
        const localEntry = local.find((s) => s.id === id);
        // Mirrors the reducer's add rule: only live entries get reinstated.
        if (localEntry && localEntry.liveStatus !== null) rows = [...rows, localEntry];
      }
    }
    this.sessions.set(folderPath, sortSessionsByRecency(rows));
    this.touchedSessions.delete(folderPath);
  }

  setShowArchived(show: boolean): void {
    this.showArchived = show;
    setShowArchived(show);
    void Promise.all([...this.sessions.keys()].map((path) => this.loadSessions(path)));
    this.requestGeneration++;
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      const generation = this.requestGeneration;
      this.searchTimer = setTimeout(() => void this.fetchSearchWindow(generation), 250);
    } else if (this.orderToken) {
      void this.fetchFolderWindow(0);
    }
  }

  async loadSessions(folderPath: string): Promise<void> {
    const existing = this.sessionLoadsInFlight.get(folderPath);
    if (existing && existing.includeArchived === this.showArchived) {
      return existing.promise;
    }

    const includeArchived = this.showArchived;
    const requestId = ++this.nextSessionRequestId;
    const structuralEpoch = this.sessionStructuralEpoch.get(folderPath) ?? 0;
    let stale = false;

    const promise = (async () => {
      try {
        const response = await connection.send({ type: 'list_sessions', folderPath, includeArchived });
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId !== requestId) return;
        // A delete or archive-filter transition landed while we were waiting;
        // the listing is superseded by events. Discard and refetch — but only
        // after the in-flight entry is cleared below.
        if ((this.sessionStructuralEpoch.get(folderPath) ?? 0) !== structuralEpoch) {
          stale = true;
          return;
        }

        if (response.success && response.data) {
          const data = response.data as { sessions: SessionInfo[] };
          this.applySessionListing(folderPath, data.sessions);
        }
      } catch (e) {
        console.error('[FolderStore] Failed to load sessions:', e);
      } finally {
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId === requestId) {
          this.sessionLoadsInFlight.delete(folderPath);
        }
        if (stale) void this.loadSessions(folderPath);
      }
    })();

    this.sessionLoadsInFlight.set(folderPath, { includeArchived, requestId, promise });
    return promise;
  }
}

export const folderStore = new FolderStore(() => sessionRegistry.activeSessions.map((session) => ({ folderPath: session.folderPath, modified: session.lastBotActivityTimestamp })));

// Route server-side folder/session events into the store for the lifetime of
// the app. This lives here — not in FolderList's onMount — so the cache stays
// current while the user is inside a session and returning to the dashboard
// needs no refetch.
connection.onEvent((event: PimoteEvent) => {
  if (event.type === 'folders_changed') {
    folderStore.applyFoldersChanged(event);
  } else if (event.type === 'session_state_changed') {
    folderStore.applySessionStateChange(event, connection.clientId);
  } else if (event.type === 'session_deleted') {
    folderStore.applySessionDeleted(event);
  } else if (event.type === 'session_renamed') {
    folderStore.applySessionRenamed(event);
  } else if (event.type === 'session_archived') {
    folderStore.applySessionArchived(event);
  }
});

// Losing the socket ends the connection whose data we loaded; the next
// ensureLoaded() refetches against the fresh connection.
connection.onDisconnect(() => {
  folderStore.invalidateConnection();
});
