import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, rename, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { FolderInfo, FolderMemberInfo, RepoInfo } from '../../shared/dist/index.js';
import type { FolderEntry, FolderNature, FolderOccurrence, SparseTree } from './folder-model/index.js';
import type { FolderRegistryPort, FolderUpdatePatch } from './manager/types.js';
import { hubAgentsMarkdown, injectMemberLine, managedMemberNature, removeMemberLine, seededMemberLine } from './hub-agents-md.js';
import { MEMORY_STUB } from './folder-seeding.js';
import { materializeHubFolder, memberIgnoreLine } from './folder-sources/materialize.js';
import type { HubSourceEntry } from './folder-sources/index.js';
import type { PersonaSourceEntry, RepoIndex } from './repo-index.js';

export type { FolderUpdatePatch } from './manager/types.js';

const REGISTRY_FILE = 'registry.json';
const DOCUMENT_VERSION = 1;

/** Curation flags for one folder path; absent keys mean "unset". */
interface OverrideEntry {
  favorite?: boolean;
  archived?: boolean;
  /** User tags at this path. */
  tags?: string[];
}

/** The registry's single JSON document at `<storeDir>/registry.json`: the
 *  curation layer only. Hub ownership is not persisted — shape is the
 *  contract (DR-064): a hub is whatever folder carries member symlinks. */
interface RegistryDocument {
  version: number;
  overrides: Record<string, OverrideEntry>;
}

/** A persisted document as handed to the parser. The legacy `hubs` and
 *  `multiRepo` hub lists (docs written before DR-064) are ignored. */
type PersistedDocument = Partial<RegistryDocument> & { hubs?: unknown; multiRepo?: unknown };

function emptyDocument(): RegistryDocument {
  return { version: DOCUMENT_VERSION, overrides: {} };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty. */
function parseDocument(raw: string): RegistryDocument {
  try {
    const parsed = JSON.parse(raw) as PersistedDocument;
    if (typeof parsed.overrides !== 'object' || parsed.overrides === null) return emptyDocument();
    // Registry files written before manual ordering was retired may still carry
    // `order` overrides; drop them so they don't leak into FolderInfo payloads.
    for (const override of Object.values(parsed.overrides)) {
      if (override && typeof override === 'object') delete (override as { order?: number }).order;
    }
    return { version: DOCUMENT_VERSION, overrides: parsed.overrides };
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

/** One hub-side member symlink: its name, target, nature, and liveness. */
interface HubLink {
  name: string;
  /** Canonical target path when present, lexical absolute path when dangling. */
  target: string;
  nature: FolderNature;
  /** Whether the target currently resolves to a directory. */
  missing: boolean;
}

/** Whether `target` lies inside directory `dir` — the scanner's shortcut rule. */
function isInside(target: string, dir: string): boolean {
  return dir === '/' ? target.startsWith('/') : target.startsWith(`${dir}/`);
}

/** The hub-management gate the row menu shows ("Manage members…") as a
 *  server invariant: a manageable hub carries the probe's `members` fact or
 *  shortcut occurrences. Source hubs may qualify from their promise before
 *  materialization; scanned hubs qualify from their on-disk symlinks. */
function isManageableHub(row: FolderInfo): boolean {
  return row.members !== undefined || row.shortcutCount > 0;
}

/**
 * Resolve the canonical directory for a candidate folder path. A missing,
 * dangling, or non-directory path is not a folder-model entry.
 */
async function canonicalDirectory(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isDirectory()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Resolve every known folder-model entry to its canonical path. Scan entries
 * win over source fallbacks, while source paths still cover valid external
 * folders. Existence is checked again so stale source rows cannot authorize a
 * dangling link.
 */
async function resolveKnownFolderNatures(
  tree: SparseTree,
  repos: ReadonlyArray<RepoInfo>,
  sourceHubs: ReadonlyArray<HubSourceEntry>,
  personas: ReadonlyArray<PersonaSourceEntry>,
): Promise<Map<string, FolderNature>> {
  const candidates = new Map<string, FolderNature>();
  for (const [path, row] of collectScanEntries(tree)) candidates.set(path, row.entry.nature);
  for (const persona of personas) if (!candidates.has(persona.path)) candidates.set(persona.path, 'persona');
  for (const repo of repos) if (!candidates.has(repo.path)) candidates.set(repo.path, 'code');
  for (const hub of sourceHubs) if (!candidates.has(hub.path)) candidates.set(hub.path, 'code');

  const resolved = new Map<string, FolderNature>();
  const entries = await Promise.all(
    [...candidates].map(async ([path, nature]) => {
      const canonical = await canonicalDirectory(path);
      return canonical ? ([canonical, nature] as const) : null;
    }),
  );
  for (const entry of entries) {
    if (entry && !resolved.has(entry[0])) resolved.set(entry[0], entry[1]);
  }
  return resolved;
}

/**
 * Validate one add/create target and return its nature. Existing directories
 * must already be known folder-model identities, including source-listed
 * entries outside configured roots. Missing paths are valid only when
 * discovery already knows their identity, such as a source promise. Existing
 * regular files and other non-folders never pass through the identity
 * fallback.
 */
async function candidateFolderNature(path: string, known: ReadonlyMap<string, FolderNature>): Promise<FolderNature | undefined> {
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    return known.get(path);
  }
  if (!stats.isDirectory()) return undefined;
  const canonical = await realpath(path).catch(() => null);
  return (canonical ? known.get(canonical) : undefined) ?? known.get(path);
}

/**
 * The hub symlink inventory for each given path (plan: 0.15-2 dashboard
 * folder UX). Existing directory targets must be known folder-model entries,
 * including source-listed folders outside the configured roots. A dangling
 * target needs provenance: an exact seeded member line in the hub's managed
 * block. Existing files never become members, even when a managed line names
 * them. AGENTS.md is reserved for instructions and is never a member link.
 * Targets equal to or inside the hub are skipped, the same rule the scanner
 * uses for shortcuts. Links sort by name. Empty inventories are retained only
 * for source hubs and rows that already carried shortcut occurrences; probing
 * plain folders does not turn them into hubs.
 */
async function readHubLinks(
  paths: Iterable<string>,
  knownFolders: ReadonlyMap<string, FolderNature>,
  retainEmptyPaths: ReadonlySet<string> = new Set(),
): Promise<Map<string, HubLink[]>> {
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
    const agentsMarkdown = await readTextIfPresent(join(path, 'AGENTS.md')).catch(() => null);
    const links: HubLink[] = [];
    for (const entry of entries) {
      // AGENTS.md is hub instructions, never a member link. In particular,
      // do not unlink it if a user stores it as a symlink.
      if (!entry.isSymbolicLink() || entry.name === 'AGENTS.md') continue;
      try {
        const lexical = resolve(path, await readlink(join(path, entry.name)));
        let targetStats: Stats;
        try {
          targetStats = await stat(lexical);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
          // An absent target is a member only when the exact line this module
          // seeded proves it. The lexical path is retained for removal and
          // for the missing member row.
          const nature = managedMemberNature(agentsMarkdown ?? '', entry.name);
          if (nature === undefined || lexical === hubCanonical || isInside(lexical, hubCanonical)) continue;
          links.push({ name: entry.name, target: lexical, nature, missing: true });
          continue;
        }
        // A target that exists but is not a directory is never a member. This
        // check must happen before any nature or provenance fallback.
        if (!targetStats.isDirectory()) continue;
        const target = await realpath(lexical);
        if (target === hubCanonical || isInside(target, hubCanonical)) continue;
        // Live targets need a known folder-model identity. Managed provenance
        // is reserved for the absent-target fallback below.
        const nature = knownFolders.get(target);
        if (nature === undefined) continue;
        links.push({ name: entry.name, target, nature, missing: false });
      } catch {
        // A link removed or replaced mid-probe (ENOENT, EINVAL): skip the
        // link, never the view.
      }
    }
    if (links.length > 0 || retainEmptyPaths.has(path)) {
      links.sort((a, b) => a.name.localeCompare(b.name));
      inventory.set(path, links);
    }
  }
  return inventory;
}

/** Effective hub metadata for one path: source-listed hubs only (their
 *  promise may precede the folder on disk). Pimote-built hubs carry no
 *  metadata here — their shape on disk is the contract (DR-064). */
interface HubMetadata {
  name: string;
  memberPaths: string[];
  sourceTags?: string[];
}

function sourceHubMetadata(sourceHubs: HubSourceEntry[]): Map<string, HubMetadata> {
  return new Map(sourceHubs.map((source) => [source.path, { name: source.name, memberPaths: source.memberPaths, sourceTags: source.tags }]));
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
 * entries (code and persona), source-listed repos/hubs, and source-listed
 * persona homes — never derived from repos alone. Pure construction:
 * classification and metadata come from explicit inputs.
 *
 * Hub facts follow the shape (DR-064): any row whose symlink inventory carries
 * member links gets `members` (the inventory) and `repos` (the code members'
 * git facts), whoever created the hub. Source metadata is the promise layer —
 * it fills `memberPaths` only until the folder materializes and the inventory
 * takes over. Rows get `missing` only when they are not scanned and verified
 * absent — orphaned curation overrides alone never make a row.
 *
 * Plain code rows known to the index carry their own repo facts in `repo`,
 * copied from the index cache (no git probe here). Hub rows keep membership in
 * `members` and the code members' git facts in `repos`; persona rows carry
 * neither repo fact.
 */
function mergedFolders(input: FolderViewInputs): FolderInfo[] {
  const scanned = collectScanEntries(input.tree);
  const byPath = new Map(input.repos.map((repo) => [repo.path, repo]));
  const hubs = sourceHubMetadata(input.sourceHubs);
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
    // Only probed paths carry `members`; the probe skipped absent paths.
    const memberLinks = input.hubLinks.get(path);
    // Membership: the symlink inventory when probed (the shape), else the
    // source promise for not-yet-materialized source hubs.
    const memberPaths = memberLinks ? memberLinks.map((link) => link.target) : hub?.memberPaths;
    const isHub = hub !== undefined || (scan?.shortcutCount !== undefined && scan.shortcutCount > 0) || memberLinks !== undefined;
    // `repos` carries git facts for the code members only — persona members
    // have none. A code member absent from the index still gets the missing
    // placeholder.
    const memberNature = new Map(memberLinks?.map((link) => [link.target, link.nature] as const));
    const memberMissing = new Map(memberLinks?.map((link) => [link.target, link.missing] as const));
    const memberRepos: RepoInfo[] | undefined =
      memberPaths !== undefined
        ? memberPaths
            .filter((memberPath) => (memberNature.get(memberPath) ?? natures.get(memberPath)) !== 'persona')
            .map((memberPath) => {
              const knownRepo = byPath.get(memberPath);
              const linkMissing = memberMissing.get(memberPath);
              const base = knownRepo
                ? linkMissing === true
                  ? { ...knownRepo, missing: true }
                  : knownRepo
                : linkMissing === false
                  ? { path: memberPath, name: basename(memberPath), branch: null, dirty: false, ahead: 0, behind: 0 }
                  : missingRepo(memberPath);
              return { ...base, tags: repoTags(memberPath) };
            })
        : undefined;
    const folderMembers: FolderMemberInfo[] | undefined = memberLinks?.map((link) => ({
      path: link.target,
      name: link.name,
      nature: link.nature,
    }));
    // Hub rows implicitly inherit their members' tags.
    const memberTagUnion = memberRepos ? unionTags(...memberRepos.map((member) => member.tags)) : undefined;
    const nature = natures.get(path) ?? 'code';
    // Own repo facts for plain code rows: copied from the cached index facts
    // (effective tags like every other RepoInfo on a row). Personas and hub
    // rows omit `repo`.
    const ownRepo: RepoInfo | undefined = nature === 'code' && !isHub && repo ? { ...repo, tags: repoTags(path) } : undefined;
    rows.push({
      path,
      name: scan?.entry.name ?? hub?.name ?? repo?.name ?? basename(path),
      nature,
      ...(scan?.entry.persona ? { persona: scan.entry.persona } : sourcePersona ? { persona: sourcePersona.persona } : {}),
      // A probed inventory is authoritative, including an empty filtered
      // inventory. Fall back to scan/source promises only when unprobed.
      shortcutCount: memberLinks ? memberLinks.length : (scan?.shortcutCount ?? hub?.memberPaths.length ?? 0),
      favorite: override?.favorite ?? false,
      archived: override?.archived ?? false,
      // Effective tags: own user ∪ source-contributed, plus inherited member
      // tags for hubs; userTags is only the removable own-path subset.
      tags: (hub ? unionTags(userTags, hub.sourceTags, memberTagUnion) : unionTags(repo?.tags, sourcePersona?.tags, userTags, memberTagUnion)) ?? [],
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
 * The persistent user-owned curation layer over folder discovery: overrides
 * (favorite / archived / tags) keyed by canonical folder path, hub creation
 * (mkdir + symlinks + generated AGENTS.md + git init), membership mutations,
 * and change notifications. Hub facts follow the folder's shape — the symlink
 * inventory — not an ownership record (DR-064). Merges its state over the
 * scan's entries, the repo index, and registered sources. Persists as JSON
 * following the session-json-store pattern.
 */
/** The registry's folder-model seam: the sparse-tree report its views are
 *  built over. No manager tool reads the tree directly (DR-062 ruling:
 *  rows carry identity and membership). */
export interface FolderModelPort {
  /** Optional interruption hook — the caller races the cold walk
   *  (DR-072 race semantics in the repo index). */
  tree(signal?: AbortSignal): Promise<SparseTree>;
}

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
   * persona) plus source-listed repos/hubs, with curation overrides applied.
   * The optional signal is the caller's interruption hook: the caller races
   * the cold discovery walk in the repo index (DR-072) and rejects on abort
   * while the walk completes and fills the cache.
   */
  async list(signal?: AbortSignal): Promise<FolderInfo[]> {
    return sortFolders(await this.viewOver(await this.tree.tree(signal), await this.repos.list(signal)));
  }

  /**
   * The window path's view: rows with identity facts and any warm git
   * status, never blocked on git probes. Git facts fill in per served row
   * through `enrichRows`.
   */
  async listLazy(signal?: AbortSignal): Promise<FolderInfo[]> {
    return sortFolders(await this.viewOver(await this.tree.tree(signal), await this.repos.listLazy(signal)));
  }

  /** Request git facts for exactly these rows without delaying the caller. */
  requestStatusRefresh(rows: ReadonlyArray<FolderInfo>): Promise<void> {
    const paths = rows.flatMap((row) => [...(row.repo ? [row.repo.path] : []), ...(row.repos ?? []).map((repo) => repo.path)]);
    return this.repos.requestStatusRefresh(paths);
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
    const absent = await resolveAbsentPaths(repos, sourceHubMetadata(sourceHubs).keys());
    // Probe every included scan row. A hub whose member targets all vanished
    // has no shortcut occurrences left, but its managed lines still establish
    // membership for the dangling links. `readHubLinks` omits empty probes, so
    // ordinary folders do not become hubs.
    const sourceHubPaths = new Set(sourceHubMetadata(sourceHubs).keys());
    const probePaths = new Set(sourceHubPaths);
    const retainEmptyPaths = new Set(sourceHubPaths);
    for (const [path, row] of collectScanEntries(tree)) {
      probePaths.add(path);
      if (row.shortcutCount > 0) retainEmptyPaths.add(path);
    }
    const knownFolders = await resolveKnownFolderNatures(tree, repos, sourceHubs, personas);
    const hubLinks = await readHubLinks(probePaths, knownFolders, retainEmptyPaths);
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

      const [sourceHubs, tree, repos, personas] = await Promise.all([this.repos.listSourceHubs(), this.tree.tree(), this.repos.listLazy(), this.repos.listSourcePersonas()]);
      const hubs = sourceHubMetadata(sourceHubs);
      const scanned = collectScanEntries(tree);
      // Probe source hubs too: an on-disk inventory, including an empty
      // filtered inventory, supersedes a stale source member promise.
      // Keep this probe set aligned with viewOver: a hub with only dangling
      // managed members must still contribute its inventory to change targets.
      const sourceHubPaths = new Set(sourceHubs.map((hub) => hub.path));
      const probePaths = new Set(sourceHubPaths);
      const retainEmptyPaths = new Set(sourceHubPaths);
      for (const [path, row] of scanned) {
        probePaths.add(path);
        if (row.shortcutCount > 0) retainEmptyPaths.add(path);
      }
      const knownFolders = await resolveKnownFolderNatures(tree, repos, sourceHubs, personas);
      const inventory = await readHubLinks(probePaths, knownFolders, retainEmptyPaths);
      for (const [path, links] of inventory) {
        hubs.set(path, { name: basename(path), memberPaths: links.map((link) => link.target) });
      }
      const change = updateChangeTargets(patch, hubs);
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
   * Returns the canonical path; callers read the row from the shared view.
   */
  async createHub(input: { name: string; root: string; memberPaths: string[]; body?: string; description?: string; personaText?: string }): Promise<{ path: string }> {
    return this.serialized(async () => {
      const { name, root } = input;
      if (!isValidFolderName(name)) throw new Error(`Invalid folder name: ${name}`);
      const discovered = await this.discoveredNatures();
      const natures = new Map<string, FolderNature>();
      for (const memberPath of input.memberPaths) {
        const nature = await candidateFolderNature(memberPath, discovered);
        if (nature === undefined) throw new Error(`Unknown folder: ${memberPath}`);
        natures.set(memberPath, nature);
      }
      const memberPaths = [...input.memberPaths];
      // Two members with the same basename collide on one symlink target inside
      // the hub — reject up front so no partial hub is ever built.
      const seen = new Set<string>();
      for (const memberPath of memberPaths) {
        const base = basename(memberPath);
        if (base === 'AGENTS.md') throw new Error(`Reserved member name: ${base}`);
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
        canonicalTarget = await realpath(target);
      } catch (error) {
        // Never leave a half-built hub folder behind: it would block retry
        // (Directory already exists) — all-or-nothing.
        await rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      // No registry receipt (DR-064): the shape on disk is the hub's record.
      // Invalidate here so the next walk — not a persisted list — vouches for
      // the new row, then report the freshly materialized facts directly.
      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [canonicalTarget], removedPaths: [] });
      return { path: canonicalTarget };
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
      const nature = await candidateFolderNature(memberPath, await this.discoveredNatures());
      if (nature === undefined) throw new Error(`Unknown folder: ${memberPath}`);
      const name = basename(memberPath);
      if (name === 'AGENTS.md') throw new Error(`Reserved member name: ${name}`);
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
      try {
        await writeBack(agentsPath, agentsBefore, injectMemberLine(agentsBefore ?? '', seededMemberLine(name, nature)));
        if (ignoreBefore !== null) await writeBack(ignorePath, ignoreBefore, appendExactLine(ignoreBefore, memberIgnoreLine(name)));
      } catch (error) {
        for (const step of undo.reverse()) await step().catch(() => {});
        throw error;
      }

      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [hubPath], removedPaths: [] });
    });
  }

  /**
   * Remove a hub member (plan: 0.15-2 dashboard folder UX). The member link
   * must be in the current hub inventory: live links resolve to known folder
   * identities, and dangling links need an exact managed seed line. Unlinks
   * the hub-side symlink ONLY, never touches the member folder, and removes
   * the member's seeded line if present byte-exact. Broadcasts a folders_changed
   * delta like the other mutations.
   */
  async removeMember(hubPath: string, memberPath: string): Promise<void> {
    return this.serialized(async () => {
      // Same hub-eligibility gate as addMember: no symlink operations on a
      // path that is not a manageable hub, whatever a wire client sends.
      const hub = (await this.listLazy()).find((folder) => folder.path === hubPath);
      if (!hub) throw new Error(`Unknown hub folder: ${hubPath}`);
      if (!isManageableHub(hub)) throw new Error(`Not a hub folder: ${hubPath}`);
      // Membership is the same symlink inventory used by views. It retains
      // managed dangling links, while excluding files and unprovenance links.
      const knownFolders = await this.knownFolderNatures();
      const requestedTarget = (await canonicalDirectory(memberPath)) ?? resolve(memberPath);
      const link = (await readHubLinks([hubPath], knownFolders)).get(hubPath)?.find((candidate) => candidate.target === requestedTarget);
      if (!link) throw new Error(`Not a member of ${basename(hubPath)}: ${memberPath}`);

      // Unlink the hub-side symlink ONLY — the member folder is never touched.
      // readHubLinks excludes AGENTS.md, so instruction symlinks are never
      // mistaken for member links.
      await unlink(join(hubPath, link.name));
      // Try both seeded lines — both are exact strings this module's mutator
      // may have seeded before the member's nature changed.
      const name = link.name;
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
      this.repos.invalidateListing();
      this.fireChange({ changedPaths: [hubPath], removedPaths: [] });
    });
  }

  /** Everything list() shows — every path update() accepts. */
  private async knownFolderPaths(): Promise<Set<string>> {
    return new Set((await this.listLazy()).map((folder) => folder.path));
  }

  /** Resolve the current folder-model entries used by membership validation. */
  private async knownFolderNatures(): Promise<Map<string, FolderNature>> {
    const [tree, repos, sourceHubs, personas] = await Promise.all([this.tree.tree(), this.repos.listLazy(), this.repos.listSourceHubs(), this.repos.listSourcePersonas()]);
    return resolveKnownFolderNatures(tree, repos, sourceHubs, personas);
  }

  /** Canonical path → nature over every discovered folder-model entry
   *  (`discoveredEntryNatures`: scan entries plus source personas), plus
   *  every index and source-hub path as `code` when neither holds it. The
   *  widened membership rule: hub members are discovered entries (any nature,
   *  on disk or not), never arbitrary filesystem paths. */
  private async discoveredNatures(): Promise<Map<string, 'code' | 'persona'>> {
    const sourcePersonas = new Map((await this.repos.listSourcePersonas()).map((entry) => [entry.path, entry]));
    const natures = discoveredEntryNatures(collectScanEntries(await this.tree.tree()), sourcePersonas);
    for (const repo of await this.repos.listLazy()) {
      if (!natures.has(repo.path)) natures.set(repo.path, 'code');
    }
    for (const hub of await this.repos.listSourceHubs()) {
      if (!natures.has(hub.path)) natures.set(hub.path, 'code');
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
