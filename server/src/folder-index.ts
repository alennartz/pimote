import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { SessionManager, type SessionInfo as PiSessionInfo } from '@mariozechner/pi-coding-agent';
import type { FolderInfo, SessionInfo as PimoteSessionInfo } from '@pimote/shared';

/** Project marker files/directories that identify a folder as a project. */
const PROJECT_MARKERS = ['.git', 'package.json', '.pi'] as const;

/**
 * Scans configured root directories for project folders and lists their sessions.
 */
export class FolderIndex {
  constructor(private readonly roots: string[]) {}

  /**
   * Scan all roots one level deep for project directories.
   * A subdirectory is a "project" if it contains .git, package.json, or .pi/sessions.
   */
  async scan(): Promise<FolderInfo[]> {
    const folders: FolderInfo[] = [];

    for (const root of this.roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        console.warn(`[FolderIndex] Root directory not accessible, skipping: ${root}`);
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(root, entry);

        try {
          const info = await stat(fullPath);
          if (!info.isDirectory()) continue;
        } catch {
          continue;
        }

        const isProject = await this.hasProjectMarker(fullPath);
        if (!isProject) continue;

        folders.push({
          path: fullPath,
          name: basename(fullPath),
          activeSessionCount: 0, // Will be enriched by session pool later
          externalProcessCount: 0,
          activeStatus: null,
        });
      }
    }

    return folders;
  }

  /**
   * List sessions for a given folder path.
   * Calls the pi SDK's SessionManager.list() and maps results to the shared SessionInfo type.
   */
  async listSessions(folderPath: string): Promise<PimoteSessionInfo[]> {
    let piSessions: PiSessionInfo[];
    try {
      piSessions = await SessionManager.list(folderPath);
    } catch (err) {
      console.warn(`[FolderIndex] Failed to list sessions for ${folderPath}:`, err);
      return [];
    }

    return piSessions.map((s) => ({
      id: s.id,
      name: s.name,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || undefined,
    }));
  }

  /**
   * Resolve a session ID to its file path within a folder.
   * Returns undefined if the session is not found.
   */
  async resolveSessionPath(folderPath: string, sessionId: string): Promise<string | undefined> {
    let piSessions: PiSessionInfo[];
    try {
      piSessions = await SessionManager.list(folderPath);
    } catch {
      return undefined;
    }
    const match = piSessions.find((s) => s.id === sessionId);
    return match?.path;
  }

  /**
   * Check if a directory contains any project markers.
   */
  private async hasProjectMarker(dirPath: string): Promise<boolean> {
    for (const marker of PROJECT_MARKERS) {
      try {
        const markerPath = marker === '.pi'
          ? join(dirPath, '.pi', 'sessions')
          : join(dirPath, marker);
        await stat(markerPath);
        return true;
      } catch {
        // Marker doesn't exist, try next
      }
    }
    return false;
  }
}
