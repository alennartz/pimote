import { readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { SessionManager, type SessionInfo as PiSessionInfo } from '@earendil-works/pi-coding-agent';
import type { FolderInfo, SessionInfo as PimoteSessionInfo } from '../../shared/dist/index.js';

/** Project marker files/directories that identify a folder as a project. */
const PROJECT_MARKERS = ['.git', 'package.json'] as const;

export interface FolderScanOptions {
  /** Throw on an I/O error instead of returning a partial result. */
  failOnError?: boolean;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

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
  async scan(options: FolderScanOptions = {}): Promise<FolderInfo[]> {
    const folders: FolderInfo[] = [];
    const failOnError = options.failOnError === true;

    for (const root of this._roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (error) {
        if (failOnError) throw error;
        console.warn(`[FolderIndex] Root directory not accessible, skipping: ${root}`);
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(root, entry);

        try {
          const info = await stat(fullPath);
          if (!info.isDirectory()) continue;
        } catch (error) {
          if (failOnError) throw error;
          continue;
        }

        const isProject = await this.hasProjectMarker(fullPath, failOnError);
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
  async listSessionRecords(folderPath: string, options: FolderScanOptions = {}): Promise<PiSessionInfo[]> {
    try {
      return await SessionManager.list(folderPath);
    } catch (err) {
      if (options.failOnError) throw err;
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
  private async hasProjectMarker(dirPath: string, failOnError = false): Promise<boolean> {
    for (const marker of PROJECT_MARKERS) {
      try {
        await stat(join(dirPath, marker));
        return true;
      } catch (error) {
        // A missing marker is expected; any other error means that a strict
        // enumeration cannot prove the folder's state safely.
        if (failOnError && !isMissingPathError(error)) throw error;
      }
    }
    return false;
  }
}
