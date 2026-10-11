import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, rename, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { FolderInfo, FolderMemberInfo, RepoInfo } from '../../shared/dist/index.js';
import type { FolderEntry, FolderOccurrence, SparseTree } from './folder-model/index.js';
import type { FolderModelPort, FolderRegistryPort, FolderUpdatePatch } from './manager/types.js';
import { hubAgentsMarkdown, injectMemberLine, removeMemberLine, seededMemberLine } from './hub-agents-md.js';
import { MEMORY_STUB } from './folder-seeding.js';
import { materializeHubFolder, memberIgnoreLine } from './folder-sources/materialize.js';
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

/** Whether anything exists at the path without following symlinks — dangling
 *  symlinks count. */
async function linkOrPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** File contents, or null when the file is absent. */
async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Append one exact line to a text file's content; unchanged when the line is
 *  already there whole. Adds the separating newline first when needed. */
function appendExactLine(content: string, line: string): string {
  if (content.split('\n').includes(line)) return content;
  const separator = content !== '' && !content.endsWith('\n') ? '\n' : '';
  return `${content}${separator}${line}\n`;
}

/** Delete the first whole occurrence of one exact line; unchanged when the
 *  line is absent. */
function deleteExactLine(content: string, line: string): string {
  const lines = content.split('\n');
  const at = lines.indexOf(line);
  if (at === -1) return content;
  lines.splice(at, 1);
  return lines.join('\n');
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
/**
 * Nature per discovered folder-model entry — the one owner of the rule.
 * Scan entries decide their own nature; source-listed persona homes outside
 * the scan tree are personas; an undiscovered path has no entry (absent).
 */
function discoveredEntryNatures(scanned: Map<string, ScanRow>, sourcePersonas: Map<string, PersonaSourceEntry>): Map<string, 'code' | 'persona'> {
  const natures = new Map<string, 'code' | 'persona'>();
  for (const [path, row] of scanned) natures.set(path, row.entry.nature);
  for (const path of sourcePersonas.keys()) if (!natures.has(path)) natures.set(path, 'persona');
  return natures;
}

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

/** One hub-side member symlink: its name in the hub and its resolved target. */
interface HubLink {
  name: string;
  /** `realpath` when the target resolves, the resolved lexical target when it dangles. */
  target: string;
}

/** Whether `target` lies inside directory `dir` — the scanner's shortcut rule. */
function isInside(target: string, dir: string): boolean {
  return dir === '/' ? target.startsWith('/') : target.startsWith(`${dir}/`);
}

/** The hub-management gate the row menu shows ("Manage members…") as a
 *  server invariant: a manageable hub carries the probe's `members` fact or
 *  shortcuts. Registry and source hub rows satisfy it by construction; plain
 *  code and persona folders never do. */
function isManageableHub(row: FolderInfo): boolean {
  return row.members !== undefined || row.shortcutCount > 0;
}

/**
 * The hub symlink inventory for each given path (plan: 0.15-2 dashboard
 * folder UX). Paths that are absent or not directories are skipped (no map
 * entry). Targets equal to or inside the hub are skipped, the same rule the
 * scanner uses for shortcuts. Links sort by name.
 */
async function readHubLinks(paths: Iterable<string>): Promise<Map<string, HubLink[]>> {
  const inventory = new Map<string, HubLink[]>();
  for (const path of paths) {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      // Absent, not a directory, or unreadable (EACCES): the probe is
      // best-effort — one broken hub directory must never fail the listing.
      continue;
    }
    const hubCanonical = await realpath(path).catch(() => path);
    const links: HubLink[] = [];
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      try {
        const lexical = resolve(path, await readlink(join(path, entry.name)));
        const target = await realpath(lexical).catch(() => lexical);
        if (target === hubCanonical || isInside(target, hubCanonical)) continue;
        links.push({ name: entry.name, target });
      } catch {
        // A link removed or replaced mid-probe (ENOENT, EINVAL): skip the
        // link, never the view.
      }
    }
    links.sort((a, b) => a.name.localeCompare(b.name));
    inventory.set(path, links);
  }
  return inventory;
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
  /** Hub symlink inventories from the edge probe; probed paths only. */
  hubLinks: ReadonlyMap<string, HubLink[]>;
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
 * `members` (the symlink inventory) and the code members' git facts in `repos`;
 * persona rows carry neither.
 */
function mergedFolders(input: FolderViewInputs): FolderInfo[] {
  const scanned = collectScanEntries(input.tree);
  const byPath = new Map(input.repos.map((repo) => [repo.path, repo]));
  const hubs = hubMetadata(input.sourceHubs, input.doc);
  const sourcePersonas = new Map(input.personas.map((entry) => [entry.path, entry]));
  const natures = discoveredEntryNatures(scanned, sourcePersonas);

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
    // Hub membership in two shapes: `repos` carries git facts (and the
    // disband gate) for the code members only — persona members have none —
    // while `members` is the symlink-inventory membership fact. A code member
    // absent from the index still gets the missing placeholder.
    const memberRepos: RepoInfo[] | undefined = hub
      ? hub.memberPaths
          .filter((memberPath) => scanned.get(memberPath)?.entry.nature !== 'persona')
          .map((memberPath) => ({ ...(byPath.get(memberPath) ?? missingRepo(memberPath)), tags: repoTags(memberPath) }))
      : undefined;
    // Only probed paths carry `members`; the probe skipped absent paths.
    const memberLinks = input.hubLinks.get(path);
    const folderMembers: FolderMemberInfo[] | undefined = memberLinks?.map((link) => ({
      path: link.target,
      name: link.name,
      nature: natures.get(link.target) ?? 'code',
    }));
    // Hub rows implicitly inherit their members' tags.
    const memberTagUnion = memberRepos ? unionTags(...memberRepos.map((member) => member.tags)) : undefined;
    const nature = natures.get(path) ?? 'code';
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
      ...(memberRepos ? { repos: memberRepos } : {}),
      ...(folderMembers ? { members: folderMembers } : {}),
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
    // The hub-link probe runs over registry/source hubs and scanned rows with
    // shortcuts — the rows whose symlink inventory can carry members.
    const probePaths = new Set(hubMetadata(sourceHubs, doc).keys());
    for (const [path, row] of collectScanEntries(tree)) {
      if (row.shortcutCount > 0) probePaths.add(path);
    }
    const hubLinks = await readHubLinks(probePaths);
    return mergedFolders({ doc, tree, repos, sourceHubs, personas, absent, hubLinks });
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
   * Create a hub folder: mkdir under `root`, symlink every member, and
   * generate the hub AGENTS.md with its managed member block (plus git init
   * and member .gitignore). Members are any discovered folder-model entry
   * (code or persona); unknown members reject. The persona variant
   * (`personaText !== undefined`) seeds a persona marker and memory.md.
   * Resolves to the hub's full FolderInfo row.
   */
  async createHub(input: { name: string; root: string; memberPaths: string[]; body?: string; description?: string; personaText?: string }): Promise<FolderInfo> {
    return this.serialized(async () => {
      const doc = await this.document();

      const { name, root } = input;
      if (!isValidFolderName(name)) throw new Error(`Invalid folder name: ${name}`);
      const natures = await this.discoveredNatures();
      for (const memberPath of input.memberPaths) {
        if (!natures.has(memberPath)) throw new Error(`Unknown folder: ${memberPath}`);
      }
      const memberPaths = [...input.memberPaths];
      // Two members with the same basename collide on one symlink target inside
      // the hub — reject up front so no partial hub is ever built.
      const seen = new Set<string>();
      for (const memberPath of memberPaths) {
        const base = basename(memberPath);
        if (seen.has(base)) throw new Error(`Duplicate member name: ${base}`);
        seen.add(base);
      }
      const target = join(root, name);
      for (const memberPath of memberPaths) {
        if (isInside(memberPath, target) || isInside(target, memberPath)) throw new Error(`A hub member cannot contain or live inside the hub: ${memberPath}`);
      }
      if (await pathExists(target)) throw new Error(`Directory already exists: ${target}`);

      const members = memberPaths.map((memberPath) => ({ name: basename(memberPath), nature: natures.get(memberPath)! }));
      const agentsMd =
        input.personaText !== undefined
          ? hubAgentsMarkdown({ name, members, persona: { description: input.description ?? '', personaText: input.personaText } })
          : hubAgentsMarkdown({ name, members, body: input.body });

      let canonicalTarget: string;
      try {
        await materializeHubFolder({ kind: 'hub', path: target, name, memberPaths }, agentsMd);
        // The persona-hub variant is a persona folder: its marker AGENTS.md
        // (rendered above) plus the memory stub, rolled back with the hub.
        if (input.personaText !== undefined) await writeFile(join(target, 'memory.md'), MEMORY_STUB, 'utf8');
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
      return this.hubRow(doc, await this.repos.list(), canonicalTarget);
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
    // hubLinks stays empty: the returned row skips the hub-link probe (the
    // existing toEqual contract pins it without a `members` key).
    const row = mergedFolders({ doc, tree: { occurrences: [] }, repos, sourceHubs, personas: await this.repos.listSourcePersonas(), absent: new Set(), hubLinks: new Map() }).find(
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

  /**
   * Add a hub member (plan: 0.15-2 dashboard folder UX). `memberPath` must be
   * a discovered folder-model entry (any nature); a duplicate basename is
   * rejected. Adds the hub-side symlink and injects the member's exact seeded
   * link line into the hub AGENTS.md managed block. Throws with a
   * user-presentable message on validation failure. Broadcasts a
   * folders_changed delta like the other mutations.
   */
  async addMember(hubPath: string, memberPath: string): Promise<void> {
    return this.serialized(async () => {
      const hub = (await this.listLazy()).find((folder) => folder.path === hubPath);
      if (!hub || hub.missing) throw new Error(`Unknown hub folder: ${hubPath}`);
      if (!isManageableHub(hub)) throw new Error(`Not a hub folder: ${hubPath}`);
      if (memberPath === hubPath) throw new Error(`A hub cannot be its own member: ${memberPath}`);
      if (isInside(memberPath, hubPath) || isInside(hubPath, memberPath)) throw new Error(`A hub member cannot contain or live inside the hub: ${memberPath}`);
      const nature = (await this.discoveredNatures()).get(memberPath);
      if (nature === undefined) throw new Error(`Unknown folder: ${memberPath}`);
      const name = basename(memberPath);
      const linkPath = join(hubPath, name);
      if (await linkOrPathExists(linkPath)) throw new Error(`Duplicate member name: ${name}`);

      // Reads first: a read failure must leave disk untouched.
      const agentsPath = join(hubPath, 'AGENTS.md');
      const ignorePath = join(hubPath, '.gitignore');
      const agentsBefore = await readTextIfPresent(agentsPath);
      const ignoreBefore = await readTextIfPresent(ignorePath);

      // Every mutation registers its inverse, so a later failure (a write or
      // the registry persist) rolls the whole add back — a retry never meets
      // `Duplicate member name` or a stale seeded line.
      const undo: Array<() => Promise<void>> = [];
      const writeBack = async (path: string, before: string | null, updated: string): Promise<void> => {
        if (updated === (before ?? '')) return;
        await writeFile(path, updated, 'utf8');
        undo.push(before === null ? () => rm(path, { force: true }) : () => writeFile(path, before, 'utf8'));
      };

      await symlink(memberPath, linkPath);
      undo.push(() => unlink(linkPath));
      const doc = await this.document();
      const entry = doc.hubs.find((candidate) => candidate.path === hubPath);
      try {
        await writeBack(agentsPath, agentsBefore, injectMemberLine(agentsBefore ?? '', seededMemberLine(name, nature)));
        if (ignoreBefore !== null) await writeBack(ignorePath, ignoreBefore, appendExactLine(ignoreBefore, memberIgnoreLine(name)));
        if (entry && !entry.memberPaths.includes(memberPath)) {
          entry.memberPaths.push(memberPath);
          undo.push(async () => {
            entry.memberPaths = entry.memberPaths.filter((candidate) => candidate !== memberPath);
          });
          await this.persist(doc);
        }
      } catch (error) {
        for (const step of undo.reverse()) await step().catch(() => {});
        throw error;
      }

      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [hubPath], removedPaths: [] });
    });
  }

  /**
   * Remove a hub member (plan: 0.15-2 dashboard folder UX). Works by path
   * even when the member folder is missing — the symlink and the seeded line
   * are removed regardless. Unlinks the hub-side symlink ONLY, never touches
   * the member folder, and removes the member's seeded line if present
   * byte-exact. Broadcasts a folders_changed delta like the other mutations.
   */
  async removeMember(hubPath: string, memberPath: string): Promise<void> {
    return this.serialized(async () => {
      // Same hub-eligibility gate as addMember: no symlink operations on a
      // path that is not a manageable hub, whatever a wire client sends.
      const hub = (await this.listLazy()).find((folder) => folder.path === hubPath);
      if (!hub) throw new Error(`Unknown hub folder: ${hubPath}`);
      if (!isManageableHub(hub)) throw new Error(`Not a hub folder: ${hubPath}`);
      const doc = await this.document();
      const link = (await readHubLinks([hubPath])).get(hubPath)?.find((candidate) => candidate.target === memberPath);
      const entry = doc.hubs.find((candidate) => candidate.path === hubPath);
      if (!link && !entry?.memberPaths.includes(memberPath)) throw new Error(`Not a member of ${basename(hubPath)}: ${memberPath}`);

      // Unlink the hub-side symlink ONLY — the member folder is never touched.
      if (link) await unlink(join(hubPath, link.name));
      // A missing member has no nature on disk: try both seeded lines — both
      // are exact strings this module's mutator seeded.
      const name = link?.name ?? basename(memberPath);
      const agentsPath = join(hubPath, 'AGENTS.md');
      const content = await readTextIfPresent(agentsPath);
      if (content !== null) {
        const updated = removeMemberLine(removeMemberLine(content, seededMemberLine(name, 'code')), seededMemberLine(name, 'persona'));
        if (updated !== content) await writeFile(agentsPath, updated, 'utf8');
      }
      const ignorePath = join(hubPath, '.gitignore');
      const ignoreContent = await readTextIfPresent(ignorePath);
      if (ignoreContent !== null) {
        const updatedIgnore = deleteExactLine(ignoreContent, memberIgnoreLine(name));
        if (updatedIgnore !== ignoreContent) await writeFile(ignorePath, updatedIgnore, 'utf8');
      }
      if (entry?.memberPaths.includes(memberPath)) {
        entry.memberPaths = entry.memberPaths.filter((candidate) => candidate !== memberPath);
        await this.persist(doc);
      }
      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [hubPath], removedPaths: [] });
    });
  }

  /** Everything list() shows — every path update() accepts. */
  private async knownFolderPaths(): Promise<Set<string>> {
    return new Set((await this.list()).map((folder) => folder.path));
  }

  /** Canonical path → nature over every discovered folder-model entry
   *  (`discoveredEntryNatures`: scan entries plus source personas), plus
   *  every index path as `code` when neither holds it. The widened membership
   *  rule: hub members are discovered entries (any nature), never arbitrary
   *  filesystem paths. */
  private async discoveredNatures(): Promise<Map<string, 'code' | 'persona'>> {
    const sourcePersonas = new Map((await this.repos.listSourcePersonas()).map((entry) => [entry.path, entry]));
    const natures = discoveredEntryNatures(collectScanEntries(await this.tree.tree()), sourcePersonas);
    for (const repo of await this.repos.listLazy()) {
      if (!natures.has(repo.path)) natures.set(repo.path, 'code');
    }
    return natures;
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
