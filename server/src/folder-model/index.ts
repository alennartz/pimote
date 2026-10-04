import type { Dirent, Stats } from 'node:fs';

/**
 * Folder model — the deep module that owns folder discovery.
 *
 * Marker-aware nature classification, sparse-tree scanning (descent through
 * skipped folders, stop at included ones, shortcut recursion), canonical-path
 * identity with visit-once semantics. Depends on node `fs`/`path` only — no
 * protocol types, no server internals. Everything lives behind one function.
 */

/** A folder of interest is exactly one of these two natures. */
export type FolderNature = 'code' | 'persona';

/** Agent-definition front matter captured from a persona folder's AGENTS.md. */
export interface PersonaInfo {
  name: string;
  description?: string;
}

/** A folder of interest — identity plus classification. Discovered once per canonical path. */
export interface FolderEntry {
  /** Canonical (real) path — the entry's identity. */
  path: string;
  /** Always the folder's basename. Never the persona name. */
  name: string;
  nature: FolderNature;
  /** Present iff nature === 'persona'. */
  persona?: PersonaInfo;
}

/** One way the sparse tree reaches an entry. */
export interface FolderOccurrence {
  /** Reach path: walked path for scans; symlink-based path for shortcuts.
   * Skipped segments remain inline, including followed symlinks. Not necessarily
   * canonical. Reused children retain their first-discovery reach paths. */
  path: string;
  via: 'scan' | 'shortcut';
  entry: FolderEntry;
  /** First-discovery shortcuts; in-progress cycle back-references are leaves. */
  children: FolderOccurrence[];
}

/** The sparse tree: top-level scan occurrences, each carrying its shortcut occurrences. */
export interface SparseTree {
  occurrences: FolderOccurrence[];
}

/** The only fs operations the scanner performs; injectable for tests. */
export interface FolderFs {
  readdir(path: string): Promise<Dirent[]>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  /** UTF-8 file contents — needed for AGENTS.md marker inspection. */
  readFile(path: string): Promise<string>;
}

export interface FolderScanWarning {
  path: string;
  operation: 'readdir' | 'lstat' | 'realpath' | 'readFile';
  error: unknown;
}

export interface ScanFolderModelOptions {
  roots: string[];
  fs?: FolderFs;
  /** Local fs failures report here; defaults to console.warn. */
  onWarning?: (warning: FolderScanWarning) => void;
}

/**
 * Discover the sparse folder tree from the scan roots.
 *
 * Pure and on-demand: the only computation is classification and reach.
 */
export async function scanFolderModel(_options: ScanFolderModelOptions): Promise<SparseTree> {
  throw new Error('not implemented');
}
