import type { ProjectInfo } from '../../shared/dist/index.js';
import type { RepoIndex } from './repo-index.js';

/** Curation patch for one project; keyed by project path. */
export interface ProjectUpdatePatch {
  projectPath: string;
  favorite?: boolean;
  order?: number;
  archived?: boolean;
}

/**
 * The persistent user-owned layer over the repo index: multi-repo hub
 * projects, curation overrides (favorite / manual order / archived) keyed by
 * repo path for single-repo projects, hub creation (mkdir + symlinks +
 * generated AGENTS.md), disbanding, and change notifications. Persists as
 * JSON following the session-json-store pattern.
 */
export class ProjectRegistry {
  constructor(
    private readonly repos: RepoIndex,
    private readonly storeDir: string,
  ) {}

  /**
   * The merged project view: every repo from the index as a `single` project
   * (with curation overrides applied) plus persisted hub projects as `multi`.
   */
  async list(): Promise<ProjectInfo[]> {
    void this.repos;
    void this.storeDir;
    throw new Error('not implemented');
  }

  /** Apply a curation patch. Unknown project paths reject. */
  async update(patch: ProjectUpdatePatch): Promise<void> {
    void patch;
    throw new Error('not implemented');
  }

  /**
   * Create a multi-repo hub project: mkdir under `root`, symlink every member
   * repo, and generate the hub AGENTS.md with the sub-project convention.
   * Every repoPath must exist in the repo index; unknown members reject.
   */
  async createHub(name: string, root: string, repoPaths: string[]): Promise<{ path: string }> {
    void name;
    void root;
    void repoPaths;
    throw new Error('not implemented');
  }

  /** Remove a hub project: registry entry removed and the hub folder deleted. */
  async disband(projectPath: string): Promise<void> {
    void projectPath;
    throw new Error('not implemented');
  }

  /** Subscribe to registry mutations; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    void cb;
    throw new Error('not implemented');
  }
}
