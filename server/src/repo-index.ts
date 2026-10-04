import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RepoInfo } from '../../shared/dist/index.js';
import type { MultiRepoSourceEntry, ProjectSource, RepoSourceEntry, SourceEntry } from './project-sources/index.js';
import { scanFolderModel, type FolderEntry, type FolderOccurrence, type SparseTree } from './folder-model/index.js';
import { getGitBranch } from './git-branch.js';
import { materializeMultiRepoFolder } from './project-sources/materialize.js';

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
 * while persona folders are excluded even when they contain git. Descent
 * stops at included folders, so nested repos inside a repo are never crawled.
 * TTL-cached repo listing, and per-repo git status enrichment (branch, dirty,
 * ahead/behind) with its own TTL. Expired caches are served stale while a
 * background refresh runs (see `list()`). Derived state only — no persistence.
 */
export class RepoIndex {
  private readonly ttlMs: number;
  private readonly statusTtlMs: number;
  private readonly now: () => number;
  private readonly sources: ProjectSource[] = [];
  private listing: { entries: RepoInfo[]; at: number } | null = null;
  private sourceProjects: { entries: MultiRepoSourceEntry[]; at: number } | null = null;
  private readonly statusCache = new Map<string, RepoStatus>();
  private listingPromise: Promise<RepoInfo[]> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private onRefreshed: (() => void) | null = null;
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
   * `projects_changed` broadcast on real changes (new repo, branch switch,
   * dirty state) without a fixed refresh cadence. Only a cold cache (first
   * list, or after `invalidate()`) blocks on the walk.
   */
  async list(): Promise<RepoInfo[]> {
    const cached = this.listing;
    if (cached) {
      if (this.now() - cached.at >= this.ttlMs || cached.entries.some((entry) => this.statusExpired(entry))) this.kickRefresh();
      return await Promise.all(cached.entries.map((entry) => this.resolveServed(entry)));
    }
    const base = await this.discover();
    return await Promise.all(base.map((entry) => this.resolveServed(entry)));
  }

  /**
   * Register the stale-serve notification: fired after a background refresh
   * completes, and only when the refreshed view changed.
   */
  setOnRefreshed(cb: () => void): void {
    this.onRefreshed = cb;
  }

  /** Await the in-flight background refresh, if any (tests, diagnostics). */
  async whenRefreshed(): Promise<void> {
    await this.refreshInFlight;
  }

  /** Single-flight full re-scan; shared by cold lists and background refreshes. */
  private discover(): Promise<RepoInfo[]> {
    if (!this.listingPromise) {
      const generation = this.walkGeneration;
      this.listingPromise = this.discoverAndStamp()
        .then((entries) => {
          if (generation !== this.walkGeneration) {
            // invalidate() ran while this walk was in flight - its stamp is
            // stale, so the next list() must re-walk.
            this.listing = null;
          }
          return entries;
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
      if (this.snapshot() !== before) this.onRefreshed?.();
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
      sourceProjects: this.sourceProjects ? [...this.sourceProjects.entries].sort(byPath) : null,
      statuses,
    });
  }

  /**
   * Multi-repo projects contributed by registered sources, cached with the same
   * TTL as the repo listing. Derived, never persisted — if a source stops
   * listing an entry, it disappears from the project layer. `list()` owns the
   * staleness policy (serve stale + background refresh), so this just awaits it.
   */
  async listSourceProjects(): Promise<MultiRepoSourceEntry[]> {
    await this.list();
    return this.sourceProjects?.entries ?? [];
  }

  /**
   * Fan one open attempt out to every source's onProjectOpen hook, awaited in
   * registration order. Sources self-filter by path (probe the disk, scaffold
   * if the entry is theirs and missing). The first thrown error aborts the
   * open and surfaces to the caller.
   */
  async runOpenHooks(projectPath: string): Promise<void> {
    // Standard-layout materialization: an open of a source-listed multi-repo
    // project whose folder doesn't exist gets the pimote layout (symlinks to
    // members + AGENTS.md) built from the server's own code — user sources
    // never replicate the convention. Dangling member symlinks are fine and
    // self-heal when a member materializes.
    const projects = await this.listSourceProjects();
    const entry = projects.find((project) => project.path === projectPath);
    if (entry) {
      try {
        await stat(projectPath);
      } catch {
        await materializeMultiRepoFolder(entry);
      }
    }

    for (const source of this.sources) {
      if (!source.onProjectOpen) continue;
      await source.onProjectOpen(projectPath);
    }
  }

  /** Drop cached listings so the next list() re-walks. */
  invalidate(): void {
    this.listing = null;
    this.walkGeneration++;
    this.statusCache.clear();
  }

  /** Register an additional discovery source; its repos join future listings. */
  registerSource(source: ProjectSource): void {
    this.sources.push(source);
  }

  /** Fresh discovery: scan the folder model, merge source contributions, mark vanished paths. */
  private async discoverAndStamp(): Promise<RepoInfo[]> {
    const byPath = new Map<string, RepoInfo>();
    const tree = await scanFolderModel({
      roots: this._roots,
      onWarning: (warning) => console.warn(`[repo-index] scan warning at ${warning.path}`, warning.error),
    });
    for (const entry of collectCodeEntries(tree)) {
      byPath.set(entry.path, { path: entry.path, name: entry.name, branch: null, dirty: false, ahead: 0, behind: 0 });
    }

    const sourceProjects: MultiRepoSourceEntry[] = [];
    const seenProjectPaths = new Set<string>();
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
        if ('kind' in raw && raw.kind === 'project') {
          entry = raw;
        } else {
          const repo = raw as RepoSourceEntry;
          const { kind: _kind, ...repoFields } = repo;
          entry = { kind: 'repo', ...repoFields };
        }
        if (entry.kind === 'project') {
          if (!seenProjectPaths.has(entry.path)) {
            seenProjectPaths.add(entry.path);
            sourceProjects.push(entry);
          }
          continue;
        }
        if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
      }
    }
    this.sourceProjects = { entries: sourceProjects, at: this.now() };

    const entries: RepoInfo[] = [];
    for (const repo of byPath.values()) {
      entries.push(await this.markMissing(repo));
    }
    this.listing = { entries, at: this.now() };
    return entries;
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
