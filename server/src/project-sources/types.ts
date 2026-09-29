import type { RepoInfo } from '../../../shared/dist/index.js';

/** Human-readable parameter type for a creator form field. */
export type ProjectCreatorParamType = 'string' | 'string[]';

/** A repo entry contributed to the discovery index (feeds single-repo projects). */
export interface RepoSourceEntry extends RepoInfo {
  kind: 'repo';
}

/**
 * A multi-repo project entry contributed to the project layer. `memberPaths`
 * are concrete paths that may not exist on disk yet; the server derives
 * existence state itself — sources never flag "virtual".
 */
export interface MultiRepoSourceEntry {
  kind: 'project';
  path: string;
  name: string;
  memberPaths: string[];
}

/** Anything a source lists: a repo, or a multi-repo project over member paths. */
export type SourceEntry = RepoSourceEntry | MultiRepoSourceEntry;

/**
 * Extensible discovery seam: a source contributes repos and multi-repo
 * projects to the project layer. Built in: the filesystem walker over
 * configured roots. User-authored sources are dynamic-imported from the
 * configured project-sources directory.
 */
export interface ProjectSource {
  readonly id: string;
  /** Discover entries; called on cache miss. Must not mutate anything. */
  list(): Promise<SourceEntry[]>;
  /**
   * Awaited before any open of a listed entry proceeds — whether the target
   * exists on disk or not, and from every open path (row click, new session,
   * manager tool). Sources self-filter by path: probe the disk and scaffold
   * if the entry is theirs and missing; do other open-time work otherwise.
   * A thrown error aborts the open and surfaces the message to the user.
   */
  onProjectOpen?(projectPath: string): Promise<void>;
}

/** Human-readable description of a creator's form, for the creation UI. */
export interface ProjectCreatorDescriptor {
  label: string;
  paramSchema: Record<string, ProjectCreatorParamType>;
}

/**
 * Extensible creation seam: a creator makes a new project directory from
 * user-supplied params. Built in: mkdir + git init. User-authored creators
 * are dynamic-imported from the configured project-sources directory.
 */
export interface ProjectCreator {
  readonly id: string;
  /** Human-readable description for the creation UI. */
  describe(): ProjectCreatorDescriptor;
  create(params: Record<string, unknown>): Promise<{ path: string }>;
}
