import type { RepoInfo } from '../../shared/dist/index.js';
import type { ProjectSource } from './project-sources/index.js';

export interface RepoIndexOptions {
  /** How long a repo listing stays cached before the next list() re-walks. Default ~30s. */
  ttlMs?: number;
  /** How long per-repo git status (branch, dirty, ahead/behind) stays cached. */
  statusTtlMs?: number;
  /** Injectable monotonic clock in ms, for deterministic TTL behavior. */
  now?: () => number;
}

/**
 * Discovery over configured roots plus registered sources.
 *
 * Bounded-depth recursive walk (depth 3; skips node_modules, .git, dist,
 * build, target, .venv; does not follow symlinks except inside hub folders),
 * TTL-cached repo listing, and per-repo git status enrichment (branch, dirty,
 * ahead/behind) with its own TTL. Derived state only — no persistence.
 */
export class RepoIndex {
  constructor(
    private readonly _roots: string[],
    private readonly options: RepoIndexOptions = {},
  ) {}

  /** The configured root directories. */
  get roots(): string[] {
    return this._roots;
  }

  /**
   * List repos across all roots and registered sources, cached per TTL.
   * Paths that no longer exist are marked `missing: true` rather than dropped.
   */
  async list(): Promise<RepoInfo[]> {
    void this.options;
    throw new Error('not implemented');
  }

  /** Drop cached listings so the next list() re-walks. */
  invalidate(): void {
    throw new Error('not implemented');
  }

  /** Register an additional discovery source; its repos join future listings. */
  registerSource(source: ProjectSource): void {
    void source;
    throw new Error('not implemented');
  }
}
