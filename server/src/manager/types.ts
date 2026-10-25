import type { FolderInfo } from '../../../shared/dist/index.js';
import type { PimoteConfig } from '../config.js';

/** Live snapshot of one open session, as the manager tools see it. */
export interface ManagedSessionSummary {
  sessionId: string;
  folderPath: string;
  status: 'working' | 'idle';
  needsAttention: boolean;
}

/** One on-disk session record for a folder, as the manager tools see it. */
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
   *  - `not_found`: no live slot and no on-disk record in any folder. */
  outcome: 'archived' | 'open_slot_evicted' | 'not_found';
}

/** Outcome of explicitly resuming one existing session by id. */
export interface SessionResumeOutcome {
  sessionId: string;
  /** The session's effective folder path, when the session exists. */
  folderPath?: string;
  /** - `resumed`: the original record is now open (and was unarchived when needed).
   *  - `already_open`: the original session was already live and unarchived.
   *  - `not_found`: no live slot and no on-disk record in any known folder. */
  outcome: 'resumed' | 'already_open' | 'not_found';
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

  /** On-disk session records for one folder (pi SessionManager.list
   *  for that cwd — open and closed sessions alike). The optional signal is
   *  the caller's interruption hook: an aborted read rejects promptly while
   *  any shared cache fill completes for the next reader (DR-072). */
  listDiskSessions(folderPath: string, signal?: AbortSignal): Promise<DiskSessionRecord[]>;

  /** Start a new session in the folder — the same path the open_session WS
   *  command uses. A firstMessage, when given, is sent to the new session
   *  immediately (the agent run continues in the background); resolves to the
   *  new session id. */
  openSession(folderPath: string, firstMessage?: string): Promise<string>;

  /** Archive sessions on disk using the canonical archive flow; a session
   *  that is currently open has its live slot evicted (closed) as part of
   *  archiving. Reports a per-id outcome. */
  archiveSessions(sessionIds: string[]): Promise<SessionArchiveOutcome[]>;

  /** Explicitly resume one existing session by id. An archived record's
   *  original file is opened first, then its archive flag is cleared. This
   *  never creates a new session and returns the original id. */
  resumeSession(sessionId: string): Promise<SessionResumeOutcome>;
}

/** Narrow RepoIndex seam for manager tools: freshness only. Git facts reach
 *  the toolset through FolderInfo rows (`repo`, hub `repos`) - no tool reads
 *  the repo view directly (DR-062). */
export interface RepoIndexPort {
  /** Invalidate the folder-model discovery listing so a background re-walk
   *  picks up on-disk changes. Pair with `notifyFoldersChanged` when clients
   *  must see the change: invalidation alone notifies nobody. */
  invalidateListing(): void;
}

/** Curation patch for one folder entry; keyed by canonical entry path. */
export interface FolderUpdatePatch {
  folderPath: string;
  favorite?: boolean;
  archived?: boolean;
  addTags?: string[];
  removeTags?: string[];
}

/**
 * Folder-registry seam for manager tools (narrow DI port per DR-039):
 * curation over all included entries, code and persona alike, plus hub
 * materialization and membership mutations. Structural mutations invalidate
 * discovery before broadcasting; curation emits its delta through `onChange`.
 */
export interface FolderRegistryPort {
  /** The optional signal is the caller's interruption hook: the caller
   *  races the listing (cold-walk discovery included) and rejects on abort
   *  while shared work completes for the next reader (DR-072). */
  list(signal?: AbortSignal): Promise<FolderInfo[]>;
  /** Identity rows and warm status only. This path never waits on git probes. */
  listLazy?(signal?: AbortSignal): Promise<FolderInfo[]>;
  /** Deliver requested git facts later through the folder delta channel. */
  requestStatusRefresh?(rows: ReadonlyArray<FolderInfo>): Promise<void>;
  update(patch: FolderUpdatePatch): Promise<void>;
  createHub(input: { name: string; root: string; memberPaths: string[]; body?: string; description?: string; personaText?: string }): Promise<{ path: string }>;
  addMember(hubPath: string, memberPath: string): Promise<void>;
  removeMember(hubPath: string, memberPath: string): Promise<void>;
}

/** Input for the creators seam (`pimote_create_folder`, kind `code`). */
export interface CodeFolderCreateInput {
  /** Existing folder the code folder is created under (validated by the
   * caller against the scan roots before the seam is invoked). */
  root: string;
  name: string;
  /** Seeded AGENTS.md body; the stub is written even when empty. */
  body?: string;
}

/**
 * Narrow creators seam for manager tools: one code-folder creation routed
 * through the registered FolderCreator (the built-in creator, or a
 * user-authored one taking its slot) plus the AGENTS.md seed — the same
 * routing the ws-handler `create_folder` command uses.
 */
export interface FolderCreatorsPort {
  create(input: CodeFolderCreateInput): Promise<{ folderPath: string }>;
}

/**
 * Everything the manager extension's pimote toolset may act through. Tools
 * act only via these ports — never raw fs, never the real server internals.
 * One deliberate exception: `pimote_create_folder` (kinds `code` and
 * `persona`) materializes its folder on disk (its documented tool contract
 * owns those files), then signals discovery invalidation through
 * `repos.invalidateListing()` and fans the `folders_changed` delta out
 * through `notifyFoldersChanged()`.
 */
export interface ManagerToolContext {
  sessions: SessionManagerPort;
  folders: FolderRegistryPort;
  repos: RepoIndexPort;
  creators: FolderCreatorsPort;
  /** Broadcast a `folders_changed` delta to every connected client — the same
   *  channel the ws-handler `create_folder` flow uses. Paired with
   *  `repos.invalidateListing()` after a creation that bypasses the registry
   *  (code folders, plain personas): registry-routed mutations broadcast
   *  through the registry's own onChange channel. */
  notifyFoldersChanged(changedPaths: string[]): void;
  config: PimoteConfig;
}

/** Folder kinds `pimote_create_folder` creates (DR-062): the four wizard
 *  shapes in one parameterized tool. */
export type CreateFolderKind = 'code' | 'persona' | 'code-hub' | 'persona-hub';
