import { type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type { ProjectCreator, ProjectSource } from './types.js';

/** Source/creator modules: regular files with these extensions; everything else is ignored. */
const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

/** Sources and creators collected from one scan of the sources directory. */
export interface LoadedProjectSources {
  sources: ProjectSource[];
  creators: ProjectCreator[];
}

/** Module contract: a module may export `sources` / `creators` arrays. */
interface SourceModule {
  sources?: unknown;
  creators?: unknown;
}

/**
 * Dynamic-import every JS/TS module in `dir` and collect its `sources` and
 * `creators` exports (arrays of ProjectSource / ProjectCreator). Failures are
 * isolated per module: a module that fails to load or evaluate is logged and
 * skipped, and the scan continues. A missing directory yields an empty result.
 */
export async function loadProjectSources(dir: string): Promise<LoadedProjectSources> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sources: [], creators: [] };
    }
    throw err;
  }

  // Mirrors pi's jiti-loader.ts: user modules may be authored in TypeScript.
  const jiti = createJiti(import.meta.url, { moduleCache: false });

  const sources: ProjectSource[] = [];
  const creators: ProjectCreator[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;

    const fileUrl = pathToFileURL(join(dir, entry.name)).href;
    try {
      const mod = (await jiti.import(fileUrl)) as SourceModule;
      if (Array.isArray(mod.sources)) sources.push(...(mod.sources as ProjectSource[]));
      if (Array.isArray(mod.creators)) creators.push(...(mod.creators as ProjectCreator[]));
    } catch (err) {
      console.warn(`[project-sources] skipping module ${entry.name}:`, err);
    }
  }

  return { sources, creators };
}
