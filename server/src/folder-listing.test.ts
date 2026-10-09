import { describe, it, expect, vi } from 'vitest';
import { basename } from 'node:path';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderListing, type FolderListingDeps, type FolderQueryResult, type LiveSessionRef } from './folder-listing.js';
import type { SessionSummary } from './session-summaries.js';

// --- Test doubles -----------------------------------------------------------

function row(path: string, overrides: Partial<FolderInfo> = {}): FolderInfo {
  return {
    path,
    name: basename(path),
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...overrides,
  };
}

function summary(id: string, modified: string, opts: { name?: string; firstMessage?: string } = {}): SessionSummary {
  const at = new Date(modified);
  return { path: `/sessions/${id}.jsonl`, id, cwd: '', name: opts.name, created: at, modified: at, messageCount: 1, firstMessage: opts.firstMessage ?? '(no messages)' };
}

interface FakeWorld {
  deps: FolderListingDeps;
  state: {
    rows: FolderInfo[];
    summaries: Map<string, SessionSummary[]>;
    live: LiveSessionRef[];
  };
}

/**
 * Mutable dep fakes: tests flip `state` between calls to observe how the
 * service caches (or doesn't). `listMany` can be overridden to model a slow or
 * hanging scan.
 */
function fakeWorld(
  init: {
    rows?: FolderInfo[];
    summaries?: Record<string, SessionSummary[]>;
    live?: LiveSessionRef[];
    listMany?: (folderPaths: string[]) => Promise<Map<string, SessionSummary[]>>;
    enrichRows?: (rows: FolderInfo[]) => Promise<void>;
  } = {},
): FakeWorld {
  const state = {
    rows: init.rows ?? [],
    summaries: new Map(Object.entries(init.summaries ?? {})),
    live: init.live ?? [],
  };
  const deps: FolderListingDeps = {
    listRows: async () => state.rows,
    enrichRows: init.enrichRows ?? (async () => {}),
    sessionSummaries: {
      listMany: init.listMany ?? (async (folderPaths: string[]) => new Map(folderPaths.map((p) => [p, state.summaries.get(p) ?? []]))),
    },
    listLiveSessions: () => state.live,
  };
  return { deps, state };
}

const paths = (result: FolderQueryResult): string[] => result.rows.map((r) => r.path);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function warm(service: FolderListing): Promise<void> {
  await service.pin();
  await flushMicrotasks();
}

describe('lazy git status enrichment (window path)', () => {
  it('query enriches git status for exactly the served window rows', async () => {
    const enrichRows = vi.fn(async () => {});
    const rows = Array.from({ length: 30 }, (_, i) => row(`/w/r${String(i).padStart(2, '0')}`));
    const service = new FolderListing(fakeWorld({ rows, enrichRows }).deps);
    const pin = await service.pin();
    // Pins hold order only; no git probes on the order path.
    expect(enrichRows).not.toHaveBeenCalled();

    const result = await service.query({ token: pin.token, offset: 10, limit: 10 });
    expect(result.rows).toHaveLength(10);
    expect(enrichRows).toHaveBeenCalledOnce();
    expect(enrichRows).toHaveBeenCalledWith(result.rows);
  });

  it('buildDelta enriches only the touched changed rows', async () => {
    const enrichRows = vi.fn(async () => {});
    const service = new FolderListing(fakeWorld({ rows: [row('/w/a'), row('/w/b')], enrichRows }).deps);

    const delta = await service.buildDelta(['/w/a'], []);

    expect(delta.changed.map((r) => r.path)).toEqual(['/w/a']);
    expect(enrichRows).toHaveBeenCalledOnce();
    expect(enrichRows).toHaveBeenCalledWith(delta.changed);
  });
});

describe('FolderListing', () => {
  describe('pin()', () => {
    it('returns a pin token and the current epoch', async () => {
      const { deps } = fakeWorld({ rows: [row('/w/a')] });
      const pin = await new FolderListing(deps).pin();

      expect(pin.token).toBeTypeOf('string');
      expect(pin.token).not.toBe('');
      expect(pin.epoch).toBeTypeOf('number');
    });
  });

  describe('order snapshot', () => {
    it('serves windows ordered favorite → lastActivity → name → path', async () => {
      const { deps } = fakeWorld({
        rows: [
          row('/w/zeta', { name: 'zeta' }),
          row('/w/alpha', { name: 'alpha' }),
          row('/w/mid', { name: 'mid' }),
          row('/w/fav-old', { name: 'aaa', favorite: true }),
          row('/w/never', { name: 'never' }),
        ],
        summaries: {
          '/w/zeta': [summary('s1', '2025-01-01T00:00:00Z')],
          '/w/alpha': [summary('s2', '2024-01-01T00:00:00Z')],
          '/w/mid': [summary('s3', '2024-06-01T00:00:00Z')],
          '/w/fav-old': [summary('s4', '2020-01-01T00:00:00Z')],
        },
      });
      const service = new FolderListing(deps);
      await warm(service);
      const { token } = await service.pin();

      const result = await service.query({ token, offset: 0, limit: 10 });

      // Favorite first even with the oldest activity; then newest activity;
      // no-session folders sink to the bottom of their tier.
      expect(paths(result)).toEqual(['/w/fav-old', '/w/zeta', '/w/mid', '/w/alpha', '/w/never']);
    });

    it('breaks ties by name, then by path', async () => {
      const { deps } = fakeWorld({
        rows: [row('/w/b/dup', { name: 'dup' }), row('/w/a/dup', { name: 'dup' }), row('/w/beta', { name: 'beta' }), row('/w/aleph', { name: 'aleph' })],
        summaries: {
          '/w/b/dup': [summary('s1', '2024-01-01T00:00:00Z')],
          '/w/a/dup': [summary('s2', '2024-01-01T00:00:00Z')],
          '/w/beta': [summary('s3', '2024-01-01T00:00:00Z')],
          '/w/aleph': [summary('s4', '2024-01-01T00:00:00Z')],
        },
      });
      const service = new FolderListing(deps);
      await warm(service);
      const { token } = await service.pin();

      const result = await service.query({ token, offset: 0, limit: 10 });

      // Same favorite + lastActivity: name asc, and path asc when names collide.
      expect(paths(result)).toEqual(['/w/aleph', '/w/beta', '/w/a/dup', '/w/b/dup']);
    });

    it('folds live in-memory sessions into lastActivity so actively-running folders rank as most-recent', async () => {
      const { deps } = fakeWorld({
        rows: [row('/w/old', { name: 'old' }), row('/w/new', { name: 'new' })],
        summaries: {
          '/w/old': [summary('s1', '2020-01-01T00:00:00Z')],
          '/w/new': [summary('s2', '2025-01-01T00:00:00Z')],
        },
        live: [{ folderPath: '/w/old' }],
      });
      const service = new FolderListing(deps);
      await warm(service);
      const { token } = await service.pin();

      const result = await service.query({ token, offset: 0, limit: 10 });

      expect(paths(result)).toEqual(['/w/old', '/w/new']);
    });

    it('a pin holds order only: curation edits after pin() show in row data without reordering the window', async () => {
      const world = fakeWorld({
        rows: [row('/w/a', { name: 'aaa' }), row('/w/b', { name: 'bbb' })],
        summaries: {
          '/w/a': [summary('s1', '2025-01-01T00:00:00Z')],
          '/w/b': [summary('s2', '2020-01-01T00:00:00Z')],
        },
      });
      const service = new FolderListing(world.deps);
      const { token } = await service.pin();

      // A curation edit that would reorder a fresh pin (b becomes favorite).
      world.state.rows = [row('/w/a', { name: 'aaa', tags: ['fresh'] }), row('/w/b', { name: 'bbb', favorite: true })];

      const result = await service.query({ token, offset: 0, limit: 10 });

      expect(paths(result)).toEqual(['/w/a', '/w/b']);
      expect(result.rows[0].tags).toEqual(['fresh']);
      expect(result.rows[1].favorite).toBe(true);
    });
  });

  describe('pin lifecycle', () => {
    it("an omitted-token query awaits the connection's pending open-time pin", async () => {
      // Authorized amendment (pin-layer collapse): the handler no longer
      // resolves tokens, so awaiting the pending open-time pin — pinned at
      // the ws-handler seam before — is load-bearing service behavior.
      const gate = deferred<FolderInfo[]>();
      const world = fakeWorld();
      world.deps.listRows = () => gate.promise;
      const service = new FolderListing(world.deps);
      const openPin = service.pin('owner');
      void openPin.catch(() => {});
      let served = false;
      const early = service.query({ connectionId: 'owner' }).then((result) => {
        served = true;
        return result;
      });
      await flushMicrotasks();
      expect(served, 'early commands await the pending open-time pin').toBe(false);
      gate.resolve([row('/w/a')]);
      const result = await early;
      expect(result.orderToken).toBe((await openPin).token);
      expect(paths(result)).toEqual(['/w/a']);
    });

    it('omitted tokens reuse the connection pin until explicit refresh replaces its order', async () => {
      const world = fakeWorld({ rows: [row('/w/a'), row('/w/b')] });
      const service = new FolderListing(world.deps);
      const pin = await service.pin('owner');
      world.state.rows = [row('/w/a'), row('/w/b', { favorite: true })];
      const reused = await service.query({ connectionId: 'owner' });
      expect(reused.orderToken).toBe(pin.token);
      expect(paths(reused)).toEqual(['/w/a', '/w/b']);
      const refreshed = await service.query({ connectionId: 'owner', repin: true });
      expect(refreshed.orderToken).not.toBe(pin.token);
      expect(paths(refreshed)).toEqual(['/w/b', '/w/a']);
      const continued = await service.query({ connectionId: 'owner' });
      expect(continued.orderToken).toBe(refreshed.orderToken);
    });

    it('a query under an unknown token transparently re-pins and serves the window under the new token', async () => {
      const { deps } = fakeWorld({ rows: [row('/w/a', { name: 'a' }), row('/w/b', { name: 'b' }), row('/w/c', { name: 'c' })] });
      const service = new FolderListing(deps);

      const first = await service.query({ token: 'expired-token', offset: 0, limit: 2 });

      expect(first.orderToken).not.toBe('expired-token');
      expect(paths(first)).toEqual(['/w/a', '/w/b']);
      expect(first.total).toBe(3);

      // The client adopts the returned token; continuation windows come under it.
      const next = await service.query({ token: first.orderToken, offset: 2, limit: 2 });
      expect(next.orderToken).toBe(first.orderToken);
      expect(paths(next)).toEqual(['/w/c']);
    });
  });

  describe('windowing', () => {
    it('defaults to offset 0 and limit 100, with more=true while rows remain', async () => {
      const rows = Array.from({ length: 150 }, (_, i) => row(`/w/p${String(i).padStart(3, '0')}`, { name: `p${String(i).padStart(3, '0')}` }));
      const { deps } = fakeWorld({ rows });
      const service = new FolderListing(deps);

      const result = await service.query({});

      expect(result.rows).toHaveLength(100);
      expect(result.total).toBe(150);
      expect(result.more).toBe(true);
    });

    it('clamps limit to [1, 200]', async () => {
      const rows = Array.from({ length: 300 }, (_, i) => row(`/w/p${String(i).padStart(3, '0')}`, { name: `p${String(i).padStart(3, '0')}` }));
      const { deps } = fakeWorld({ rows });
      const service = new FolderListing(deps);

      const tooBig = await service.query({ limit: 500 });
      expect(tooBig.rows).toHaveLength(200);

      const zero = await service.query({ limit: 0 });
      expect(zero.rows).toHaveLength(1);

      const negative = await service.query({ limit: -7 });
      expect(negative.rows).toHaveLength(1);
    });

    it('more is false once the window covers the filtered order', async () => {
      const { deps } = fakeWorld({ rows: [row('/w/a', { name: 'a' }), row('/w/b', { name: 'b' })] });
      const service = new FolderListing(deps);

      const full = await service.query({ offset: 0, limit: 2 });
      expect(full.more).toBe(false);
      expect(full.total).toBe(2);

      const past = await service.query({ offset: 2, limit: 2 });
      expect(past.rows).toEqual([]);
      expect(past.more).toBe(false);
      expect(past.total).toBe(2);
    });
  });

  describe('query semantics', () => {
    it('filters the full pinned order, not just rows already fetched', async () => {
      const { deps } = fakeWorld({
        rows: [
          row('/w/a', { name: 'apple' }),
          row('/w/b', { name: 'banana' }),
          row('/w/c', { name: 'cherry' }),
          row('/w/d', { name: 'date' }),
          row('/w/e', { name: 'elderberry' }),
        ],
      });
      const service = new FolderListing(deps);
      const { token } = await service.pin();
      await service.query({ token, offset: 0, limit: 2 }); // the fetched frontier

      const matches = await service.query({ token, query: 'berr', offset: 0, limit: 10 });

      expect(paths(matches)).toEqual(['/w/e']);
    });

    it('folder tier matches display name, name, path, and tags case-insensitively, returning rows without matchedSessionIds', async () => {
      const { deps } = fakeWorld({
        rows: [
          row('/w/agent', { name: 'agent', nature: 'persona', persona: { name: 'Helper' } }),
          row('/w/api-server', { name: 'api-server' }),
          row('/w/deep/nested', { name: 'nested' }),
          row('/w/tagged', { name: 'plain', tags: ['priority'] }),
          row('/w/unrelated', { name: 'zzz' }),
        ],
      });
      const service = new FolderListing(deps);

      for (const [query, expected] of [
        ['HELPER', '/w/agent'], // persona display name
        ['gent', '/w/agent'], // folder name
        ['api-SERV', '/w/api-server'], // name
        ['deep/nest', '/w/deep/nested'], // path
        ['PRIOR', '/w/tagged'], // tag substring
      ] as const) {
        const result = await service.query({ query, offset: 0, limit: 10 });
        expect(paths(result), `query: ${query}`).toEqual([expected]);
        expect(result.rows[0].matchedSessionIds, `query: ${query}`).toBeUndefined();
        expect(result.total).toBe(1);
      }
    });

    it('session tier matches session name and firstMessage, returning just the matched session ids', async () => {
      const { deps } = fakeWorld({
        rows: [row('/w/sess', { name: 'sess' })],
        summaries: {
          '/w/sess': [
            summary('s1', '2025-01-01T00:00:00Z', { name: 'sess deploy pipeline' }),
            summary('s2', '2024-01-01T00:00:00Z', { firstMessage: 'talks about widgets' }),
            summary('s3', '2023-01-01T00:00:00Z', { name: 'unrelated' }),
          ],
        },
      });
      const service = new FolderListing(deps);
      await warm(service);

      const byName = await service.query({ query: 'PIPELINE', offset: 0, limit: 10 });
      expect(paths(byName)).toEqual(['/w/sess']);
      expect(byName.rows[0].matchedSessionIds).toEqual(['s1']);

      const byFirstMessage = await service.query({ query: 'widgets', offset: 0, limit: 10 });
      expect(byFirstMessage.rows[0].matchedSessionIds).toEqual(['s2']);

      const folderMatch = await service.query({ query: 'sess' });
      expect(folderMatch.rows[0].matchedSessionIds).toBeUndefined();
    });

    it('filter then slice: total is the post-filter count and the window is [offset, offset+limit) of the filtered order', async () => {
      const { deps } = fakeWorld({
        rows: [
          row('/w/m-alpha', { name: 'm-alpha' }),
          row('/w/zz-a', { name: 'zz-a' }),
          row('/w/m-beta', { name: 'm-beta' }),
          row('/w/m-gamma', { name: 'm-gamma' }),
          row('/w/zz-b', { name: 'zz-b' }),
          row('/w/m-delta', { name: 'm-delta' }),
        ],
      });
      const service = new FolderListing(deps);

      const result = await service.query({ query: 'm-', offset: 2, limit: 2 });

      expect(result.total).toBe(4);
      expect(paths(result)).toEqual(['/w/m-delta', '/w/m-gamma']);
      expect(result.more).toBe(false);
    });

    it('includeArchived defaults to false and includes archived rows in rows and total when set', async () => {
      const { deps } = fakeWorld({ rows: [row('/w/a', { name: 'a' }), row('/w/b', { name: 'b', archived: true })] });
      const service = new FolderListing(deps);

      const hidden = await service.query({ offset: 0, limit: 10 });
      expect(paths(hidden)).toEqual(['/w/a']);
      expect(hidden.total).toBe(1);

      const shown = await service.query({ includeArchived: true, offset: 0, limit: 10 });
      expect(paths(shown)).toEqual(['/w/a', '/w/b']);
      expect(shown.total).toBe(2);
    });
  });

  describe('session-derived metadata cache', () => {
    it('pin() and query() never block on a full session scan', async () => {
      let releaseScan!: (value: Map<string, SessionSummary[]>) => void;
      const hanging = new Promise<Map<string, SessionSummary[]>>((resolve) => (releaseScan = resolve));
      const { deps } = fakeWorld({
        rows: [row('/w/a', { name: 'a' }), row('/w/b', { name: 'b' })],
        listMany: () => hanging,
      });
      const service = new FolderListing(deps);

      try {
        const { token } = await service.pin();
        const result = await service.query({ token, offset: 0, limit: 10 });

        expect(paths(result)).toEqual(['/w/a', '/w/b']);
      } finally {
        releaseScan(new Map());
      }
    });

    it('serves the previous metadata snapshot while a TTL refresh runs in the background, then the refreshed metadata', async () => {
      vi.useFakeTimers();
      try {
        const world = fakeWorld({
          rows: [row('/w/x', { name: 'x' }), row('/w/y', { name: 'y' })],
          summaries: {
            '/w/x': [summary('s1', '2025-01-01T00:00:00Z')],
            '/w/y': [summary('s2', '2020-01-01T00:00:00Z')],
          },
        });
        const service = new FolderListing(world.deps);
        await warm(service); // warm the metadata cache

        // On-disk activity moves on; the TTL lapses (default 30s).
        world.state.summaries = new Map([
          ['/w/x', [summary('s1', '2020-01-01T00:00:00Z')]],
          ['/w/y', [summary('s2', '2025-06-01T00:00:00Z')]],
        ]);
        const scan = deferred<Map<string, SessionSummary[]>>();
        world.deps.sessionSummaries.listMany = () => scan.promise;
        vi.advanceTimersByTime(30_001);

        const stale = await service.query({ offset: 0, limit: 10 });
        expect(paths(stale), 'stale-while-revalidate: the previous snapshot is served while refreshing').toEqual(['/w/x', '/w/y']);

        scan.resolve(world.state.summaries);
        await flushMicrotasks();
        const fresh = await service.query({ offset: 0, limit: 10 });
        expect(paths(fresh)).toEqual(['/w/y', '/w/x']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('invalidation refreshes in the background and only fresh pins adopt refreshed metadata', async () => {
      const world = fakeWorld({
        rows: [row('/w/x', { name: 'x' }), row('/w/y', { name: 'y' })],
        summaries: {
          '/w/x': [summary('s1', '2025-01-01T00:00:00Z')],
          '/w/y': [summary('s2', '2020-01-01T00:00:00Z')],
        },
      });
      const service = new FolderListing(world.deps);
      await warm(service);
      const pinned = await service.pin();
      const scan = deferred<Map<string, SessionSummary[]>>();
      world.deps.sessionSummaries.listMany = () => scan.promise;

      world.state.summaries = new Map([
        ['/w/x', [summary('s1', '2020-01-01T00:00:00Z')]],
        ['/w/y', [summary('s2', '2025-06-01T00:00:00Z')]],
      ]);
      service.invalidateSessionMetadata();

      const stale = await service.query({ offset: 0, limit: 10 });
      expect(paths(stale)).toEqual(['/w/x', '/w/y']);
      scan.resolve(world.state.summaries);
      await flushMicrotasks();
      expect(paths(await service.query({ token: pinned.token }))).toEqual(['/w/x', '/w/y']);
      expect(paths(await service.query({}))).toEqual(['/w/y', '/w/x']);
    });
  });

  describe('failures and connection ownership', () => {
    it('cold scan completion affects fresh pins, never the existing pin', async () => {
      const scan = deferred<Map<string, SessionSummary[]>>();
      const world = fakeWorld({ rows: [row('/w/a'), row('/w/z')], listMany: () => scan.promise });
      const service = new FolderListing(world.deps);
      const pin = await service.pin();
      expect(paths(await service.query({ token: pin.token }))).toEqual(['/w/a', '/w/z']);
      scan.resolve(new Map([['/w/z', [summary('recent', '2025-01-01T00:00:00Z')]]]));
      await flushMicrotasks();
      expect(paths(await service.query({ token: pin.token }))).toEqual(['/w/a', '/w/z']);
      expect(paths(await service.query({}))).toEqual(['/w/z', '/w/a']);
    });

    it('released connection pins cannot be reused and another owner cannot adopt them', async () => {
      const service = new FolderListing(fakeWorld({ rows: [row('/w/a')] }).deps);
      const pin = await service.pin('connection-a');
      const other = await service.query({ connectionId: 'connection-b', token: pin.token });
      expect(other.orderToken).not.toBe(pin.token);
      service.releaseConnection('connection-a');
      const renewed = await service.query({ connectionId: 'connection-a', token: pin.token });
      expect(renewed.orderToken).not.toBe(pin.token);
    });

    it('closing a connection while a pin is pending prevents retaining that pin', async () => {
      const gate = deferred<FolderInfo[]>();
      const world = fakeWorld();
      world.deps.listRows = () => gate.promise;
      const service = new FolderListing(world.deps);
      const pending = service.pin('closing');
      service.releaseConnection('closing');
      gate.resolve([row('/w/a')]);
      const released = await pending;
      const renewed = await service.query({ connectionId: 'closing', token: released.token });
      expect(renewed.orderToken).not.toBe(released.token);
    });

    it('registry failures propagate from pin, query, and delta construction', async () => {
      const world = fakeWorld();
      const failure = new Error('registry unavailable');
      world.deps.listRows = async () => {
        throw failure;
      };
      const service = new FolderListing(world.deps);
      await expect(service.pin()).rejects.toBe(failure);
      await expect(service.query({})).rejects.toBe(failure);
      await expect(service.buildDelta(['/w/a'], [])).rejects.toBe(failure);
    });

    it('metadata failures preserve the last good snapshot and a later invalidation recovers', async () => {
      const world = fakeWorld({ rows: [row('/w/a'), row('/w/z')], summaries: { '/w/z': [summary('s', '2025-01-01T00:00:00Z')] } });
      const service = new FolderListing(world.deps);
      await warm(service);
      const scan = deferred<Map<string, SessionSummary[]>>();
      world.deps.sessionSummaries.listMany = () => scan.promise;
      service.invalidateSessionMetadata();
      expect(paths(await service.query({}))).toEqual(['/w/z', '/w/a']);
      scan.reject(new Error('scan failed'));
      await flushMicrotasks();
      expect(paths(await service.query({}))).toEqual(['/w/z', '/w/a']);
      world.deps.sessionSummaries.listMany = async () => new Map();
      service.invalidateSessionMetadata();
      await service.query({});
      await flushMicrotasks();
      expect(paths(await service.query({}))).toEqual(['/w/a', '/w/z']);
    });

    it('a failed cold metadata scan still serves name-only ordering', async () => {
      const world = fakeWorld({
        rows: [row('/w/z'), row('/w/a')],
        listMany: async () => {
          throw new Error('scan failed');
        },
      });
      const service = new FolderListing(world.deps);
      await service.pin();
      await flushMicrotasks();
      expect(paths(await service.query({}))).toEqual(['/w/a', '/w/z']);
    });
  });

  describe('epochs and deltas', () => {
    it('buildDelta re-resolves the touched rows with session-count enrichment and passes removedPaths through', async () => {
      const { deps } = fakeWorld({
        rows: [row('/w/a', { name: 'a' }), row('/w/b', { name: 'b' })],
        live: [{ folderPath: '/w/a' }, { folderPath: '/w/a' }, { folderPath: '/w/b' }],
      });
      const service = new FolderListing(deps);

      const delta = await service.buildDelta(['/w/a'], ['/w/gone']);

      expect(delta.type).toBe('folders_changed');
      expect(delta.changed).toHaveLength(1);
      expect(delta.changed[0]).toMatchObject({ path: '/w/a', name: 'a', activeSessionCount: 2 });
      expect(delta.removedPaths).toEqual(['/w/gone']);
    });

    it('a removed source path still present as missing becomes a changed row', async () => {
      const retained = row('/w/source', { missing: true });
      const service = new FolderListing(fakeWorld({ rows: [retained] }).deps);

      const delta = await service.buildDelta([], ['/w/source', '/w/source']);

      expect(delta.changed).toEqual([retained]);
      expect(delta.removedPaths).toEqual([]);
    });

    it('an unresolvable changed path becomes a removal', async () => {
      const service = new FolderListing(fakeWorld().deps);

      const delta = await service.buildDelta(['/w/gone', '/w/gone'], ['/w/gone']);

      expect(delta.changed).toEqual([]);
      expect(delta.removedPaths).toEqual(['/w/gone']);
    });

    it('buildDelta serves current row data, not rows snapshotted at pin time', async () => {
      const world = fakeWorld({ rows: [row('/w/a', { name: 'a' })] });
      const service = new FolderListing(world.deps);
      await service.pin();

      world.state.rows = [row('/w/a', { name: 'a', favorite: true, tags: ['fresh'] })];

      const delta = await service.buildDelta(['/w/a'], []);
      expect(delta.changed[0]).toMatchObject({ path: '/w/a', favorite: true, tags: ['fresh'] });
    });

    it('every emitted delta bumps the epoch; pin() and query() stamp the observed epoch', async () => {
      const { deps } = fakeWorld({ rows: [row('/w/a', { name: 'a' })] });
      const service = new FolderListing(deps);

      const first = await service.buildDelta(['/w/a'], []);
      const second = await service.buildDelta(['/w/a'], []);
      expect(second.epoch).toBeGreaterThan(first.epoch);

      const queried = await service.query({ offset: 0, limit: 10 });
      expect(queried.epoch).toBe(second.epoch);

      const pinned = await service.pin();
      expect(pinned.epoch).toBe(second.epoch);
    });
  });
});
