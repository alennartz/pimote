import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { GetGlobalSettingsResponseData, GlobalSettingsFile } from '../../shared/dist/index.js';

export interface GlobalSettingsCatalogOptions {
  home: string;
  agentDir: string;
  configPath: string;
  settingsFiles?: readonly string[];
  /** Paths already resolved by the Pimote extension host. */
  extensionFiles?: readonly string[];
}

interface ManifestEntry {
  path: string;
  canonical?: string;
}

/**
 * Builds the server-owned list of files shown by the global settings editor.
 * The catalog only resolves identities. Callers use the file-edit seam for
 * contents.
 */
export class GlobalSettingsCatalog {
  private readonly home: string;
  private readonly agentDir: string;
  private readonly configPath: string;
  private readonly settingsFiles: readonly string[];
  private readonly extensionFiles: readonly string[];

  constructor(options: GlobalSettingsCatalogOptions) {
    this.home = options.home;
    this.agentDir = options.agentDir;
    this.configPath = options.configPath;
    this.settingsFiles = [...(options.settingsFiles ?? [])];
    this.extensionFiles = [...(options.extensionFiles ?? [])];
  }

  async snapshot(): Promise<GetGlobalSettingsResponseData> {
    const paths = this.declaredPaths();
    const entries: ManifestEntry[] = [];
    const knownCanonicalPaths = new Set<string>();

    for (const path of paths) {
      const canonical = await canonicalExistingPath(path);
      if (canonical !== undefined) {
        if (knownCanonicalPaths.has(canonical)) continue;
        knownCanonicalPaths.add(canonical);
      }
      entries.push({ path, canonical });
    }

    const labels = makeLabels(entries.map(({ path }) => path));
    const files: GlobalSettingsFile[] = entries.map(({ path }, index) => ({
      path,
      label: labels[index]!,
    }));
    return { files };
  }

  private declaredPaths(): string[] {
    const builtIns = [join(this.agentDir, 'AGENTS.md'), join(this.agentDir, 'settings.json'), this.configPath];
    const configured = this.settingsFiles.map((path) => resolveConfiguredPath(path, this.configPath, this.home));
    return [...builtIns, ...configured, ...this.extensionFiles];
  }
}

/** Resolve a config-listed path without consulting the process working directory. */
function resolveConfiguredPath(path: string, configPath: string, home: string): string {
  if (path === '~') return resolve(home);
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  if (isAbsolute(path)) return normalize(path);
  return resolve(dirname(configPath), path);
}

/** Return the canonical identity for an existing target, or undefined when missing. */
async function canonicalExistingPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Produce labels from the shortest useful path suffix. Parent segments are
 * added only for labels that collide, while declaration order remains intact.
 */
function makeLabels(paths: readonly string[]): string[] {
  const segments = paths.map(pathSegments);
  const depths = segments.map(() => 1);

  while (true) {
    const labels = segments.map((parts, index) => labelAtDepth(parts, depths[index]!));
    const collisions = new Map<string, number[]>();
    labels.forEach((label, index) => {
      const indexes = collisions.get(label);
      if (indexes) indexes.push(index);
      else collisions.set(label, [index]);
    });

    let expanded = false;
    for (const indexes of collisions.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        if (depths[index]! < segments[index]!.length) {
          depths[index]! += 1;
          expanded = true;
        }
      }
    }
    if (!expanded) return labels;
  }
}

function pathSegments(path: string): string[] {
  const normalized = normalize(path);
  // `split` on the platform separator keeps labels readable and avoids ever
  // exposing the process-relative part of a configured path.
  const parts = normalized.split(sep).filter(Boolean);
  return parts.length > 0 ? parts : [normalized];
}

function labelAtDepth(parts: readonly string[], depth: number): string {
  return parts.slice(Math.max(0, parts.length - depth)).join('/');
}
