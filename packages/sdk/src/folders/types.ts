/**
 * Repo facts as contributed by sources. Twin of the wire `RepoInfo` in
 * shared/src/protocol.ts — drift-guarded by server/src/sdk-twins.ts.
 */
export interface RepoInfo {
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
  /** Commits ahead of upstream; 0 when unknown. */
  ahead: number;
  behind: number;
  /** Present for worktree hub members: the nested checkout inside the hub
   *  whose git facts these are. The canonical `path` stays the source repo. */
  worktreePath?: string;
  /** Epoch ms of last session activity in this repo, when known. */
  lastActivity?: number;
  /** True when the repo path no longer exists on disk (deleted member, broken symlink). */
  missing?: boolean;
  /** Effective tags (user + source-contributed). Absent when untagged. */
  tags?: Array<string>;
}

/** A repo entry contributed to the discovery index (feeds single-repo folders). */
export interface RepoSourceEntry extends RepoInfo {
  kind: 'repo';
}

/**
 * A hub folder entry contributed to the folder layer. `memberPaths`
 * are concrete paths that may not exist on disk yet; the server derives
 * existence state itself — sources never flag "virtual".
 */
export interface HubSourceEntry {
  kind: 'hub';
  path: string;
  name: string;
  memberPaths: Array<string>;
  /** Source-contributed tags; shown to the user but not user-removable. */
  tags?: Array<string>;
}

/** Anything a source lists: a repo, or a hub folder over member paths. */
export type SourceEntry = RepoSourceEntry | HubSourceEntry;

/**
 * Extensible discovery seam: a source contributes repos and hub
 * folders to the folder layer. Built in: the filesystem walker over
 * configured roots. User-authored sources are registered by the global
 * Pimote extension host.
 */
export interface FolderSource {
  readonly id: string;
  /** Discover entries; called on cache miss. Must not mutate anything. */
  list(): Promise<Array<SourceEntry>>;
  /**
   * Awaited before any open of a listed entry proceeds — whether the target
   * exists on disk or not, and from every open path (row click, new session,
   * manager tool). Sources self-filter by path: probe the disk and scaffold
   * if the entry is theirs and missing; do other open-time work otherwise.
   * A thrown error aborts the open and surfaces the message to the user.
   */
  onFolderOpen?(folderPath: string): Promise<void>;
}
