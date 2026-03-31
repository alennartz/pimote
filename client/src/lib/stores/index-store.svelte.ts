// IndexStore — manages folder and session listing
import type { FolderInfo, SessionInfo, SessionStateChangedEvent } from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { SvelteMap } from 'svelte/reactivity';

class IndexStore {
  folders: FolderInfo[] = $state([]);
  sessions = $state(new SvelteMap<string, SessionInfo[]>());
  loading: boolean = $state(false);
  private foldersLoadInFlight: Promise<void> | null = null;

  async loadFolders(): Promise<void> {
    if (this.foldersLoadInFlight) return this.foldersLoadInFlight;

    this.foldersLoadInFlight = (async () => {
      // Only show loading spinner on initial load when we have no data yet
      const isInitialLoad = this.folders.length === 0;
      if (isInitialLoad) this.loading = true;
      try {
        const response = await connection.send({ type: 'list_folders' });
        if (response.success && response.data) {
          const data = response.data as { folders: FolderInfo[] };
          this.folders = data.folders;
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
    // Update folder in-place (Svelte 5 reactivity tracks property mutations)
    const folder = this.folders.find((f) => f.path === event.folderPath);
    if (folder) {
      folder.activeSessionCount = event.folderActiveSessionCount;
      folder.activeStatus = event.folderActiveStatus;
    }

    // Update session in-place if loaded (folder may not be expanded)
    const folderSessions = this.sessions.get(event.folderPath);
    if (folderSessions) {
      const session = folderSessions.find((s) => s.id === event.sessionId);
      if (session) {
        session.liveStatus = event.liveStatus;
        session.isOwnedByMe = event.connectedClientId === myClientId;
      } else if (event.liveStatus !== null) {
        // Unknown active session (e.g. created by newSession/fork/switchSession) — reload the list
        this.loadSessions(event.folderPath);
      }
    }
  }

  async loadSessions(folderPath: string): Promise<void> {
    try {
      const response = await connection.send({ type: 'list_sessions', folderPath });
      if (response.success && response.data) {
        const data = response.data as { sessions: SessionInfo[] };
        this.sessions.set(folderPath, data.sessions);
      }
    } catch (e) {
      console.error('[IndexStore] Failed to load sessions:', e);
    }
  }
}

export const indexStore = new IndexStore();
