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
import { randomUUID } from 'node:crypto';
import type { SessionSummary, SessionSummaryIndex } from './session-summaries.js';
import { enrichActiveSessionCounts } from './folder-registry.js';

/** Everything the listing needs from the live in-memory sessions. */
export interface LiveSessionRef {
  folderPath: string | null;
}

export interface FolderListingDeps {
  /** The folder registry's row listing (merged scan + curation): identity
   *  facts and any warm git status — never blocked on git probes. */
  listRows(): Promise<FolderInfo[]>;
  /** Git status for exactly these rows (bounded probes): served windows and
   *  delta rows carry status facts; nothing else waits on probes. */
  enrichRows(rows: FolderInfo[]): Promise<void>;
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
  /** Unknown/expired/cross-owner tokens transparently re-pin. Omitted tokens
   *  reuse the connection's pin, or create one for standalone callers. */
  token?: string;
  /** Owner of the pin; standalone callers may omit it. */
  connectionId?: string;
  /** Force a fresh order for an explicit refresh. */
  repin?: boolean;
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
  /** Metadata scans are background-only. Cold calls use empty activity; refresh
   * failures retain the last good snapshot and never fail pin/query. Completion
   * affects fresh pins only; registry failures propagate.
   * Pin the current order — an ordered snapshot of canonical folder paths from
   *  the rows and session-derived metadata at this moment:
   *  `favorite desc → lastActivity desc → name asc → path asc` (path is the
   *  deterministic tiebreak stable pagination needs). The pin holds _order
   *  only_ — row data is re-resolved from the registry at query time, so
   *  curation edits are never stale against an old pin. Pins live for the
   *  connection and are garbage-collected on close (plus a TTL sweep for
   *  orphaned tokens). */
  pin(connectionId?: string): Promise<FolderPin>;

  /** Release every pin owned by the closed connection, including pending
   *  pins. Release is final: a folder command racing the close can no longer
   *  attach owned pins to this connection. */
  releaseConnection(connectionId: string): void;

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
   *  + session-count enrichment). Resolvable paths become changed rows and
   *  absent paths become removals. Every returned event bumps the epoch. */
  buildDelta(changedPaths: string[], removedPaths: string[]): Promise<FoldersChangedEvent>;

  /** Invalidate the session-derived metadata cache for the given folder paths
   *  (all of them when omitted) — called from the session event sites (rename,
   *  delete, archive toggle, state change); TTL refresh is internal. */
  invalidateSessionMetadata(folderPaths?: string[]): void;
}

interface SessionMetadata {
  readonly lastActivity: number;
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

interface OrderSnapshot {
  readonly token: string;
  readonly owner?: string;
  readonly paths: readonly string[];
  readonly expiresAt: number;
}

interface ConnectionPin {
  generation: number;
  token?: string;
  pending?: Promise<FolderPin>;
  /** Set by releaseConnection as a tombstone: the entry survives the close so
   *  a command racing it can never re-create owned state for the dead
   *  connection. Swept with the orphan pins after the same TTL. */
  released?: boolean;
  releasedAt?: number;
}

const METADATA_TTL_MS = 30_000;
const ORPHAN_PIN_TTL_MS = 30 * 60_000;

function projectMetadata(summaries: ReadonlyMap<string, SessionSummary[]>): ReadonlyMap<string, SessionMetadata> {
  return new Map(
    Array.from(summaries, ([path, sessions]) => [
      path,
      {
        lastActivity: Math.max(0, ...sessions.map((session) => session.modified.getTime())),
        sessions: sessions.map((session) => ({
          id: session.id,
          text: `${session.name ?? ''}\n${session.firstMessage ?? ''}`.toLowerCase(),
        })),
      },
    ]),
  );
}

function orderedPaths(rows: readonly FolderInfo[], metadata: ReadonlyMap<string, SessionMetadata>, live: ReadonlyArray<LiveSessionRef>): readonly string[] {
  const activePaths = new Set(live.map((session) => session.folderPath));
  const activity = (path: string): number => (activePaths.has(path) ? Number.MAX_SAFE_INTEGER : (metadata.get(path)?.lastActivity ?? 0));
  return [...rows]
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || activity(b.path) - activity(a.path) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .map((row) => row.path);
}

function matchRow(row: FolderInfo, metadata: SessionMetadata | undefined, query: string): FolderInfo | undefined {
  const { matchedSessionIds: _annotation, ...copy } = row;
  // Served rows carry the ordering fact so the client re-sort mirrors the
  // pinned order before lazy session lists land; absent when no activity.
  const annotated: FolderInfo = metadata?.lastActivity ? { ...copy, lastActivity: metadata.lastActivity } : copy;
  const folderText = [row.persona?.name ?? row.name, row.name, row.path, ...row.tags];
  if (!query || folderText.some((text) => text.toLowerCase().includes(query))) return annotated;
  const ids = metadata?.sessions.filter((session) => session.text.includes(query)).map((session) => session.id) ?? [];
  return ids.length ? { ...annotated, matchedSessionIds: ids } : undefined;
}

function normalizeWindow(offset: number | undefined, limit: number | undefined): { offset: number; limit: number } {
  return {
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset!)) : 0,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit!))) : 100,
  };
}

export class FolderListing implements FolderListingService {
  private metadata: ReadonlyMap<string, SessionMetadata> = new Map();
  private lastRefreshAttempt = Number.NEGATIVE_INFINITY;
  private lastRefreshVersion = -1;
  private refreshPending?: Promise<void>;
  private invalidationVersion = 0;
  private refreshAll = true;
  private readonly invalidatedPaths = new Set<string>();
  private readonly pins = new Map<string, OrderSnapshot>();
  private readonly connections = new Map<string, ConnectionPin>();
  private epoch = 0;

  constructor(private readonly deps: FolderListingDeps) {}

  pin(connectionId?: string): Promise<FolderPin> {
    this.sweepOrphans();
    const connection = connectionId === undefined ? undefined : this.connectionPin(connectionId);
    // A released connection can never own pins again: a command that races
    // cleanup() gets an orphan (TTL-swept) instead of a leaked owned pin.
    const owner = connection?.released ? undefined : connectionId;
    const track = connection?.released ? undefined : connection;
    const generation = track ? ++track.generation : 0;
    const pending = this.createPin(owner, track, generation).catch((error: unknown) => {
      if (track?.generation === generation) track.pending = undefined;
      throw error;
    });
    if (track) track.pending = pending;
    return pending;
  }

  releaseConnection(connectionId: string): void {
    // Tombstone instead of delete: a folder command in flight when the socket
    // closes re-enters through connectionPin() afterwards and must not
    // re-create owned state — one leaked OrderSnapshot can hold thousands of
    // paths. The tombstone is swept with the orphan pins.
    const connection = this.connections.get(connectionId) ?? { generation: 0 };
    connection.released = true;
    connection.releasedAt = Date.now();
    connection.token = undefined;
    connection.pending = undefined;
    this.connections.set(connectionId, connection);
    for (const [token, snapshot] of this.pins) {
      if (snapshot.owner === connectionId) this.pins.delete(token);
    }
  }

  async query(req: FolderQueryRequest): Promise<FolderQueryResult> {
    // Capture before any asynchronous work. A later delta cannot make this
    // computation claim that it observed the delta's row changes.
    const epoch = this.epoch;
    let pin = await this.selectPin(req);
    let snapshot = this.pins.get(pin.token);
    for (let attempt = 0; attempt < 2 && !snapshot; attempt += 1) {
      // A pending pin superseded before its registration resolves to a dead
      // token. The pin contract treats an unknown token as a transparent
      // re-pin — never as an empty success window.
      pin = await this.pin(req.connectionId);
      snapshot = this.pins.get(pin.token);
    }
    const metadata = this.metadata;
    const currentRows = await this.deps.listRows();
    this.scheduleRefresh(currentRows);
    const byPath = new Map(currentRows.map((row) => [row.path, row]));
    const query = (req.query ?? '').toLowerCase();
    const matches = (snapshot?.paths ?? []).flatMap((path) => {
      const row = byPath.get(path);
      if (!row || (row.archived && !req.includeArchived)) return [];
      const match = matchRow(row, metadata.get(path), query);
      return match ? [match] : [];
    });
    const window = normalizeWindow(req.offset, req.limit);
    const rows = matches.slice(window.offset, window.offset + window.limit);
    // Lazy status enrichment: the pin order never sorted on git facts, so
    // only the served rows wait on probes — never the whole set.
    await this.deps.enrichRows(rows);
    enrichActiveSessionCounts(rows, this.deps.listLiveSessions());
    return {
      rows,
      total: matches.length,
      more: window.offset + rows.length < matches.length,
      orderToken: pin.token,
      epoch,
    };
  }

  async buildDelta(changedPaths: string[], removedPaths: string[]): Promise<FoldersChangedEvent> {
    const rows = await this.deps.listRows();
    const byPath = new Map(rows.map((row) => [row.path, row]));
    const touched = [...new Set([...changedPaths, ...removedPaths])];
    const changed = touched.flatMap((path) => {
      const row = byPath.get(path);
      if (!row) return [];
      const activity = this.metadata.get(path)?.lastActivity;
      return [{ ...row, ...(activity ? { lastActivity: activity } : {}) }];
    });
    const removed = touched.filter((path) => !byPath.has(path));
    // Deltas re-resolve rows for immediate display: fill git facts for the
    // touched rows only (bounded), like window serving does.
    await this.deps.enrichRows(changed);
    // Additions append at the tail of every live pin. Tail is the only
    // position that cannot shift live window offsets — new rows arrive via
    // delta past the fetched frontier (the brainstorm's stated intent) and
    // join windows, search, and totals without reordering anyone's pagination.
    for (const [token, snapshot] of this.pins) {
      const known = new Set(snapshot.paths);
      const additions = changed.map((row) => row.path).filter((path) => !known.has(path));
      if (additions.length > 0) this.pins.set(token, { ...snapshot, paths: [...snapshot.paths, ...additions] });
    }
    enrichActiveSessionCounts(changed, this.deps.listLiveSessions());
    this.epoch += 1;
    return { type: 'folders_changed', changed, removedPaths: removed, epoch: this.epoch };
  }

  invalidateSessionMetadata(folderPaths?: string[]): void {
    this.invalidationVersion += 1;
    if (folderPaths === undefined) this.refreshAll = true;
    else for (const path of folderPaths) this.invalidatedPaths.add(path);
    this.scheduleRefresh();
  }

  private connectionPin(connectionId: string): ConnectionPin {
    const existing = this.connections.get(connectionId);
    if (existing) return existing;
    const connection: ConnectionPin = { generation: 0 };
    this.connections.set(connectionId, connection);
    return connection;
  }

  private async createPin(connectionId: string | undefined, connection: ConnectionPin | undefined, generation: number): Promise<FolderPin> {
    const epoch = this.epoch;
    const metadata = this.metadata;
    const rows = await this.deps.listRows();
    this.scheduleRefresh(rows);
    const snapshot: OrderSnapshot = {
      token: randomUUID(),
      owner: connectionId,
      paths: orderedPaths(rows, metadata, this.deps.listLiveSessions()),
      expiresAt: Date.now() + ORPHAN_PIN_TTL_MS,
    };
    // Deleting/replacing the owner state also invalidates pending pin writes.
    if (!connection || (!connection.released && this.connections.get(connectionId!) === connection && connection.generation === generation)) {
      if (connection?.token) this.pins.delete(connection.token);
      this.pins.set(snapshot.token, snapshot);
      if (connection) {
        connection.token = snapshot.token;
        connection.pending = undefined;
      }
    }
    return { token: snapshot.token, epoch };
  }

  private async selectPin(req: FolderQueryRequest): Promise<FolderPin> {
    this.sweepOrphans();
    if (req.repin) return this.pin(req.connectionId);
    const connection = req.connectionId === undefined ? undefined : this.connections.get(req.connectionId);
    const token = req.token ?? connection?.token;
    const snapshot = token === undefined ? undefined : this.pins.get(token);
    if (snapshot && snapshot.owner === req.connectionId) return { token: snapshot.token, epoch: this.epoch };
    if (req.token === undefined && connection?.pending) return connection.pending;
    return this.pin(req.connectionId);
  }

  private sweepOrphans(): void {
    const now = Date.now();
    for (const [token, snapshot] of this.pins) {
      if (snapshot.owner === undefined && snapshot.expiresAt <= now) this.pins.delete(token);
    }
    for (const [connectionId, connection] of this.connections) {
      if (connection.released && (connection.releasedAt ?? 0) + ORPHAN_PIN_TTL_MS <= now) this.connections.delete(connectionId);
    }
  }

  private scheduleRefresh(rows?: readonly FolderInfo[]): void {
    if (this.refreshPending) return;
    const version = this.invalidationVersion;
    const expired = Date.now() - this.lastRefreshAttempt >= METADATA_TTL_MS;
    // A failed refresh keeps its bookkeeping (see refreshMetadata), so the
    // version gate — not the bookkeeping — bounds retries: the next
    // invalidation or TTL expiry retries, never every query.
    if (!expired && version === this.lastRefreshVersion) return;
    const full = expired || this.refreshAll;
    const paths = [...this.invalidatedPaths];
    this.lastRefreshAttempt = Date.now();
    this.lastRefreshVersion = version;
    this.refreshPending = Promise.resolve().then(() => this.refreshMetadata(rows, full, paths, version));
  }

  private async refreshMetadata(rows: readonly FolderInfo[] | undefined, full: boolean, invalidatedPaths: readonly string[], version: number): Promise<void> {
    try {
      // Partial refreshes re-read only the invalidated folders; the full row
      // listing is needed solely to enumerate the full-scan paths.
      const paths = full ? (rows ?? (await this.deps.listRows())).map((row) => row.path) : [...invalidatedPaths];
      const summaries = await this.deps.sessionSummaries.listMany(paths);
      const projected = projectMetadata(summaries);
      this.metadata = full ? projected : new Map([...Array.from(this.metadata).filter(([path]) => !paths.includes(path)), ...projected]);
      // Success only: a failed refresh keeps the bookkeeping so its paths stay
      // stale-eligible and a later invalidation or TTL refresh re-reads them.
      if (version === this.invalidationVersion) {
        this.refreshAll = false;
        this.invalidatedPaths.clear();
      }
    } catch {
      // Discovery errors in the background and summary errors keep the last
      // successful snapshot. Public registry reads still propagate errors.
    } finally {
      this.refreshPending = undefined;
    }
  }
}
