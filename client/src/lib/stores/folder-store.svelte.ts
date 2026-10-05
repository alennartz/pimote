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

interface InFlightSessionLoad {
  includeArchived: boolean;
  requestId: number;
  promise: Promise<void>;
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
  folders: FolderInfo[] = $state([]);
  repos: RepoInfo[] = $state([]);
  roots: string[] = $state([]);
  sessions = $state(new SvelteMap<string, SessionInfo[]>());
  loading: boolean = $state(false);
  showArchived: boolean = $state(getShowArchived());
  /** True once a full load has completed against the current connection. Server
   *  broadcasts (routed at module scope below) keep the data fresh in the
   *  meantime, so dashboard remounts need no refetch; any drop invalidates it. */
  private loadedForCurrentConnection = false;
  private foldersLoadInFlight: Promise<void> | null = null;
  private reposLoadInFlight: Promise<void> | null = null;
  private sessionLoadsInFlight: Map<string, InFlightSessionLoad> = new Map(); // eslint-disable-line svelte/prefer-svelte-reactivity -- in-flight request registry, not reactive UI state
  private nextSessionRequestId = 0;

  /**
   * Folders with the archived filter applied, favorites first. Within each
   * tier, most recent session activity (old-sidebar behavior), name as
   * tiebreak. Folders with no sessions sink to the bottom of their tier.
   */
  get visibleFolders(): FolderInfo[] {
    const list = this.showArchived ? this.folders : this.folders.filter((f) => !f.archived);
    const recency = (folder: FolderInfo): number => Math.max(0, ...(this.sessions.get(folder.path) ?? []).map((s) => toTimestamp(s.modified)));
    return [...list].sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true) || recency(b) - recency(a) || a.name.localeCompare(b.name));
  }

  /**
   * Full load once per connection. Navigating back to the dashboard serves the
   * warm cache — server events keep it current while the user is elsewhere —
   * and a reconnect (disconnect invalidation) refetches against the fresh
   * connection. `loadFolders()` bypasses this for explicit refreshes.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loadedForCurrentConnection) return;
    await this.loadFolders();
  }

  /** Drop the per-connection freshness marker; wired to socket loss below. */
  invalidateConnection(): void {
    this.loadedForCurrentConnection = false;
  }

  async loadFolders(): Promise<void> {
    if (this.foldersLoadInFlight) return this.foldersLoadInFlight;

    this.foldersLoadInFlight = (async () => {
      const isInitialLoad = this.folders.length === 0;
      if (isInitialLoad) this.loading = true;
      try {
        const response = await connection.send({ type: 'list_folders' });
        if (response.success && response.data) {
          const data = response.data as ListFoldersResponseData;
          this.folders = data.folders;
          this.roots = data.roots ?? [];
          this.loadedForCurrentConnection = true;
          // First paint needs only this response. Session metadata refines sort
          // order and chips as it lands — holding the spinner until every
          // per-folder list_sessions returns made the dashboard wait on the
          // slowest folder's session history.
          if (isInitialLoad) this.loading = false;
          // Repo listing feeds branch chips and missing-detection; refresh it
          // with the folders so they never disagree.
          void this.loadRepos();
          await Promise.all(data.folders.map((folder) => this.loadSessions(folder.path)));
        }
      } catch (e) {
        console.error('[FolderStore] Failed to load folders:', e);
      } finally {
        if (isInitialLoad) this.loading = false;
      }
    })().finally(() => {
      this.foldersLoadInFlight = null;
    });

    return this.foldersLoadInFlight;
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

  /** Whole-list replacement driven by the server's folders_changed broadcast. */
  applyFoldersChanged(event: FoldersChangedEvent): void {
    this.folders = event.folders;
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
    const folderSessions = this.sessions.get(event.folderPath);
    if (folderSessions) {
      const filtered = folderSessions.filter((s) => s.id !== event.sessionId);
      this.sessions.set(event.folderPath, filtered);
    }
  }

  applySessionRenamed(event: SessionRenamedEvent): void {
    const folderSessions = this.sessions.get(event.folderPath);
    if (!folderSessions) return;
    this.sessions.set(
      event.folderPath,
      folderSessions.map((s) => (s.id === event.sessionId ? { ...s, name: event.name } : s)),
    );
  }

  applySessionArchived(event: SessionArchivedEvent): void {
    if (this.sessions.has(event.folderPath)) {
      void this.loadSessions(event.folderPath);
    }
  }

  setShowArchived(show: boolean): void {
    this.showArchived = show;
    setShowArchived(show);
    void Promise.all(this.folders.map((folder) => this.loadSessions(folder.path)));
  }

  async loadSessions(folderPath: string): Promise<void> {
    const existing = this.sessionLoadsInFlight.get(folderPath);
    if (existing && existing.includeArchived === this.showArchived) {
      return existing.promise;
    }

    const includeArchived = this.showArchived;
    const requestId = ++this.nextSessionRequestId;

    const promise = (async () => {
      try {
        const response = await connection.send({ type: 'list_sessions', folderPath, includeArchived });
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId !== requestId) return;

        if (response.success && response.data) {
          const data = response.data as { sessions: SessionInfo[] };
          this.sessions.set(folderPath, sortSessionsByRecency(data.sessions));
        }
      } catch (e) {
        console.error('[FolderStore] Failed to load sessions:', e);
      } finally {
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId === requestId) {
          this.sessionLoadsInFlight.delete(folderPath);
        }
      }
    })();

    this.sessionLoadsInFlight.set(folderPath, { includeArchived, requestId, promise });
    return promise;
  }
}

export const folderStore = new FolderStore();

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
