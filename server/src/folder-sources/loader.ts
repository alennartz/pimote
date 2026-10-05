import { type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type { FolderCreator, FolderSource } from '@pimote/sdk/folders';
import { LEGACY_PIMOTE_PROJECT_SOURCES_DIR, PIMOTE_FOLDER_SOURCES_DIR } from '../paths.js';

/** Source/creator modules: regular files with these extensions; everything else is ignored. */
const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

/** Sources and creators collected from one scan of the sources directory. */
export interface LoadedFolderSources {
  sources: FolderSource[];
  creators: FolderCreator[];
}

/** Module contract: a module may export `sources` / `creators` arrays. */
interface SourceModule {
  sources?: unknown;
  creators?: unknown;
}

/** Sources-directory pair the effective directory is resolved from; injectable for tests. */
export interface SourcesDirs {
  /** The current default sources directory. */
  preferred: string;
  /** The deprecated legacy sources directory, read-compat only. */
  legacy: string;
}

/**
 * Effective sources directory: an explicit configured directory wins unchanged;
 * otherwise `preferred`, falling back to `legacy` when `preferred` is absent —
 * deprecated read-compat so previously installed sources keep loading (will be retired).
 */
export async function resolveSourcesDir(
  configured: string | undefined,
  dirs: SourcesDirs = { preferred: PIMOTE_FOLDER_SOURCES_DIR, legacy: LEGACY_PIMOTE_PROJECT_SOURCES_DIR },
): Promise<string> {
  if (configured) return configured;
  try {
    await stat(dirs.preferred);
  } catch {
    return dirs.legacy; // deprecated legacy `project-sources` dir read-compat so installed sources keep loading (will be retired)
  }
  return dirs.preferred;
}

/**
 * Dynamic-import every JS/TS module in `dir` and collect its `sources` and
 * `creators` exports (arrays of FolderSource / FolderCreator). Failures are
 * isolated per module: a module that fails to load or evaluate is logged and
 * skipped, and the scan continues. A missing directory yields an empty result.
 */
export async function loadFolderSources(dir: string): Promise<LoadedFolderSources> {
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

  const sources: FolderSource[] = [];
  const creators: FolderCreator[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;

    const fileUrl = pathToFileURL(join(dir, entry.name)).href;
    try {
      const mod = (await jiti.import(fileUrl)) as SourceModule;
      if (Array.isArray(mod.sources)) sources.push(...(mod.sources as FolderSource[]));
      if (Array.isArray(mod.creators)) creators.push(...(mod.creators as FolderCreator[]));
    } catch (err) {
      console.warn(`[folder-sources] skipping module ${entry.name}:`, err);
    }
  }

  return { sources, creators };
}
