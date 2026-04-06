// IndexStore — manages folder and session listing
import type { FolderInfo, SessionInfo, SessionStateChangedEvent, SessionDeletedEvent, SessionRenamedEvent, SessionArchivedEvent } from '@pimote/shared';
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

function sortSessionsByRecency(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => toTimestamp(b.modified) - toTimestamp(a.modified) || toTimestamp(b.created) - toTimestamp(a.created) || a.id.localeCompare(b.id));
}

class IndexStore {
  folders: FolderInfo[] = $state([]);
  sessions = $state(new SvelteMap<string, SessionInfo[]>());
  loading: boolean = $state(false);
  showArchived: boolean = $state(getShowArchived());
  private foldersLoadInFlight: Promise<void> | null = null;
  private sessionLoadsInFlight = new Map<string, InFlightSessionLoad>();
  private nextSessionRequestId = 0;

  async loadFolders(): Promise<void> {
    if (this.foldersLoadInFlight) return this.foldersLoadInFlight;

    this.foldersLoadInFlight = (async () => {
      const isInitialLoad = this.folders.length === 0;
      if (isInitialLoad) this.loading = true;
      try {
        const response = await connection.send({ type: 'list_folders' });
        if (response.success && response.data) {
          const data = response.data as { folders: FolderInfo[] };
          this.folders = data.folders;
          await Promise.all(data.folders.map((folder) => this.loadSessions(folder.path)));
        }
      } catch (e) {
        console.error('[IndexStore] Failed to load folders:', e);
      } finally {
        if (isInitialLoad) this.loading = false;
      }
    })().finally(() => {
      this.foldersLoadInFlight = null;
    });

    return this.foldersLoadInFlight;
  }

  applySessionStateChange(event: SessionStateChangedEvent, myClientId: string): void {
    const folder = this.folders.find((f) => f.path === event.folderPath);
    if (folder) {
      folder.activeSessionCount = event.folderActiveSessionCount;
      folder.activeStatus = event.folderActiveStatus;
    }

    const folderSessions = this.sessions.get(event.folderPath);
    if (folderSessions) {
      const session = folderSessions.find((s) => s.id === event.sessionId);
      if (session) {
        session.liveStatus = event.liveStatus;
        session.isOwnedByMe = event.connectedClientId === myClientId;
      } else if (event.liveStatus !== null) {
        void this.loadSessions(event.folderPath);
      }
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
    const session = folderSessions?.find((s) => s.id === event.sessionId);
    if (session) {
      session.name = event.name;
    }
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
        console.error('[IndexStore] Failed to load sessions:', e);
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

export const indexStore = new IndexStore();
