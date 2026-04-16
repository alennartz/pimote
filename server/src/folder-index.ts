import { readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { SessionManager, type SessionInfo as PiSessionInfo } from '@mariozechner/pi-coding-agent';
import type { FolderInfo, SessionInfo as PimoteSessionInfo } from '@pimote/shared';

/** Project marker files/directories that identify a folder as a project. */
const PROJECT_MARKERS = ['.git', 'package.json'] as const;

/**
 * Scans configured root directories for project folders and lists their sessions.
 */
export class FolderIndex {
  constructor(private readonly _roots: string[]) {}

  /** Returns the configured root directories. */
  get roots(): string[] {
    return this._roots;
  }

  /**
   * Scan all roots one level deep for project directories.
   * A subdirectory is a "project" if it contains .git or package.json.
   */
  async scan(): Promise<FolderInfo[]> {
    const folders: FolderInfo[] = [];

    for (const root of this._roots) {
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
   * List raw pi session records for a given folder path.
   */
  async listSessionRecords(folderPath: string): Promise<PiSessionInfo[]> {
    try {
      return await SessionManager.list(folderPath);
    } catch (err) {
      console.warn(`[FolderIndex] Failed to list sessions for ${folderPath}:`, err);
      return [];
    }
  }

  /**
   * List sessions for a given folder path.
   * Calls the pi SDK's SessionManager.list() and maps results to the shared SessionInfo type.
   */
  async listSessions(folderPath: string): Promise<PimoteSessionInfo[]> {
    const piSessions = await this.listSessionRecords(folderPath);

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
    const piSessions = await this.listSessionRecords(folderPath);
    const match = piSessions.find((s) => s.id === sessionId);
    return match?.path;
  }

  /**
   * Persist a new display name for a session on disk.
   * Returns true if renamed, false if the session was not found.
   */
  async renameSession(folderPath: string, sessionId: string, name: string): Promise<boolean> {
    const sessionPath = await this.resolveSessionPath(folderPath, sessionId);
    if (!sessionPath) return false;
    SessionManager.open(sessionPath).appendSessionInfo(name);
    return true;
  }

  /**
   * Delete a session file from disk.
   * Returns true if deleted, false if the session was not found.
   */
  async deleteSession(folderPath: string, sessionId: string): Promise<boolean> {
    const sessionPath = await this.resolveSessionPath(folderPath, sessionId);
    if (!sessionPath) return false;
    await unlink(sessionPath);
    return true;
  }

  /**
   * Check if a directory contains any project markers.
   */
  private async hasProjectMarker(dirPath: string): Promise<boolean> {
    for (const marker of PROJECT_MARKERS) {
      try {
        await stat(join(dirPath, marker));
        return true;
      } catch {
        // Marker doesn't exist, try next
      }
    }
    return false;
  }
}
