import type { ProjectInfo, RepoInfo } from '../../../shared/dist/index.js';
import type { PimoteConfig } from '../config.js';

/** Live snapshot of one open session, as the manager tools see it. */
export interface ManagedSessionSummary {
  sessionId: string;
  folderPath: string;
  status: 'working' | 'idle';
  needsAttention: boolean;
}

/** One on-disk session record for a project folder, as the manager tools see it. */
export interface DiskSessionRecord {
  id: string;
  /** User-defined display name, when the session has one. */
  name?: string;
  /** First user message; empty string when the session has none. */
  firstMessage: string;
  /** ISO 8601 timestamps. */
  created: string;
  modified: string;
  messageCount: number;
  /** True when flagged archived in the session metadata store. */
  archived: boolean;
}

/** Per-session outcome of a manager archive request. */
export interface SessionArchiveOutcome {
  sessionId: string;
  /** - `archived`: on-disk record marked archived.
   *  - `open_slot_evicted`: the session was live; its slot was closed and the
   *    on-disk record marked archived.
   *  - `not_found`: no live slot and no on-disk record in any project. */
  outcome: 'archived' | 'open_slot_evicted' | 'not_found';
}

/**
 * Narrow session-manager seam for manager tools (DI port per DR-039 —
 * structural interfaces only where they serve dependency injection; the real
 * session manager is checked against this seam at the single construction
 * site).
 */
export interface SessionManagerPort {
  /** All currently open sessions across every folder. */
  getAllSessions(): ManagedSessionSummary[];

  /** On-disk session records for one project folder (pi SessionManager.list
   *  for that cwd — open and closed sessions alike). */
  listDiskSessions(folderPath: string): Promise<DiskSessionRecord[]>;

  /** Start a new session in the folder — the same path the open_session WS
   *  command uses. A firstMessage, when given, is sent to the new session
   *  immediately (the agent run continues in the background); resolves to the
   *  new session id. */
  openSession(folderPath: string, firstMessage?: string): Promise<string>;

  /** Archive sessions on disk using the canonical archive flow; a session
   *  that is currently open has its live slot evicted (closed) as part of
   *  archiving. Reports a per-id outcome. */
  archiveSessions(sessionIds: string[]): Promise<SessionArchiveOutcome[]>;
}

/** Narrow ProjectRegistry seam for manager tools. */
export interface ProjectRegistryPort {
  list(): Promise<ProjectInfo[]>;
}

/** Narrow RepoIndex seam for manager tools. */
export interface RepoIndexPort {
  list(): Promise<RepoInfo[]>;
}

/**
 * Everything the manager extension's pimote toolset may act through. Tools
 * act only via these ports — never raw fs, never the real server internals.
 */
export interface ManagerToolContext {
  sessions: SessionManagerPort;
  projects: ProjectRegistryPort;
  repos: RepoIndexPort;
  config: PimoteConfig;
}
