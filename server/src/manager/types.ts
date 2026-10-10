import type { FolderInfo, RepoInfo } from '../../../shared/dist/index.js';
import type { PimoteConfig } from '../config.js';
import type { SparseTree } from '../folder-model/index.js';

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

/** Narrow RepoIndex seam for manager tools. */
export interface RepoIndexPort {
  list(): Promise<RepoInfo[]>;
  /** Invalidate the folder-model discovery listing so a background re-walk
   *  picks up on-disk changes. Pair with `notifyFoldersChanged` when clients
   *  must see the change: invalidation alone notifies nobody. */
  invalidateListing(): void;
}

/** Narrow folder-model seam for manager tools: the sparse tree report. */
export interface FolderModelPort {
  tree(): Promise<SparseTree>;
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
 * overrides merged over all included entries, code and persona alike.
 */
export interface FolderRegistryPort {
  list(): Promise<FolderInfo[]>;
  update(patch: FolderUpdatePatch): Promise<void>;
  createHub(input: { name: string; root: string; memberPaths: string[] }): Promise<FolderInfo>;
  disbandHub(folderPath: string): Promise<void>;
}

/**
 * Everything the manager extension's pimote toolset may act through. Tools
 * act only via these ports — never raw fs, never the real server internals.
 * One deliberate exception: `pimote_create_persona` materializes its persona
 * folder on disk (its documented tool contract owns those files), then signals
 * discovery invalidation through `repos.invalidateListing()` and fans the
 * `folders_changed` delta out through `notifyFoldersChanged()`.
 */
export interface ManagerToolContext {
  sessions: SessionManagerPort;
  folders: FolderRegistryPort;
  repos: RepoIndexPort;
  tree: FolderModelPort;
  /** Broadcast a `folders_changed` delta to every connected client — the same
   *  channel the ws-handler `create_folder` flow uses. Paired with
   *  `repos.invalidateListing()` after a creation: the invalidate re-walks
   *  discovery, this broadcast delivers the new rows. */
  notifyFoldersChanged(changedPaths: string[]): void;
  config: PimoteConfig;
}

/** Input for the `pimote_create_persona` tool (plan: manager-lifecycle). */
export interface CreatePersonaInput {
  /** One nonempty basename path segment, excluding `.` and `..`.
   * Invalid names return tool errors. Created at `<parentPath>/<name>`. */
  name: string;
  /** Existing folder the persona folder is created under. Must be inside a
   *  canonical scan root or equal to it. Canonical containment rejects symlink
   *  escapes. Validation failures return tool errors, never throws. */
  parentPath: string;
  /** Persona description; written to the AGENTS.md front matter. */
  description: string;
  /** Optional caller persona prompt, folded into the persona prompt template. */
  prompt?: string;
}

/** One `pimote_list_personas` row (plan: manager-lifecycle). */
export interface PersonaRow {
  name: string;
  description: string;
  /** Canonical identity path of the persona folder. */
  folderPath: string;
  /** Personas run rooted in their folder: the same path as `folderPath`. */
  workingDirectory: string;
}
