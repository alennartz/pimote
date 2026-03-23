// IndexStore — manages folder and session listing
import type { FolderInfo, SessionInfo } from '@pimote/shared';
import { connection } from './connection.svelte.js';

class IndexStore {
  folders: FolderInfo[] = $state([]);
  sessions = $state(new Map<string, SessionInfo[]>());
  loading: boolean = $state(false);

  async loadFolders(): Promise<void> {
    this.loading = true;
    try {
      const response = await connection.send({ type: 'list_folders' });
      if (response.success && response.data) {
        const data = response.data as { folders: FolderInfo[] };
        this.folders = data.folders;
      }
    } catch (e) {
      console.error('[IndexStore] Failed to load folders:', e);
    } finally {
      this.loading = false;
    }
  }

  async loadSessions(folderPath: string): Promise<void> {
    try {
      const response = await connection.send({ type: 'list_sessions', folderPath });
      if (response.success && response.data) {
        const data = response.data as { sessions: SessionInfo[] };
        // Create a new Map to trigger reactivity
        const next = new Map(this.sessions);
        next.set(folderPath, data.sessions);
        this.sessions = next;
      }
    } catch (e) {
      console.error('[IndexStore] Failed to load sessions:', e);
    }
  }
}

export const indexStore = new IndexStore();
