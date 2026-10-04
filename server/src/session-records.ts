import { unlink } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionInfo as PimoteSessionInfo } from '../../shared/dist/index.js';
import { SessionSummaryIndex, type SessionSummary } from './session-summaries.js';

/**
 * On-disk session records for project folders.
 *
 * Pure session-record access — listing, resolution, rename, delete — served by
 * the per-file summary cache; no folder discovery lives here. Folder sets come
 * from the caller (config roots, RepoIndex, the folder registry); this holder
 * only answers "which sessions does this folder have on disk".
 */

export interface SessionRecordOptions {
  /** Throw on an I/O error instead of returning a partial result. */
  failOnError?: boolean;
}

export class SessionRecords {
  constructor(private readonly summaries: SessionSummaryIndex = new SessionSummaryIndex()) {}

  /**
   * List raw pi session records for a given folder path.
   *
   * Served by the per-file summary cache: warm calls stat the session files
   * and parse only the ones written since the previous list, instead of
   * re-reading every session file's full history per request.
   */
  async listSessionRecords(folderPath: string, options: SessionRecordOptions = {}): Promise<SessionSummary[]> {
    try {
      return await this.summaries.list(folderPath);
    } catch (err) {
      if (options.failOnError) throw err;
      console.warn(`[SessionRecords] Failed to list sessions for ${folderPath}:`, err);
      return [];
    }
  }

  /**
   * List sessions for a given folder path.
   * Maps cached session records to the shared SessionInfo type.
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
}
