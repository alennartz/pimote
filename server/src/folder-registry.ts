import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { FolderInfo, RepoInfo } from '../../shared/dist/index.js';
import type { FolderEntry, FolderOccurrence, SparseTree } from './folder-model/index.js';
import type { FolderModelPort, FolderRegistryPort, FolderUpdatePatch } from './manager/types.js';
import { materializeHubFolder } from './folder-sources/materialize.js';
import type { HubSourceEntry } from './folder-sources/index.js';
import type { PersonaSourceEntry, RepoIndex } from './repo-index.js';

export type { FolderUpdatePatch } from './manager/types.js';

const REGISTRY_FILE = 'registry.json';
const DOCUMENT_VERSION = 1;

/** One persisted hub folder. */
interface HubEntry {
  path: string;
  name: string;
  memberPaths: string[];
}

/** Curation flags for one folder path; absent keys mean "unset". */
interface OverrideEntry {
  favorite?: boolean;
  archived?: boolean;
  /** User tags at this path. */
  tags?: string[];
}

/** The registry's single JSON document at `<storeDir>/registry.json`. */
interface RegistryDocument {
  version: number;
  hubs: HubEntry[];
  overrides: Record<string, OverrideEntry>;
}

/** A persisted document as handed to the parser: `hubs` with read-compat for
 *  the legacy `multiRepo` key (docs written before the rename). */
type PersistedDocument = Partial<RegistryDocument> & { multiRepo?: unknown };

function emptyDocument(): RegistryDocument {
  return { version: DOCUMENT_VERSION, hubs: [], overrides: {} };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty. */
function parseDocument(raw: string): RegistryDocument {
  try {
    const parsed = JSON.parse(raw) as PersistedDocument;
    // Prefer `hubs` when the new key exists; fall back to the legacy `multiRepo`.
    const rawHubs: unknown[] = Array.isArray(parsed.hubs) ? parsed.hubs : Array.isArray(parsed.multiRepo) ? parsed.multiRepo : [];
    if (typeof parsed.overrides !== 'object' || parsed.overrides === null) return emptyDocument();
    // Per-entry shape: one malformed hub entry (e.g. no memberPaths in a hand-edited
    // file) must not poison every listing — skip the entry, keep the rest.
    const hubs = rawHubs.filter((entry): entry is HubEntry => {
      const candidate = entry as Partial<HubEntry> | null;
      if (typeof candidate?.path !== 'string' || typeof candidate?.name !== 'string') return false;
      return Array.isArray(candidate.memberPaths) && candidate.memberPaths.every((p) => typeof p === 'string');
    });
    // Registry files written before manual ordering was retired may still carry
    // `order` overrides; drop them so they don't leak into FolderInfo payloads.
    for (const override of Object.values(parsed.overrides)) {
      if (override && typeof override === 'object') delete (override as { order?: number }).order;
    }
    return { version: DOCUMENT_VERSION, hubs, overrides: parsed.overrides };
  } catch {
    return emptyDocument();
  }
}

/**
 * The folder-name rule shared by every server-side creation path
 * (create_folder, hub creation, the built-in creator): non-empty, no path
 * separators, not . or ..
 */
export function isValidFolderName(name: string): boolean {
  return !!name && !name.includes('/') && !name.includes(sep) && name !== '.' && name !== '..';
}

/**
 * Enrich folders in place with live session counts: a session counts toward
 * the folder whose path it runs in (exact match). Derived state the registry
 * itself cannot know — every path that serves `FolderInfo`s (list_folders,
 * the folders_changed broadcast, the manager tool, session events) runs its
 * list through this so no consumer ever sees zeroed counts.
 */
export function enrichActiveSessionCounts(folders: FolderInfo[], activeSessions: ReadonlyArray<{ folderPath: string | null }>): void {
  for (const folder of folders) {
    folder.activeSessionCount = activeSessions.filter((session) => session.folderPath === folder.path).length;
  }
}

/** Whether anything (file, directory, symlink) exists at the path. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Placeholder for a member repo the index no longer knows. */
function missingRepo(path: string): RepoInfo {
  return { path, name: basename(path), branch: null, dirty: false, ahead: 0, behind: 0, missing: true };
}

/** Union tag sets; undefined when all inputs are empty (keeps the wire clean). */
function unionTags(...sets: (string[] | undefined)[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const tag of set ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** One unique canonical scan entry plus its first-discovery shortcut count. */
interface ScanRow {
  entry: FolderEntry;
  shortcutCount: number;
}

/**
 * Unique canonical entries across the whole occurrence tree (code and persona
 * alike) with their first-discovery immediate shortcut children. The
 * pre-order walk meets each entry first at its discovery occurrence (leaf
 * back-references come later), so first-seen children are the discovery ones.
 */
function collectScanEntries(tree: SparseTree): Map<string, ScanRow> {
  const byPath = new Map<string, ScanRow>();
  const visit = (occurrence: FolderOccurrence): void => {
    if (!byPath.has(occurrence.entry.path)) {
      byPath.set(occurrence.entry.path, {
        entry: occurrence.entry,
        shortcutCount: occurrence.children.filter((child) => child.via === 'shortcut').length,
      });
    }
    for (const child of occurrence.children) visit(child);
  };
  for (const occurrence of tree.occurrences) visit(occurrence);
  return byPath;
}

/** Effective hub metadata for one path: source-listed shape with persisted
 *  entries overriding name/memberPaths when both layers list the path. */
interface HubMetadata {
  name: string;
  memberPaths: string[];
  sourceTags?: string[];
}

function hubMetadata(sourceHubs: HubSourceEntry[], doc: RegistryDocument): Map<string, HubMetadata> {
  const hubs = new Map<string, HubMetadata>();
  for (const source of sourceHubs) {
    hubs.set(source.path, { name: source.name, memberPaths: source.memberPaths, sourceTags: source.tags });
  }
  for (const entry of doc.hubs) {
    hubs.set(entry.path, { name: entry.name, memberPaths: entry.memberPaths, sourceTags: hubs.get(entry.path)?.sourceTags });
  }
  return hubs;
}

/** Hub paths whose rows inherit the member's tags: every effective hub that
 *  lists the member. Sorted for deterministic change payloads. */
function dependentHubPaths(memberPath: string, hubs: Map<string, HubMetadata>): string[] {
  return [...hubs.entries()]
    .filter(([, hub]) => hub.memberPaths.includes(memberPath))
    .map(([path]) => path)
    .sort();
}

/** The change targets one accepted patch reports: the canonical primary path,
 *  plus for tag edits every hub whose inherited tags move with the member. */
function updateChangeTargets(patch: FolderUpdatePatch, hubs: Map<string, HubMetadata>): { changedPaths: string[]; removedPaths: string[] } {
  const tagEdit = Boolean(patch.addTags?.length || patch.removeTags?.length);
  return { changedPaths: [patch.folderPath, ...(tagEdit ? dependentHubPaths(patch.folderPath, hubs) : [])], removedPaths: [] };
}

/** Everything mergedFolders needs; persistence and fs probes stay at the edges. */
interface FolderViewInputs {
  doc: RegistryDocument;
  tree: SparseTree;
  repos: RepoInfo[];
  sourceHubs: HubSourceEntry[];
  /** Source-listed persona homes (excluded from the repo view, surfaced here). */
  personas: PersonaSourceEntry[];
  /** Paths verified absent on disk; every unlisted path counts as present. */
  absent: ReadonlySet<string>;
}

/**
 * The merged folder view: one row per canonical path across the scan's unique
 * entries (code and persona), source-listed repos/hubs, source-listed persona
 * homes, and registry hubs — never derived from repos alone. Pure construction:
 * classification and metadata come from explicit inputs.
 *
 * Collisions enrich rather than replace: a scanned row at a hub path keeps its
 * scanned nature/name/shortcut count and gains the hub's membership chips, so
 * discovery seeing a hub first never loses membership. Persisted hub metadata
 * wins over source metadata. Rows get `missing` only when they are not scanned
 * and verified absent — orphaned curation overrides alone never make a row.
 *
 * Plain code rows known to the index carry their own repo facts in `repo`,
 * copied from the index cache (no git probe here). Hub rows keep membership in
 * `repos`; persona rows carry neither.
 */
function mergedFolders(input: FolderViewInputs): FolderInfo[] {
  const scanned = collectScanEntries(input.tree);
  const byPath = new Map(input.repos.map((repo) => [repo.path, repo]));
  const hubs = hubMetadata(input.sourceHubs, input.doc);
  const sourcePersonas = new Map(input.personas.map((entry) => [entry.path, entry]));

  /** Effective tags at a repo path: source-contributed ∪ user. */
  const repoTags = (repoPath: string): string[] | undefined => unionTags(byPath.get(repoPath)?.tags, input.doc.overrides[repoPath]?.tags);

  const rows: FolderInfo[] = [];
  for (const path of new Set([...scanned.keys(), ...byPath.keys(), ...hubs.keys(), ...sourcePersonas.keys()])) {
    const scan = scanned.get(path);
    const repo = byPath.get(path);
    const hub = hubs.get(path);
    const sourcePersona = sourcePersonas.get(path);
    const override = input.doc.overrides[path];
    const userTags = override?.tags;
    const members: RepoInfo[] | undefined = hub
      ? hub.memberPaths.map((memberPath) => ({ ...(byPath.get(memberPath) ?? missingRepo(memberPath)), tags: repoTags(memberPath) }))
      : undefined;
    // Hub rows implicitly inherit their members' tags.
    const memberTagUnion = members ? unionTags(...members.map((member) => member.tags)) : undefined;
    const nature = scan?.entry.nature ?? (sourcePersona ? 'persona' : 'code');
    // Own repo facts for plain code rows: copied from the cached index facts
    // (effective tags like every other RepoInfo on a row). Personas and hub
    // rows omit `repo`.
    const ownRepo: RepoInfo | undefined = nature === 'code' && !hub && repo ? { ...repo, tags: repoTags(path) } : undefined;
    rows.push({
      path,
      name: scan?.entry.name ?? hub?.name ?? repo?.name ?? basename(path),
      nature,
      ...(scan?.entry.persona ? { persona: scan.entry.persona } : sourcePersona ? { persona: sourcePersona.persona } : {}),
      shortcutCount: scan?.shortcutCount ?? hub?.memberPaths.length ?? 0,
      favorite: override?.favorite ?? false,
      archived: override?.archived ?? false,
      // Effective tags: own user ∪ source-contributed, plus inherited member
      // tags for hubs; userTags is only the removable own-path subset.
      tags: (hub ? unionTags(userTags, hub.sourceTags, memberTagUnion) : unionTags(repo?.tags, sourcePersona?.tags, userTags)) ?? [],
      missing: !scan && input.absent.has(path),
      ...(ownRepo ? { repo: ownRepo } : {}),
      ...(members ? { repos: members } : {}),
      ...(userTags ? { userTags } : {}),
      activeSessionCount: 0,
      externalProcessCount: 0,
    });
  }
  return rows;
}

/** Favorites first, then the rest by name. Clients re-sort for display. */
function sortFolders(folders: FolderInfo[]): FolderInfo[] {
  return [...folders].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
}

/**
 * Paths known absent on disk — the edge probe behind `missing`. Repo rows
 * carry their own probe results from the index; hub-only paths are statted
 * here (a git-less legacy hub exists, an unbuilt source hub does not).
 */
async function resolveAbsentPaths(repos: RepoInfo[], hubPaths: Iterable<string>): Promise<Set<string>> {
  const absent = new Set(repos.filter((repo) => repo.missing).map((repo) => repo.path));
  const known = new Set(repos.map((repo) => repo.path));
  for (const path of hubPaths) {
    if (known.has(path)) continue;
    if (!(await pathExists(path))) absent.add(path);
  }
  return absent;
}

/**
 * The persistent user-owned layer over folder discovery: hub folders and
 * curation overrides (favorite / archived / tags) keyed by canonical folder
 * path, hub creation (mkdir + symlinks + generated AGENTS.md + git init),
 * disbanding, and change notifications. Merges its state over the scan's
 * entries, the repo index, and registered sources. Persists as JSON following
 * the session-json-store pattern.
 */
export class FolderRegistry implements FolderRegistryPort {
  private documentPromise: Promise<RegistryDocument> | null = null;
  private readonly subscribers = new Set<(change: { changedPaths: string[]; removedPaths: string[] }) => void>();
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repos: RepoIndex,
    private readonly storeDir: string,
    private readonly tree: FolderModelPort,
  ) {}

  /**
   * The merged folder view: every unique canonical scan entry (code and
   * persona) plus source-listed repos/hubs and registry hubs, with curation
   * overrides applied.
   */
  async list(): Promise<FolderInfo[]> {
    return sortFolders(await this.viewOver(await this.tree.tree(), await this.repos.list()));
  }

  /**
   * The window path's view: rows with identity facts and any warm git
   * status, never blocked on git probes. Git facts fill in per served row
   * through `enrichRows`.
   */
  async listLazy(): Promise<FolderInfo[]> {
    return sortFolders(await this.viewOver(await this.tree.tree(), await this.repos.listLazy()));
  }

  /**
   * Git status for exactly these rows — their own repo facts and hub member
   * facts — patched onto the rows in place. The one mutation point for
   * enrichment; rows are fresh per view build. Probes are scoped to the given
   * rows (bounded concurrency), so windows and deltas never pay a whole-set
   * pass.
   */
  async enrichRows(rows: FolderInfo[]): Promise<void> {
    const targets = rows.flatMap((row) => [...(row.repo ? [row.repo] : []), ...(row.repos ?? [])]);
    const status = await this.repos.enrichStatus(targets.map((repo) => repo.path));
    for (const target of targets) {
      const facts = status.get(target.path);
      if (!facts) continue;
      target.branch = facts.branch;
      target.dirty = facts.dirty;
      target.ahead = facts.ahead;
      target.behind = facts.behind;
    }
  }

  /** The merged view over one folder tree; pure construction, edge probes first. */
  private async viewOver(tree: SparseTree, repos: RepoInfo[]): Promise<FolderInfo[]> {
    const [doc, sourceHubs, personas] = await Promise.all([this.document(), this.repos.listSourceHubs(), this.repos.listSourcePersonas()]);
    const absent = await resolveAbsentPaths(repos, hubMetadata(sourceHubs, doc).keys());
    return mergedFolders({ doc, tree, repos, sourceHubs, personas, absent });
  }

  /** Apply a curation patch. Unknown folder paths reject. */
  update(patch: FolderUpdatePatch): Promise<void> {
    return this.serialized(async () => {
      const doc = await this.document();
      const known = await this.knownFolderPaths();
      if (!known.has(patch.folderPath)) throw new Error(`Unknown folder: ${patch.folderPath}`);

      const override = doc.overrides[patch.folderPath] ?? {};
      if (patch.favorite !== undefined) override.favorite = patch.favorite;
      if (patch.archived !== undefined) override.archived = patch.archived;
      if (patch.addTags?.length || patch.removeTags?.length) {
        const tags = new Set(override.tags ?? []);
        for (const tag of patch.addTags ?? []) {
          const trimmed = tag.trim();
          if (trimmed) tags.add(trimmed);
        }
        for (const tag of patch.removeTags ?? []) tags.delete(tag);
        override.tags = [...tags];
      }
      doc.overrides[patch.folderPath] = override;

      const change = updateChangeTargets(patch, hubMetadata(await this.repos.listSourceHubs(), doc));
      await this.persist(doc);
      this.fireChange(change);
    });
  }

  /**
   * Create a hub folder: mkdir under `root`, symlink every member repo, and
   * generate the hub AGENTS.md with the sub-project convention (plus git init
   * and member .gitignore). Every memberPath must exist in the repo index;
   * unknown members reject. Resolves to the hub's full FolderInfo row.
   */
  async createHub(input: { name: string; root: string; memberPaths: string[] }): Promise<FolderInfo> {
    return this.serialized(async () => {
      const doc = await this.document();
      const repos = await this.repos.list();
      const byPath = new Map(repos.map((repo) => [repo.path, repo]));

      const { name, root } = input;
      if (!isValidFolderName(name)) throw new Error(`Invalid folder name: ${name}`);
      const unknown = input.memberPaths.find((memberPath) => !byPath.has(memberPath));
      if (unknown !== undefined) throw new Error(`Unknown repo: ${unknown}`);
      const memberPaths = input.memberPaths.map((memberPath) => byPath.get(memberPath)!.path);
      // Two members with the same basename collide on one symlink target inside
      // the hub — reject up front so no partial hub is ever built.
      const seen = new Set<string>();
      for (const memberPath of memberPaths) {
        const base = basename(memberPath);
        if (seen.has(base)) throw new Error(`Duplicate member name: ${base}`);
        seen.add(base);
      }
      const target = join(root, name);
      if (await pathExists(target)) throw new Error(`Directory already exists: ${target}`);

      let canonicalTarget: string;
      try {
        await materializeHubFolder({ kind: 'hub', path: target, name, memberPaths });
        // Canonical identity (curation contract): a configured root may be a
        // symlink alias, and discovery identifies folders by their real path —
        // persisting the lexical path would split the hub into two rows and
        // orphan its curation on one of them.
        canonicalTarget = await realpath(target);
        doc.hubs.push({ path: canonicalTarget, name, memberPaths });
        await this.persist(doc);
      } catch (error) {
        // Never leave a half-built hub folder behind: it would block retry
        // (Directory already exists) and couldn't be disbanded (no registry
        // entry) — all-or-nothing.
        await rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      this.fireChange({ changedPaths: [canonicalTarget], removedPaths: [] });
      return this.hubRow(doc, repos, canonicalTarget);
    });
  }

  /**
   * The freshly persisted hub's row from the shared view construction (the
   * empty tree stands in for "not yet discovered": the hub row comes from the
   * registry layer with member-count shortcuts, exactly as list() serves it
   * until a scan observes the folder).
   */
  private async hubRow(doc: RegistryDocument, repos: RepoInfo[], target: string): Promise<FolderInfo> {
    const sourceHubs = await this.repos.listSourceHubs();
    const row = mergedFolders({ doc, tree: { occurrences: [] }, repos, sourceHubs, personas: await this.repos.listSourcePersonas(), absent: new Set() }).find(
      (folder) => folder.path === target,
    );
    if (!row) throw new Error(`Hub row missing after creation: ${target}`);
    return row;
  }

  /** Remove a hub folder: registry entry removed and the hub folder deleted. */
  disbandHub(folderPath: string): Promise<void> {
    return this.serialized(async () => {
      const doc = await this.document();
      const index = doc.hubs.findIndex((entry) => entry.path === folderPath);
      // Source hubs without a persisted registry entry refuse disbanding: their
      // UI eligibility does not grant deletion ownership.
      if (index === -1) throw new Error(`Not a hub folder: ${folderPath}`);

      // rm on a directory unlinks symlinks inside it; the member repos survive.
      // The entry leaves the document only after a successful rm: an rm
      // failure (EPERM/EBUSY) must not silently disband the hub anyway.
      const removed = doc.hubs[index];
      await rm(removed.path, { recursive: true, force: true });
      doc.hubs.splice(index, 1);
      await this.persist(doc);
      // Delta subscribers re-resolve rows immediately. Discard discovery's
      // deleted hub before they can read its cached tree or repo facts.
      // Listing-only: the deleted hub's status entry is keyed by a vanished
      // path and can never serve a row again; member repos keep warm probes.
      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [], removedPaths: [removed.path] });
    });
  }

  /** Subscribe to registry mutations; returns an unsubscribe function. */
  onChange(cb: (change: { changedPaths: string[]; removedPaths: string[] }) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Everything list() shows — every path update() accepts. */
  private async knownFolderPaths(): Promise<Set<string>> {
    return new Set((await this.list()).map((folder) => folder.path));
  }

  /** Lazy-loaded document; the promise is cached so the file is read once.
   *  A load failure clears the cache — one transient read error (EACCES,
   *  EISDIR) must not brick every folder command until restart. */
  private document(): Promise<RegistryDocument> {
    if (!this.documentPromise) {
      this.documentPromise = this.loadDocument().catch((error) => {
        this.documentPromise = null;
        throw error;
      });
    }
    return this.documentPromise;
  }

  private async loadDocument(): Promise<RegistryDocument> {
    try {
      const raw = await readFile(join(this.storeDir, REGISTRY_FILE), 'utf8');
      return parseDocument(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
      throw error;
    }
  }

  /** Serialize mutating operations: WS commands are handled fire-and-forget,
   *  so interleaved mutations would race on the shared cached document and
   *  the tmp file (e.g. two renames, the second hitting a moved tmp path).
   *  Each mutation runs only after the previous one settles. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  /** Atomic replace: write to a unique `.tmp`, then rename over the final
   *  path. On failure the cached document is dropped so the next read
   *  reloads from disk — the mutation may already sit in the shared cached
   *  object, and memory must not diverge from what's persisted. */
  private async persist(doc: RegistryDocument): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const finalPath = join(this.storeDir, REGISTRY_FILE);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, finalPath);
    } catch (error) {
      this.documentPromise = null;
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Emit one accepted mutation's change targets to every subscriber. */
  private fireChange(change: { changedPaths: string[]; removedPaths: string[] }): void {
    for (const cb of [...this.subscribers]) cb(change);
  }
}
