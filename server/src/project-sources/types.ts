import type { RepoInfo } from '../../../shared/dist/index.js';

/** Human-readable parameter type for a creator form field. */
export type ProjectCreatorParamType = 'string' | 'string[]';

/**
 * Extensible discovery seam: a source contributes repos to the repo index.
 * Built in: the filesystem walker over configured roots. User-authored
 * sources are dynamic-imported from the configured project-sources directory.
 */
export interface ProjectSource {
  readonly id: string;
  /** Discover repos; called on cache miss. Must not mutate anything. */
  list(): Promise<RepoInfo[]>;
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
