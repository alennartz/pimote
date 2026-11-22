import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderListing, type FolderListingDeps, type LiveSessionRef } from './folder-listing.js';
import type { SessionSummary } from './session-summaries.js';

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
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: '',
    name: opts.name,
    created: at,
    modified: at,
    messageCount: 1,
    firstMessage: opts.firstMessage ?? '(no messages)',
  };
}

function fakeDeps(
  init: {
    rows?: FolderInfo[];
    summaries?: Record<string, SessionSummary[]>;
    live?: LiveSessionRef[];
    archived?: string[];
    enrichRows?: (rows: FolderInfo[]) => Promise<void>;
  } = {},
): FolderListingDeps {
  const rows = init.rows ?? [];
  const summaries = new Map(Object.entries(init.summaries ?? {}));
  const live = init.live ?? [];
  const archived = new Set(init.archived ?? []);

  return {
    listRows: async () => rows,
    enrichRows: init.enrichRows ?? (async () => {}),
    sessionSummaries: {
      listMany: async (folderPaths: string[]) => new Map(folderPaths.map((p) => [p, summaries.get(p) ?? []])),
    },
    archivedLookup: (paths: string[]) => new Map(paths.map((p) => [p, archived.has(p)])),
    listLiveSessions: () => live,
  };
}

async function warm(service: FolderListing): Promise<void> {
  await service.pin();
  await Promise.resolve();
  await Promise.resolve();
}

describe('FolderListing.searchLauncher contract', () => {
  it('honors scope isolation across all, folders, and sessions', async () => {
    const service = new FolderListing(
      fakeDeps({
        rows: [row('/w/alpha', { name: 'alpha' })],
        summaries: {
          '/w/alpha': [summary('s1', '2026-01-02T00:00:00Z', { name: 'alpha release', firstMessage: 'ship it' })],
        },
      }),
    );
    await warm(service);

    const all = await service.searchLauncher({ query: 'alpha' });
    expect(all.folders.map((f) => f.path)).toEqual(['/w/alpha']);
    expect(all.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    const foldersOnly = await service.searchLauncher({ query: 'alpha', scope: 'folders' });
    expect(foldersOnly.folders.map((f) => f.path)).toEqual(['/w/alpha']);
    expect(foldersOnly.sessions).toEqual([]);

    const sessionsOnly = await service.searchLauncher({ query: 'alpha', scope: 'sessions' });
    expect(sessionsOnly.folders).toEqual([]);
    expect(sessionsOnly.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('clamps limit to [1, 25] per category with default 10', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`/w/item-${String(i).padStart(2, '0')}`));
    const summaries: Record<string, SessionSummary[]> = {
      '/w/item-00': Array.from({ length: 30 }, (_, i) =>
        summary(`s-${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), {
          name: `item session ${i}`,
        }),
      ),
    };
    const service = new FolderListing(fakeDeps({ rows, summaries }));
    await warm(service);

    const defaulted = await service.searchLauncher({ query: 'item' });
    expect(defaulted.folders).toHaveLength(10);
    expect(defaulted.sessions).toHaveLength(10);

    const tooLow = await service.searchLauncher({ query: 'item', limit: 0 });
    expect(tooLow.folders).toHaveLength(1);
    expect(tooLow.sessions).toHaveLength(1);

    const tooHigh = await service.searchLauncher({ query: 'item', limit: 200 });
    expect(tooHigh.folders).toHaveLength(25);
    expect(tooHigh.sessions).toHaveLength(25);

    const nonFinite = await service.searchLauncher({ query: 'item', limit: Number.NaN });
    expect(nonFinite.folders).toHaveLength(10);
    expect(nonFinite.sessions).toHaveLength(10);
  });

  it('excludes archived folders and archived sessions unless includeArchived is true', async () => {
    const service = new FolderListing(
      fakeDeps({
        rows: [row('/w/active-app', { name: 'active-app' }), row('/w/old-app', { name: 'old-app', archived: true })],
        summaries: {
          '/w/active-app': [summary('live-s', '2026-01-02T00:00:00Z', { name: 'app refactor' }), summary('arch-s', '2026-01-03T00:00:00Z', { name: 'app archived refactor' })],
        },
        archived: ['/sessions/arch-s.jsonl'],
      }),
    );
    await warm(service);

    const gated = await service.searchLauncher({ query: 'app' });
    expect(gated.folders.map((f) => f.path)).toEqual(['/w/active-app']);
    expect(gated.sessions.map((s) => s.sessionId)).toEqual(['live-s']);

    const open = await service.searchLauncher({ query: 'app', includeArchived: true });
    expect(open.folders.map((f) => f.path)).toEqual(['/w/active-app', '/w/old-app']);
    expect(open.sessions.map((s) => s.sessionId)).toEqual(['arch-s', 'live-s']);
  });

  it('matches indexed folder and session fields case-insensitively and returns displayable session hits', async () => {
    const service = new FolderListing(
      fakeDeps({
        rows: [
          row('/w/personas/ada', { name: 'ada', nature: 'persona', persona: { name: 'Architect' }, tags: ['design'] }),
          row('/w/deep/api-service', { name: 'api-service', tags: ['backend'] }),
        ],
        summaries: {
          '/w/personas/ada': [
            summary('s-name', '2026-02-01T10:00:00Z', { name: 'Webhook Retry Spec', firstMessage: 'hello' }),
            summary('s-msg', '2026-02-02T10:00:00Z', { firstMessage: 'Investigate flaky CI timeout' }),
          ],
        },
      }),
    );
    await warm(service);

    expect((await service.searchLauncher({ query: 'ARCHITECT', scope: 'folders' })).folders.map((f) => f.path)).toEqual(['/w/personas/ada']);
    expect((await service.searchLauncher({ query: 'deep/api', scope: 'folders' })).folders.map((f) => f.path)).toEqual(['/w/deep/api-service']);
    expect((await service.searchLauncher({ query: 'BACKEND', scope: 'folders' })).folders.map((f) => f.path)).toEqual(['/w/deep/api-service']);

    const byName = await service.searchLauncher({ query: 'WEBHOOK', scope: 'sessions' });
    expect(byName.sessions).toEqual([
      {
        sessionId: 's-name',
        folderPath: '/w/personas/ada',
        folderName: 'Architect',
        name: 'Webhook Retry Spec',
        firstMessage: 'hello',
        modified: new Date('2026-02-01T10:00:00Z').getTime(),
        archived: false,
      },
    ]);

    const byFirstMessage = await service.searchLauncher({ query: 'FLAKY CI', scope: 'sessions' });
    expect(byFirstMessage.sessions.map((s) => s.sessionId)).toEqual(['s-msg']);
    expect(byFirstMessage.sessions[0].firstMessage).toBe('Investigate flaky CI timeout');
  });

  it('ranks empty queries by recency/favorites and non-empty queries by prefix/name priority', async () => {
    const service = new FolderListing(
      fakeDeps({
        rows: [row('/w/my-pimote-tools', { name: 'my-pimote-tools', favorite: true }), row('/w/pimote', { name: 'pimote' }), row('/w/zeta', { name: 'zeta' })],
        summaries: {
          '/w/pimote': [
            summary('s-msg-newer', '2026-03-05T00:00:00Z', { firstMessage: 'fix auth bug' }),
            summary('s-name-older', '2026-03-01T00:00:00Z', { name: 'auth migration', firstMessage: 'start' }),
          ],
          '/w/zeta': [summary('s-latest', '2026-03-10T00:00:00Z', { name: 'other work' })],
        },
      }),
    );
    await warm(service);

    // Empty query: favorite folder first, then most recent activity; sessions newest first.
    const empty = await service.searchLauncher({ query: '' });
    expect(empty.folders.map((f) => f.path)).toEqual(['/w/my-pimote-tools', '/w/zeta', '/w/pimote']);
    expect(empty.sessions.map((s) => s.sessionId)).toEqual(['s-latest', 's-msg-newer', 's-name-older']);

    // Non-empty folder query: display-name prefix match ('pimote') beats substring match ('my-pimote-tools').
    const folderRank = await service.searchLauncher({ query: 'pimote', scope: 'folders' });
    expect(folderRank.folders.map((f) => f.path)).toEqual(['/w/pimote', '/w/my-pimote-tools']);

    // Non-empty session query: name match beats newer firstMessage-only match.
    const sessionRank = await service.searchLauncher({ query: 'auth', scope: 'sessions' });
    expect(sessionRank.sessions.map((s) => s.sessionId)).toEqual(['s-name-older', 's-msg-newer']);
  });

  it('never mutates active connection pins, order tokens, or epochs and enriches only the bounded slice', async () => {
    const enrichRows = vi.fn(async () => {});
    const rows = Array.from({ length: 15 }, (_, i) => row(`/w/repo-${String(i).padStart(2, '0')}`));
    const service = new FolderListing(fakeDeps({ rows, enrichRows }));

    const pin = await service.pin('conn-1');
    const before = await service.query({ connectionId: 'conn-1', offset: 0, limit: 5 });
    enrichRows.mockClear();

    const hit = await service.searchLauncher({ query: 'repo', limit: 3 });
    expect(hit.folders).toHaveLength(3);
    expect(enrichRows).toHaveBeenCalledTimes(1);
    expect(enrichRows.mock.calls[0][0]).toHaveLength(3);

    const after = await service.query({ connectionId: 'conn-1', offset: 0, limit: 5 });
    expect(after.orderToken).toBe(pin.token);
    expect(after.epoch).toBe(before.epoch);
    expect(after.rows.map((r) => r.path)).toEqual(before.rows.map((r) => r.path));
  });

  it('populates session hits on a cold server without requiring a prior pin()', async () => {
    const service = new FolderListing(
      fakeDeps({
        rows: [row('/w/pimote', { name: 'pimote' })],
        summaries: {
          '/w/pimote': [summary('cold-s', '2026-04-01T00:00:00Z', { name: 'Cold start session' })],
        },
      }),
    );

    const result = await service.searchLauncher({ query: 'cold' });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['cold-s']);
  });
});
