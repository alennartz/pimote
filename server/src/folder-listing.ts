/**
 * The folder listing service — the seam between ws-handler and the folder
 * model where everything about _which folders, in what order, which slice_
 * lives behind a small interface. Dependencies: the folder registry's row
 * listing (merged scan + curation, TTL-cached at the repo-index boundary) and
 * `SessionSummaryIndex` for session-derived metadata (recency + search text).
 *
 * Internals (not part of this surface): a server-wide session-derived metadata
 * cache (folder → lastActivity, folder → searchable session text;
 * stale-while-revalidate on a TTL, invalidated by session events), order
 * snapshots (pins) keyed by token, and the monotonic epoch. Discovery caching
 * stays at the repo-index adapter boundary — this module caches derived
 * metadata and orderings, never scan results.
 */
import type { FolderInfo, FoldersChangedEvent } from '../../shared/dist/index.js';
import type { SessionSummaryIndex } from './session-summaries.js';

/** Everything the listing needs from the live in-memory sessions. */
export interface LiveSessionRef {
  folderPath: string | null;
}

export interface FolderListingDeps {
  /** The folder registry's row listing (merged scan + curation). */
  listRows(): Promise<FolderInfo[]>;
  /** Session-derived metadata source: the batched summary pass over known
   *  folder paths, reusing the per-file summary cache. */
  sessionSummaries: Pick<SessionSummaryIndex, 'listMany'>;
  /** Live in-memory sessions, folded into lastActivity at pin/query time and
   *  used for session-count enrichment on delta rows. */
  listLiveSessions(): ReadonlyArray<LiveSessionRef>;
}

/** A pinned order; referenced by window queries. */
export interface FolderPin {
  token: string;
  epoch: number;
}

export interface FolderQueryRequest {
  /** Omitted/unknown/expired → the service transparently re-pins and serves
   *  the window under the new token. */
  token?: string;
  /** Window start into the pinned (optionally filtered) order; default 0. */
  offset?: number;
  /** Window size; default 100, clamped to [1, 200]. */
  limit?: number;
  /** Two-tier search over the full set, case-insensitive substring. */
  query?: string;
  /** Default false. */
  includeArchived?: boolean;
}

export interface FolderQueryResult {
  /** One window of the pinned (optionally filtered) order. */
  rows: FolderInfo[];
  /** Matches under query + includeArchived, over the whole set. */
  total: number;
  more: boolean;
  /** Token this window was served under (client adopts it). */
  orderToken: string;
  /** Epoch observed at computation time. */
  epoch: number;
}

export interface FolderListingService {
  /** Pin the current order — an ordered snapshot of canonical folder paths from
   *  the rows and session-derived metadata at this moment:
   *  `favorite desc → lastActivity desc → name asc → path asc` (path is the
   *  deterministic tiebreak stable pagination needs). The pin holds _order
   *  only_ — row data is re-resolved from the registry at query time, so
   *  curation edits are never stale against an old pin. Pins live for the
   *  connection and are garbage-collected on close (plus a TTL sweep for
   *  orphaned tokens). */
  pin(): Promise<FolderPin>;

  /** Serve one window under a pin. `query` filters the full pinned order —
   *  never loaded rows only — with two OR'd, case-insensitive substring tiers:
   *  the folder tier matches display name (persona name if present, else folder
   *  name), name, path, tags and returns the row without `matchedSessionIds`;
   *  the session tier matches session `name`/`firstMessage` and returns
   *  `matchedSessionIds` with just the matched session ids. Filter then slice:
   *  `total` is the post-filter count over the whole set; the window is
   *  `[offset, offset+limit)` of the filtered order. `includeArchived` defaults
   *  to false. `lastActivity` folds in live in-memory sessions at query time,
   *  so actively-running folders rank as most-recent regardless of file-flush
   *  cadence. */
  query(req: FolderQueryRequest): Promise<FolderQueryResult>;

  /** Build the `folders_changed` delta for a mutation: each mutation site
   *  reports the paths it touched (no diffing machinery — mutations know their
   *  targets); changed rows are re-resolved from the registry (full `FolderInfo`
   *  + session-count enrichment) and `removedPaths` is passed through for
   *  deletions/disbands. Every returned event bumps the monotonic epoch. */
  buildDelta(changedPaths: string[], removedPaths: string[]): Promise<FoldersChangedEvent>;

  /** Invalidate the session-derived metadata cache for the given folder paths
   *  (all of them when omitted) — called from the session event sites (rename,
   *  delete, archive toggle, state change); TTL refresh is internal. */
  invalidateSessionMetadata(folderPaths?: string[]): void;
}

export class FolderListing implements FolderListingService {
  constructor(private readonly deps: FolderListingDeps) {}

  pin(): Promise<FolderPin> {
    throw new Error('not implemented');
  }

  query(_req: FolderQueryRequest): Promise<FolderQueryResult> {
    throw new Error('not implemented');
  }

  buildDelta(_changedPaths: string[], _removedPaths: string[]): Promise<FoldersChangedEvent> {
    throw new Error('not implemented');
  }

  invalidateSessionMetadata(_folderPaths?: string[]): void {
    throw new Error('not implemented');
  }
}
