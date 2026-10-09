import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RepoInfo } from '../../shared/dist/index.js';
import type { HubSourceEntry, FolderSource, RepoSourceEntry, SourceEntry } from './folder-sources/index.js';
import { classifyFolder, nodeFolderFs, scanFolderModel, type FolderEntry, type FolderOccurrence, type PersonaInfo, type SparseTree } from './folder-model/index.js';
import { getGitBranch } from './git-branch.js';
import { materializeHubFolder } from './folder-sources/materialize.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TTL_MS = 30_000;

/** Per-repo git status, cached on its own TTL. */
interface RepoStatus {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  at: number;
}

/** One completed walk's stamp; kept as the cached listing until invalidated. */
interface ListingStamp {
  entries: RepoInfo[];
  at: number;
}

export interface RepoIndexOptions {
  /** How long a repo listing stays cached before the next list() re-walks. Default ~30s. */
  ttlMs?: number;
  /** How long per-repo git status (branch, dirty, ahead/behind) stays cached. */
  statusTtlMs?: number;
  /** Injectable monotonic clock in ms, for deterministic TTL behavior. */
  now?: () => number;
}

/** Run git in a directory; resolve trimmed stdout, or null on any failure. */
function gitRunner(cwd: string): (args: string[]) => Promise<string | null> {
  // Guard against inherited Git env vars forcing resolution to another repo.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  return async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf-8', timeout: 2000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
}

function parseCount(output: string | null): number {
  const value = Number.parseInt(output ?? '', 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The scanner-to-repo adapter: every unique canonical code entry across the
 * whole occurrence tree — scan reaches, shortcut targets outside the roots,
 * discovered hubs — keyed by its canonical path. Persona entries are dropped
 * even when they contain git; occurrence reach paths never identify a repo.
 */
function collectCodeEntries(tree: SparseTree): FolderEntry[] {
  const byPath = new Map<string, FolderEntry>();
  const visit = (occurrence: FolderOccurrence): void => {
    if (occurrence.entry.nature === 'code') byPath.set(occurrence.entry.path, occurrence.entry);
    for (const child of occurrence.children) visit(child);
  };
  for (const occurrence of tree.occurrences) visit(occurrence);
  return [...byPath.values()];
}

/** Union of two tag lists; undefined when both are absent (keeps the wire clean). */
function mergeTags(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

/**
 * A source-listed folder that is a persona home. Never a repo — persona
 * folders are excluded from the repo view — but never invisible either: the
 * folder view surfaces it as a persona row.
 */
export interface PersonaSourceEntry {
  path: string;
  persona: PersonaInfo;
  /** Source-contributed tags, carried over to the folder row. */
  tags?: string[];
}

/** Branch, dirty flag, and ahead/behind for one repo. Failed probes yield neutral values. */
async function readGitStatus(cwd: string): Promise<Omit<RepoStatus, 'at'>> {
  const git = gitRunner(cwd);
  const [branch, porcelain, upstream] = await Promise.all([getGitBranch(cwd), git(['status', '--porcelain']), git(['rev-parse', '--abbrev-ref', '@{upstream}'])]);

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [aheadOutput, behindOutput] = await Promise.all([git(['rev-list', '--count', `${upstream}..HEAD`]), git(['rev-list', '--count', `HEAD..${upstream}`])]);
    ahead = parseCount(aheadOutput);
    behind = parseCount(behindOutput);
  }

  return { branch, dirty: porcelain !== null && porcelain.length > 0, ahead, behind };
}

/**
 * Discovery over configured roots plus registered sources.
 *
 * Discovery consumes the folder-model sparse scan (`scanFolderModel`): every
 * unique canonical code folder across all occurrences becomes one repo entry
 * — scan reaches, shortcut targets outside the roots, and hub folders alike —
 * while persona folders are excluded even when they contain git (for scanned
 * and source-contributed paths alike: a persona home is never a repo).
 * Descent stops at included folders, so nested repos inside a repo are never
 * crawled. TTL-cached repo listing, and per-repo git status enrichment (branch,
 * dirty, ahead/behind) with its own TTL. Expired caches are served stale while
 * a background refresh runs (see `list()`). Derived state only — no
 * persistence.
 */
export class RepoIndex {
  private readonly ttlMs: number;
  private readonly statusTtlMs: number;
  private readonly now: () => number;
  private readonly sources: FolderSource[] = [];
  private listing: ListingStamp | null = null;
  private sourceHubs: { entries: HubSourceEntry[]; at: number } | null = null;
  private personaSources: PersonaSourceEntry[] = [];
  private readonly statusCache = new Map<string, RepoStatus>();
  private listingPromise: Promise<ListingStamp> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private onRefreshed: ((change: { changedPaths: string[]; removedPaths: string[] }) => void) | null = null;
  private walkGeneration = 0;

  constructor(
    private readonly _roots: string[],
    private readonly options: RepoIndexOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.statusTtlMs = options.statusTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The configured root directories. */
  get roots(): string[] {
    return this._roots;
  }

  /**
   * List repos across all roots and registered sources, cached per TTL.
   * Paths that no longer exist are marked `missing: true` rather than dropped.
   *
   * Stale-while-revalidate: an expired cache is served immediately — walking
   * the roots and re-probing git status costs ~0.5s, and a dashboard load
   * should not wait on it — while a background refresh repopulates both the
   * listing and the status cache. The refresh notifies `onRefreshed` only if
   * the recomputed view differs from what was served, so clients get a
   * `folders_changed` broadcast on real changes (new repo, branch switch,
   * dirty state) without a fixed refresh cadence. Only a cold cache (first
   * list, or after `invalidate()`) blocks on the walk.
   */
  async list(): Promise<RepoInfo[]> {
    const cached = this.listing;
    if (cached) {
      if (this.now() - cached.at >= this.ttlMs || cached.entries.some((entry) => this.statusExpired(entry))) this.kickRefresh();
      return await Promise.all(cached.entries.map((entry) => this.resolveServed(entry)));
    }
    // Cold path: join or start the walk — but never serve a walk whose stamp
    // was invalidated mid-flight. `invalidate()` nulls the stamp, and the
    // contract is that the next `list()` re-walks, even when it joined the
    // walk that was already running. Invalidations are user-action driven, so
    // the loop converges on the fresh state.
    for (;;) {
      await this.discover();
      const listing = this.listing;
      if (listing) return await Promise.all(listing.entries.map((entry) => this.resolveServed(entry)));
    }
  }

  /**
   * Register the stale-serve notification: fired after a background refresh
   * completes, and only when the refreshed view changed.
   */
  setOnRefreshed(cb: (change: { changedPaths: string[]; removedPaths: string[] }) => void): void {
    this.onRefreshed = cb;
  }

  /** Await the in-flight background refresh, if any (tests, diagnostics). */
  async whenRefreshed(): Promise<void> {
    await this.refreshInFlight;
  }

  /** Single-flight full re-scan; shared by cold lists and background refreshes. */
  private discover(): Promise<ListingStamp> {
    if (!this.listingPromise) {
      const generation = this.walkGeneration;
      this.listingPromise = this.discoverAndStamp()
        .then((stamp) => {
          if (generation !== this.walkGeneration && this.listing === stamp) {
            // invalidate() ran while this walk was in flight — its stamp is
            // stale, so the next list() must re-walk. Only our own stamp is
            // discarded; a newer walk's stamp survives.
            this.listing = null;
          }
          return stamp;
        })
        .finally(() => {
          this.listingPromise = null;
        });
    }
    return this.listingPromise;
  }

  /**
   * Refresh the expired listing/status caches off the request path. Single-
   * flight: repeated stale list() calls share one walk + git-probe burst.
   */
  private kickRefresh(): void {
    if (this.refreshInFlight) return;
    const before = this.snapshot();
    this.refreshInFlight = (async () => {
      try {
        if (!this.listing || this.now() - this.listing.at >= this.ttlMs) await this.discover();
        const listing = this.listing;
        if (listing) await Promise.all(listing.entries.map((entry) => this.refreshStatus(entry)));
      } catch (error) {
        console.warn('[repo-index] background refresh failed', error);
      } finally {
        this.refreshInFlight = null;
      }
      if (this.snapshot() !== before) this.onRefreshed?.({ changedPaths: [], removedPaths: [] }); // implementation phase: report refreshed path changes
    })();
  }

  /** Whether a served entry's status is due for a probe (missing or past its TTL). */
  private statusExpired(entry: RepoInfo): boolean {
    if (entry.missing) return false;
    const cached = this.statusCache.get(entry.path);
    return !cached || this.now() - cached.at >= this.statusTtlMs;
  }

  /** Probe statuses that are stale or missing; fresh ones are left alone. */
  private async refreshStatus(entry: RepoInfo): Promise<void> {
    if (!this.statusExpired(entry)) return;
    await this.probeStatus(entry.path);
  }

  /**
   * Content-only fingerprint of everything this index serves (timestamps
   * excluded) — a background refresh that reproduces it changed nothing and
   * must not notify.
   */
  private snapshot(): string {
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    const statuses = [...this.statusCache.entries()]
      .map(([path, status]) => ({ path, branch: status.branch, dirty: status.dirty, ahead: status.ahead, behind: status.behind }))
      .sort(byPath);
    return JSON.stringify({
      listing: this.listing ? [...this.listing.entries].sort(byPath) : null,
      sourceHubs: this.sourceHubs ? [...this.sourceHubs.entries].sort(byPath) : null,
      personaSources: [...this.personaSources].sort(byPath),
      statuses,
    });
  }

  /**
   * Hub folders contributed by registered sources, cached with the same
   * TTL as the repo listing. Derived, never persisted — if a source stops
   * listing an entry, it disappears from the folder layer. `list()` owns the
   * staleness policy (serve stale + background refresh), so this just awaits it.
   */
  async listSourceHubs(): Promise<HubSourceEntry[]> {
    await this.list();
    return this.sourceHubs?.entries ?? [];
  }

  /**
   * Persona-natured source folders (kept out of the repo listing), cached with
   * the listing. Derived, never persisted — the folder view uses them to
   * surface persona homes as persona rows instead of dropping them.
   */
  async listSourcePersonas(): Promise<PersonaSourceEntry[]> {
    await this.list();
    return this.personaSources;
  }

  /**
   * Fan one open attempt out to every source's onFolderOpen hook, awaited in
   * registration order. Sources self-filter by path (probe the disk, scaffold
   * if the entry is theirs and missing). The first thrown error aborts the
   * open and surfaces to the caller.
   */
  async runOpenHooks(folderPath: string): Promise<void> {
    // Standard-layout materialization: an open of a source-listed hub
    // whose folder doesn't exist gets the pimote layout (symlinks to
    // members + AGENTS.md) built from the server's own code — user sources
    // never replicate the convention. Dangling member symlinks are fine and
    // self-heal when a member materializes.
    const hubs = await this.listSourceHubs();
    const entry = hubs.find((hub) => hub.path === folderPath);
    if (entry) {
      try {
        await stat(folderPath);
      } catch {
        await materializeHubFolder(entry);
      }
    }

    for (const source of this.sources) {
      if (!source.onFolderOpen) continue;
      await source.onFolderOpen(folderPath);
    }
  }

  /** Drop cached listings so the next list() re-walks. */
  invalidate(): void {
    this.listing = null;
    this.walkGeneration++;
    this.statusCache.clear();
  }

  /** Register an additional discovery source; its repos join future listings. */
  registerSource(source: FolderSource): void {
    this.sources.push(source);
  }

  /** Fresh discovery: scan the folder model, merge source contributions, mark vanished paths. */
  private async discoverAndStamp(): Promise<ListingStamp> {
    const byPath = new Map<string, RepoInfo>();
    const tree = await scanFolderModel({
      roots: this._roots,
      onWarning: (warning) => console.warn(`[repo-index] scan warning at ${warning.path}`, warning.error),
    });
    for (const entry of collectCodeEntries(tree)) {
      byPath.set(entry.path, { path: entry.path, name: entry.name, branch: null, dirty: false, ahead: 0, behind: 0 });
    }

    const sourceHubs: HubSourceEntry[] = [];
    const personaSources: PersonaSourceEntry[] = [];
    const seenHubPaths = new Set<string>();
    for (const source of this.sources) {
      let contributed: SourceEntry[];
      try {
        contributed = await source.list();
      } catch (error) {
        console.warn(`[repo-index] source "${source.id}" failed; skipping its entries`, error);
        continue;
      }
      for (const raw of contributed) {
        // Tolerate ergonomic modules that return bare repo shapes without a kind.
        let entry: SourceEntry;
        if ('kind' in raw && raw.kind === 'hub') {
          entry = raw;
        } else {
          const repo = raw as RepoSourceEntry;
          const { kind: _kind, ...repoFields } = repo;
          entry = { kind: 'repo', ...repoFields };
        }
        if (entry.kind === 'hub') {
          if (!seenHubPaths.has(entry.path)) {
            seenHubPaths.add(entry.path);
            sourceHubs.push(entry);
          }
          continue;
        }
        const existing = byPath.get(entry.path);
        if (existing) {
          // A scanned path still surfaces the source's tags and lastActivity —
          // exactly like the same source's out-of-tree paths do. The scan row
          // wins on identity and git fields.
          byPath.set(entry.path, {
            ...existing,
            tags: mergeTags(existing.tags, entry.tags),
            lastActivity: existing.lastActivity ?? entry.lastActivity,
          });
          continue;
        }
        // Persona taxonomy: a persona home is never a repo, however it is
        // listed. Scanned paths already dropped their personas; unscanned
        // source paths are classified here. Missing paths classify as code and
        // keep their placeholder row.
        const classification = await classifyFolder(nodeFolderFs, entry.path);
        if (classification.nature === 'persona') {
          // Not a repo — but a folder of interest: keep it for the folder view.
          personaSources.push({ path: entry.path, persona: classification.persona ?? { name: entry.name }, tags: entry.tags });
          continue;
        }
        byPath.set(entry.path, entry);
      }
    }
    this.sourceHubs = { entries: sourceHubs, at: this.now() };
    this.personaSources = personaSources;

    const entries: RepoInfo[] = [];
    for (const repo of byPath.values()) {
      entries.push(await this.markMissing(repo));
    }
    const stamp: ListingStamp = { entries, at: this.now() };
    this.listing = stamp;
    return stamp;
  }

  /** A path that no longer stats is kept, marked `missing`, with its entry values untouched. */
  private async markMissing(repo: RepoInfo): Promise<RepoInfo> {
    try {
      await stat(repo.path);
    } catch {
      return { ...repo, missing: true };
    }
    return repo;
  }

  /** Every served entry: missing ones pass through, existing ones get git status. */
  private async resolveServed(base: RepoInfo): Promise<RepoInfo> {
    if (base.missing) return base;
    return await this.withStatus(base);
  }

  /**
   * Serve git status from cache regardless of age — staleness is handled by
   * `kickRefresh` in `list()`, not on the request path. Only a missing entry
   * (first probe ever) blocks, because there is nothing stale to serve yet.
   */
  private async withStatus(base: RepoInfo): Promise<RepoInfo> {
    const cached = this.statusCache.get(base.path);
    const status = cached ?? (await this.probeStatus(base.path));
    return { ...base, branch: status.branch, dirty: status.dirty, ahead: status.ahead, behind: status.behind };
  }

  private async probeStatus(path: string): Promise<RepoStatus> {
    const status = await readGitStatus(path);
    const entry: RepoStatus = { ...status, at: this.now() };
    this.statusCache.set(path, entry);
    return entry;
  }
}
