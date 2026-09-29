import type { ProjectCreator, ProjectSource } from './types.js';

/** Sources and creators collected from one scan of the sources directory. */
export interface LoadedProjectSources {
  sources: ProjectSource[];
  creators: ProjectCreator[];
}

/**
 * Dynamic-import every JS/TS module in `dir` and collect its `sources` and
 * `creators` exports (arrays of ProjectSource / ProjectCreator). Failures are
 * isolated per module: a module that fails to load or evaluate is logged and
 * skipped, and the scan continues. A missing directory yields an empty result.
 */
export async function loadProjectSources(dir: string): Promise<LoadedProjectSources> {
  void dir;
  throw new Error('not implemented');
}
