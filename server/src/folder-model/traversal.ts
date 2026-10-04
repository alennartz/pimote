import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type { FolderEntry, FolderFs, FolderOccurrence, FolderScanWarning, SparseTree } from './index.js';
import { classifyListing, type FolderClassification } from './classification.js';

/** Basenames never entered while descending below a root. */
const PRUNED_BASENAMES: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv']);

interface EntryState {
  entry: FolderEntry;
  /** First-discovery shortcut occurrences, shared by every occurrence of this entry. */
  children: FolderOccurrence[];
  done: boolean;
}

/** Per-scan mutable state — created fresh by every scan, never shared across scans. */
export interface ScanContext {
  fs: FolderFs;
  warn: (warning: FolderScanWarning) => void;
  /** Identity map: canonical path -> first-discovery entry state. */
  entries: Map<string, EntryState>;
}

/** One folder reached by the walk: reach path, canonical identity, and descent chain. */
interface Walk {
  /** Reach path — used for fs calls and as the occurrence path. */
  reach: string;
  /** Canonical (real) path — the folder's identity. */
  canonical: string;
  via: 'scan' | 'shortcut';
  /** Canonical paths on this descent chain, including this folder; skipped-cycle guard. */
  ancestors: ReadonlySet<string>;
}

export function createScanContext(fs: FolderFs, warn: ScanContext['warn']): ScanContext {
  return { fs, warn, entries: new Map() };
}

/** Discover the sparse tree from the configured roots. */
export async function discoverRoots(ctx: ScanContext, roots: string[]): Promise<SparseTree> {
  const occurrences: FolderOccurrence[] = [];
  for (const root of roots) {
    const canonical = await resolveCanonical(ctx, root);
    if (canonical === null) continue;
    occurrences.push(...(await discoverFolder(ctx, { reach: root, canonical, via: 'scan', ancestors: new Set([canonical]) })));
  }
  return { occurrences };
}

/**
 * Discover one folder at `walk.reach`. Included folders yield one occurrence
 * (shortcut children on first discovery, reused children later); skipped
 * folders yield the occurrences found by descending through them.
 */
async function discoverFolder(ctx: ScanContext, walk: Walk): Promise<FolderOccurrence[]> {
  let listing: Dirent[];
  try {
    listing = await ctx.fs.readdir(walk.reach);
  } catch (error) {
    ctx.warn({ path: walk.reach, operation: 'readdir', error });
    return [];
  }

  const classification = await classifyListing(ctx.fs, walk.reach, listing, (markerPath, error) => ctx.warn({ path: markerPath, operation: 'readFile', error }));
  if (classification !== null) {
    return [await occurrenceForIncludedFolder(ctx, walk, listing, classification)];
  }
  return await descendThroughSkippedFolder(ctx, walk, listing);
}

/** Build (or reference) the occurrence of an included folder. */
async function occurrenceForIncludedFolder(ctx: ScanContext, walk: Walk, listing: Dirent[], classification: NonNullable<FolderClassification>): Promise<FolderOccurrence> {
  const known = ctx.entries.get(walk.canonical);
  if (known) {
    // Later encounter: same entry object; completed entries reuse their
    // first-discovery children, in-progress entries are leaves.
    return { path: walk.reach, via: walk.via, entry: known.entry, children: known.done ? known.children : [] };
  }

  const entry: FolderEntry = {
    path: walk.canonical,
    name: basename(walk.canonical),
    nature: classification.nature,
    ...(classification.nature === 'persona' ? { persona: classification.persona } : {}),
  };
  // Deliberate mutation point: register in-progress before shortcut recursion
  // so cycles close on this entry as leaf back-references.
  const state: EntryState = { entry, children: [], done: false };
  ctx.entries.set(walk.canonical, state);

  const occurrence: FolderOccurrence = { path: walk.reach, via: walk.via, entry, children: state.children };
  state.children.push(...(await shortcutOccurrences(ctx, walk, listing)));
  state.done = true;
  return occurrence;
}

/** Top-level symlinks of an included folder whose real path lies outside it. */
async function shortcutOccurrences(ctx: ScanContext, walk: Walk, listing: Dirent[]): Promise<FolderOccurrence[]> {
  const occurrences: FolderOccurrence[] = [];
  for (const dirent of listing) {
    if (!dirent.isSymbolicLink()) continue;

    const linkPath = join(walk.reach, dirent.name);
    const target = await resolveCanonical(ctx, linkPath);
    if (target === null) continue;
    if (target === walk.canonical || target.startsWith(`${walk.canonical}/`)) continue;
    if (!(await isDirectory(ctx, target))) continue;

    // Entering a shortcut restarts discovery at the target, in shortcut context.
    occurrences.push(...(await discoverFolder(ctx, { reach: linkPath, canonical: target, via: 'shortcut', ancestors: new Set([target]) })));
  }
  return occurrences;
}

/** Descend through a skipped folder; its structure collapses into occurrence paths. */
async function descendThroughSkippedFolder(ctx: ScanContext, walk: Walk, listing: Dirent[]): Promise<FolderOccurrence[]> {
  const occurrences: FolderOccurrence[] = [];
  for (const dirent of listing) {
    if (PRUNED_BASENAMES.has(dirent.name)) continue;

    const childReach = join(walk.reach, dirent.name);
    const kind = await lstatKind(ctx, childReach);
    if (kind !== 'dir' && kind !== 'symlink') continue;

    const childCanonical = await resolveCanonical(ctx, childReach);
    if (childCanonical === null) continue;
    if (walk.ancestors.has(childCanonical)) continue;

    occurrences.push(
      ...(await discoverFolder(ctx, {
        reach: childReach,
        canonical: childCanonical,
        via: walk.via,
        ancestors: new Set([...walk.ancestors, childCanonical]),
      })),
    );
  }
  return occurrences;
}

async function resolveCanonical(ctx: ScanContext, path: string): Promise<string | null> {
  try {
    return await ctx.fs.realpath(path);
  } catch (error) {
    ctx.warn({ path, operation: 'realpath', error });
    return null;
  }
}

async function lstatKind(ctx: ScanContext, path: string): Promise<'dir' | 'symlink' | 'other' | null> {
  try {
    const stats = await ctx.fs.lstat(path);
    if (stats.isDirectory()) return 'dir';
    if (stats.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch (error) {
    ctx.warn({ path, operation: 'lstat', error });
    return null;
  }
}

async function isDirectory(ctx: ScanContext, path: string): Promise<boolean> {
  try {
    return (await ctx.fs.lstat(path)).isDirectory();
  } catch (error) {
    ctx.warn({ path, operation: 'lstat', error });
    return false;
  }
}
