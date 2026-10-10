import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FolderInfo, PimoteEvent } from '@pimote/shared';

const { fakeConnection, eventListeners, disconnectListeners } = vi.hoisted(() => {
  const eventListeners = new Set<(event: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const fakeConnection = {
    clientId: 'test-client',
    send: vi.fn(),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    }),
  };
  return { fakeConnection, eventListeners, disconnectListeners };
});

vi.mock('$lib/stores/connection.svelte.js', () => ({ connection: fakeConnection }));

const { FolderStore, folderStore } = await import('./folder-store.svelte.js');

function makeFolder(overrides: Partial<FolderInfo> & Pick<FolderInfo, 'path' | 'name'>): FolderInfo {
  return {
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

function makeSession(id: string, modified: string) {
  return { id, name: id, created: modified, modified, messageCount: 1 };
}

/** Resolve `send` per command type: `handlers[type](command)` supplies each response. */
function routeSends(handlers: Record<string, (cmd: any) => any>) {
  fakeConnection.send.mockImplementation((cmd: any) => {
    const handler = handlers[cmd.type];
    if (!handler) throw new Error(`Unexpected command: ${cmd.type}`);
    return Promise.resolve(handler(cmd));
  });
}

function okListFolders(folders: FolderInfo[], roots: string[] = ['/roots'], extra: { total?: number; orderToken?: string; more?: boolean; epoch?: number } = {}) {
  return { success: true, data: { folders, roots, total: folders.length, orderToken: 'tok-1', more: false, epoch: 0, ...extra } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeConnection.send.mockReset();
});

describe('FolderStore', () => {
  describe('module-scope event routing', () => {
    it('folders_changed deltas merge changed rows by canonical path and drop removedPaths', () => {
      expect(eventListeners.size).toBeGreaterThan(0);
      const listener = [...eventListeners].at(-1)!;
      folderStore.folders = [makeFolder({ path: '/r/keep', name: 'keep' }), makeFolder({ path: '/r/gone', name: 'gone' })];

      listener({
        type: 'folders_changed',
        changed: [makeFolder({ path: '/r/keep', name: 'keep', tags: ['fresh'] }), makeFolder({ path: '/r/new', name: 'new' })],
        removedPaths: ['/r/gone'],
        epoch: 1,
      } as PimoteEvent);

      expect(folderStore.folders.map((f) => f.path).sort()).toEqual(['/r/keep', '/r/new']);
      expect(folderStore.folders.find((f) => f.path === '/r/keep')!.tags).toEqual(['fresh']);
      folderStore.folders = [];
    });

    it('a folders_changed delta does not wipe live session indicators', () => {
      const listener = [...eventListeners].at(-1)!;
      folderStore.sessions.delete('/r/live');

      // A live session seeds the sessions map while the user is away.
      listener({
        type: 'session_state_changed',
        folderPath: '/r/live',
        sessionId: 's1',
        liveStatus: 'working',
        connectedClientId: 'other-client',
        folderActiveSessionCount: 1,
      } as PimoteEvent);

      // The delta carries the enriched row; the sessions map keeps its liveStatus entry.
      listener({
        type: 'folders_changed',
        changed: [makeFolder({ path: '/r/live', name: 'live', activeSessionCount: 1 })],
        removedPaths: [],
        epoch: 1,
      } as PimoteEvent);

      expect(folderStore.folders).toHaveLength(1);
      expect(folderStore.folders[0].activeSessionCount).toBe(1);
      const sessions = folderStore.sessions.get('/r/live');
      expect(sessions).toHaveLength(1);
      expect(sessions![0]).toMatchObject({ id: 's1', liveStatus: 'working' });
      folderStore.sessions.delete('/r/live');
      folderStore.folders = [];
    });

    it('session_state_changed seeds the sessions map while away from the dashboard', () => {
      const listener = [...eventListeners].at(-1)!;
      folderStore.sessions.delete('/r/away');

      listener({
        type: 'session_state_changed',
        folderPath: '/r/away',
        sessionId: 's1',
        liveStatus: 'working',
        connectedClientId: 'other-client',
        folderActiveSessionCount: 1,
      } as PimoteEvent);

      const seeded = folderStore.sessions.get('/r/away');
      expect(seeded).toHaveLength(1);
      expect(seeded![0]).toMatchObject({ id: 's1', liveStatus: 'working', isOwnedByMe: false });
      folderStore.sessions.delete('/r/away');
    });

    it('session_deleted removes the session from its folder', () => {
      const listener = [...eventListeners].at(-1)!;
      folderStore.sessions.set('/r/gone', [makeSession('s1', '2024-01-01T00:00:00Z'), makeSession('s2', '2024-01-02T00:00:00Z')]);

      listener({ type: 'session_deleted', folderPath: '/r/gone', sessionId: 's1' } as PimoteEvent);

      expect(folderStore.sessions.get('/r/gone')!.map((s) => s.id)).toEqual(['s2']);
      folderStore.sessions.delete('/r/gone');
    });

    it('session_renamed updates the session name in place', () => {
      const listener = [...eventListeners].at(-1)!;
      folderStore.sessions.set('/r/renamed', [makeSession('s1', '2024-01-01T00:00:00Z')]);

      listener({ type: 'session_renamed', folderPath: '/r/renamed', sessionId: 's1', name: 'renamed' } as PimoteEvent);

      expect(folderStore.sessions.get('/r/renamed')![0].name).toBe('renamed');
      folderStore.sessions.delete('/r/renamed');
    });

    it('session_archived refetches that folder’s sessions', async () => {
      const listener = [...eventListeners].at(-1)!;
      folderStore.sessions.set('/r/archived', [makeSession('s1', '2024-01-01T00:00:00Z')]);
      routeSends({ list_sessions: () => ({ success: true, data: { sessions: [] } }) });

      listener({ type: 'session_archived', folderPath: '/r/archived', sessionId: 's1', archived: true } as PimoteEvent);
      await flush();

      expect(folderStore.sessions.get('/r/archived')).toEqual([]);
      folderStore.sessions.delete('/r/archived');
    });

    it('unknown events are ignored', () => {
      const listener = [...eventListeners].at(-1)!;
      const before = folderStore.folders;
      listener({ type: 'something_else' } as unknown as PimoteEvent);
      expect(folderStore.folders).toBe(before);
    });

    it('applyFoldersChanged() merges changed rows by canonical path without duplicating rows from earlier windows', () => {
      const store = new FolderStore();
      store.folders = [makeFolder({ path: '/r/a', name: 'a' }), makeFolder({ path: '/r/b', name: 'b' })];

      store.applyFoldersChanged({
        type: 'folders_changed',
        changed: [makeFolder({ path: '/r/a', name: 'a', tags: ['fresh'] }), makeFolder({ path: '/r/c', name: 'c' })],
        removedPaths: ['/r/b'],
        epoch: 1,
      });

      expect(store.folders.map((f) => f.path).sort()).toEqual(['/r/a', '/r/c']);
      expect(store.folders.find((f) => f.path === '/r/a')!.tags).toEqual(['fresh']);
    });

    it('upsertFolder() collapses wire rows onto one canonical object per path', () => {
      const store = new FolderStore();
      const first = store.upsertFolder(makeFolder({ path: '/r/a', name: 'a' }));
      const second = store.upsertFolder(makeFolder({ path: '/r/a', name: 'a', nature: 'persona', shortcutCount: 2 }));

      expect(second).toBe(first);
      expect(first.nature).toBe('persona');
      expect(first.shortcutCount).toBe(2);
    });

    it('folders_changed updates flow through the canonical object to holders', () => {
      const store = new FolderStore();
      const pointer = store.upsertFolder(makeFolder({ path: '/r/a', name: 'a' }));

      store.applyFoldersChanged({
        type: 'folders_changed',
        changed: [makeFolder({ path: '/r/a', name: 'a', nature: 'persona' })],
        removedPaths: [],
        epoch: 1,
      });

      expect(pointer.nature).toBe('persona');
    });

    it('folders_changed removals prune the canonical folder objects', () => {
      const store = new FolderStore();
      const gone = store.upsertFolder(makeFolder({ path: '/r/a', name: 'a' }));

      store.applyFoldersChanged({ type: 'folders_changed', changed: [], removedPaths: ['/r/a'], epoch: 1 });
      const readded = store.upsertFolder(makeFolder({ path: '/r/a', name: 'a' }));

      expect(readded).not.toBe(gone);
    });
  });

  describe('in-flight listings vs newer events', () => {
    it('a folders_changed delta during an in-flight window load wins over the older response', async () => {
      const store = new FolderStore();
      const eventRows = [makeFolder({ path: '/r/event', name: 'event' })];
      const staleRows = [makeFolder({ path: '/r/stale', name: 'stale' })];
      let resolveFolders!: (v: unknown) => void;
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_folders') return new Promise((res) => (resolveFolders = res));
        return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
      });

      const load = store.ensureLoaded();
      // The delta arrives while the response is still in flight.
      store.applyFoldersChanged({ type: 'folders_changed', changed: eventRows, removedPaths: [], epoch: 1 });
      resolveFolders(okListFolders(staleRows));
      await load;

      // The stale response is discarded: neither rows nor roots are overwritten.
      expect(store.folders).toEqual(eventRows);
      expect(store.roots).toEqual([]);
    });

    it('accepts a fresh response computed after an interleaved delta', async () => {
      const store = new FolderStore();
      let resolve!: (v: unknown) => void;
      fakeConnection.send.mockImplementation((cmd: any) =>
        cmd.type === 'list_folders'
          ? new Promise((res) => {
              resolve = res;
            })
          : Promise.resolve({ success: true, data: { repos: [] } }),
      );
      const load = store.ensureLoaded();
      store.applyFoldersChanged({ type: 'folders_changed', changed: [makeFolder({ path: '/r/event', name: 'event' })], removedPaths: [], epoch: 4 });
      resolve(okListFolders([makeFolder({ path: '/r/fresh', name: 'fresh' })], ['/fresh-roots'], { epoch: 4 }));
      await load;
      expect(store.folders.map((f) => f.path)).toContain('/r/fresh');
      expect(store.roots).toEqual(['/fresh-roots']);
    });

    it('a pending listing does not wipe sessions seeded by session_state_changed', async () => {
      const store = new FolderStore();
      let resolveSessions!: (v: unknown) => void;
      fakeConnection.send.mockImplementation(() => new Promise((res) => (resolveSessions = res)));

      const load = store.loadSessions('/r/a');
      // The event seeds a session while the listing is in flight.
      store.applySessionStateChange(
        {
          type: 'session_state_changed',
          folderPath: '/r/a',
          sessionId: 'live1',
          liveStatus: 'working',
          connectedClientId: 'other-client',
          folderActiveSessionCount: 1,
        } as Parameters<typeof store.applySessionStateChange>[0],
        'test-client',
      );

      // The listing snapshot predates the event and lacks live1.
      resolveSessions({ success: true, data: { sessions: [makeSession('s1', '2024-01-02T00:00:00Z')] } });
      await load;

      const rows = store.sessions.get('/r/a')!;
      expect(rows.map((s) => s.id).sort()).toEqual(['live1', 's1']);
    });

    it('session_archived during an in-flight listing refetches instead of restoring the archived session', async () => {
      const store = new FolderStore();
      const responses: Array<(v: unknown) => void> = [];
      fakeConnection.send.mockImplementation(() => new Promise((res) => responses.push(res)));

      const s1 = makeSession('s1', '2024-01-01T00:00:00Z');
      store.sessions.set('/r/a', [s1]);

      const load = store.loadSessions('/r/a'); // request taken before the archive
      store.applySessionArchived({ type: 'session_archived', folderPath: '/r/a', sessionId: 's1', archived: true });

      // The pre-archive result still lists s1 — it must not be applied.
      responses[0]({ success: true, data: { sessions: [{ ...s1, name: 'pre-archive' }] } });
      await load;
      await flush();
      expect(store.sessions.get('/r/a')![0].name).toBe('s1');

      // A fresh request went out and its post-archive result applies.
      expect(responses).toHaveLength(2);
      responses[1]({ success: true, data: { sessions: [] } });
      await flush();
      expect(store.sessions.get('/r/a')).toEqual([]);
    });
  });

  describe('visibleFolders', () => {
    it('filters archived folders unless showArchived is set', () => {
      const store = new FolderStore();
      const plain = makeFolder({ path: '/r/a', name: 'a' });
      const archived = makeFolder({ path: '/r/b', name: 'b', archived: true });
      store.folders = [plain, archived];

      store.showArchived = false;
      expect(store.visibleFolders).toEqual([plain]);

      store.showArchived = true;
      expect(store.visibleFolders).toEqual([plain, archived]);
    });

    it('sorts by most recent session activity, name as tiebreak (old-sidebar order)', () => {
      const store = new FolderStore();
      const stale = makeFolder({ path: '/r/stale', name: 'stale' });
      const fresh = makeFolder({ path: '/r/fresh', name: 'zeta' });
      const mid = makeFolder({ path: '/r/mid', name: 'mid' });
      const untouched = makeFolder({ path: '/r/none', name: 'alpha' });
      store.folders = [stale, fresh, mid, untouched];
      store.sessions.set('/r/stale', [makeSession('s1', '2026-01-01T00:00:00Z')]);
      store.sessions.set('/r/fresh', [makeSession('s2', '2026-03-01T00:00:00Z')]);
      store.sessions.set('/r/mid', [makeSession('s3', '2026-02-01T00:00:00Z')]);

      expect(store.visibleFolders).toEqual([fresh, mid, stale, untouched]);
    });

    it('favorites float above the rest; recency applies within each tier', () => {
      const store = new FolderStore();
      const starred = makeFolder({ path: '/r/star', name: 'star', favorite: true });
      const staleStarred = makeFolder({ path: '/r/old-star', name: 'old-star', favorite: true });
      const freshPlain = makeFolder({ path: '/r/fresh', name: 'fresh' });
      store.folders = [freshPlain, staleStarred, starred];
      store.sessions.set('/r/star', [makeSession('s1', '2026-03-01T00:00:00Z')]);
      store.sessions.set('/r/old-star', [makeSession('s2', '2026-01-01T00:00:00Z')]);
      store.sessions.set('/r/fresh', [makeSession('s3', '2026-02-01T00:00:00Z')]);

      expect(store.visibleFolders).toEqual([starred, staleStarred, freshPlain]);
    });

    it('ranks rows by the carried lastActivity fact before their session lists load', () => {
      const store = new FolderStore();
      const sink = makeFolder({ path: '/r/sink', name: 'a-sink' });
      const loaded = makeFolder({ path: '/r/loaded', name: 'b-loaded' });
      const carried = makeFolder({ path: '/r/carried', name: 'c-carried', lastActivity: Date.parse('2026-03-01T00:00:00Z') });
      store.folders = [sink, loaded, carried];
      store.sessions.set('/r/loaded', [makeSession('s1', '2026-01-01T00:00:00Z')]);

      // The row's carried ordering fact outranks loaded-list activity — the
      // client re-sort mirrors the server's pinned order from row data alone.
      expect(store.visibleFolders).toEqual([carried, loaded, sink]);
    });

    it('rows with live sessions rank as most-recent regardless of file activity', () => {
      const store = new FolderStore();
      const active = makeFolder({ path: '/r/active', name: 'z-active', activeSessionCount: 1 });
      const fresh = makeFolder({ path: '/r/fresh2', name: 'a-fresh2', lastActivity: Date.parse('2026-03-01T00:00:00Z') });
      store.folders = [fresh, active];

      expect(store.visibleFolders).toEqual([active, fresh]);
    });
  });

  describe('loadFolders', () => {
    it('single-flights concurrent calls without enumerating sessions', async () => {
      const store = new FolderStore();
      const folders = [makeFolder({ path: '/r/a', name: 'a' }), makeFolder({ path: '/r/b', name: 'b' })];

      let resolveFolders!: (v: unknown) => void;
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_folders') {
          return new Promise((res) => (resolveFolders = res));
        }
        if (cmd.type === 'list_sessions') {
          return Promise.resolve({ success: true, data: { sessions: [] } });
        }
        throw new Error(`Unexpected command: ${cmd.type}`);
      });

      expect(store.loading).toBe(false);
      const p1 = store.loadFolders();
      const p2 = store.loadFolders();
      expect(store.loading).toBe(true);

      // One list_folders send for both callers.
      expect(fakeConnection.send).toHaveBeenCalledTimes(1);
      expect(fakeConnection.send.mock.calls[0][0]).toMatchObject({ type: 'list_folders' });

      resolveFolders(okListFolders(folders));
      await Promise.all([p1, p2]);

      expect(store.folders).toEqual(folders);
      expect(store.roots).toEqual(['/roots']);
      expect(store.loading).toBe(false);

      const sessionCommands = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_sessions');
      expect(sessionCommands).toEqual([]);
    });

    it('shows folders without loading any session lists until a visible row requests them', async () => {
      const store = new FolderStore();
      const folders = [makeFolder({ path: '/r/a', name: 'a' })];
      routeSends({
        list_folders: () => okListFolders(folders),
        list_repos: () => ({ success: true, data: { repos: [] } }),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });
      await store.loadFolders();
      expect(store.folders).toEqual(folders);
      expect(store.loading).toBe(false);
      expect(fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_sessions')).toEqual([]);
      await store.loadSessions('/r/a');
      expect(store.sessions.get('/r/a')).toEqual([]);
    });

    it('a failed load resets loading and leaves state intact', async () => {
      const store = new FolderStore();
      fakeConnection.send.mockRejectedValue(new Error('WebSocket closed'));

      await expect(store.loadFolders()).resolves.toBeUndefined();
      expect(store.loading).toBe(false);
      expect(store.folders).toEqual([]);
    });
  });

  describe('ensureLoaded', () => {
    it('serves a warm cache: a second call sends nothing', async () => {
      const store = new FolderStore();
      routeSends({
        list_folders: () => okListFolders([makeFolder({ path: '/r/a', name: 'a' })]),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });

      await store.ensureLoaded();
      const sendsAfterFirstLoad = fakeConnection.send.mock.calls.length;

      await store.ensureLoaded();
      expect(fakeConnection.send.mock.calls.length).toBe(sendsAfterFirstLoad);
    });

    it('reconnect loads list_folders exactly once per connection', async () => {
      routeSends({
        list_folders: () => okListFolders([makeFolder({ path: '/r/a', name: 'a' })]),
        list_repos: () => ({ success: true, data: { repos: [] } }),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });
      // The disconnect listeners reach the module-scope singleton only.
      for (const cb of disconnectListeners) cb(); // start from an invalidated store

      await folderStore.ensureLoaded();
      await folderStore.ensureLoaded();
      expect(fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders')).toHaveLength(1);

      for (const cb of disconnectListeners) cb(); // the socket drop invalidates the connection
      await folderStore.ensureLoaded();
      await folderStore.ensureLoaded(); // warm again: no refetch
      expect(fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders')).toHaveLength(2);
    });

    it('refetches after a disconnect invalidates the connection', async () => {
      routeSends({
        list_folders: () => okListFolders([makeFolder({ path: '/r/a', name: 'a' })]),
        list_repos: () => ({ success: true, data: { repos: [] } }),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });
      expect(disconnectListeners.size).toBeGreaterThan(0);
      for (const cb of disconnectListeners) cb(); // start from an invalidated store

      await folderStore.ensureLoaded();
      const sendsAfterFirstLoad = fakeConnection.send.mock.calls.length;
      await folderStore.ensureLoaded(); // warm cache: no new sends
      expect(fakeConnection.send.mock.calls.length).toBe(sendsAfterFirstLoad);

      for (const cb of disconnectListeners) cb();
      await folderStore.ensureLoaded(); // fresh connection: refetches
      expect(fakeConnection.send.mock.calls.length).toBeGreaterThan(sendsAfterFirstLoad);
    });

    it('does not mark the connection loaded when the fetch fails', async () => {
      const store = new FolderStore();
      fakeConnection.send.mockRejectedValueOnce(new Error('WebSocket closed'));
      routeSends({
        list_folders: () => okListFolders([makeFolder({ path: '/r/a', name: 'a' })]),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });

      await store.ensureLoaded();
      await store.ensureLoaded();

      const listFoldersSends = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders');
      expect(listFoldersSends).toHaveLength(2);
    });

    it('loadFolders() still forces a refresh past a warm cache', async () => {
      const store = new FolderStore();
      routeSends({
        list_folders: () => okListFolders([makeFolder({ path: '/r/a', name: 'a' })]),
        list_sessions: () => ({ success: true, data: { sessions: [] } }),
      });

      await store.ensureLoaded();
      await store.loadFolders();
      expect(fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders')[1][0]).toMatchObject({ repin: true });

      const listFoldersSends = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders');
      expect(listFoldersSends).toHaveLength(2);
    });
  });

  describe('windowed folder fetching', () => {
    it('ensureLoaded fetches the first window under the connection pin and adopts the returned orderToken', async () => {
      const store = new FolderStore();
      const sends: any[] = [];
      fakeConnection.send.mockImplementation((cmd: any) => {
        sends.push(cmd);
        if (cmd.type === 'list_folders') {
          return Promise.resolve(okListFolders([makeFolder({ path: '/r/a', name: 'a' })], ['/roots'], { total: 40, orderToken: 'tok-1', more: true }));
        }
        return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
      });

      await store.ensureLoaded();
      await store.fetchNextWindow();

      const windows = sends.filter((c) => c.type === 'list_folders');
      expect(windows[0]).not.toHaveProperty('orderToken'); // omitted → reuse the connection's open-time pin
      expect(windows[1]).toMatchObject({ orderToken: 'tok-1', offset: 1 });
    });

    it('fetchNextWindow merges the next window by canonical path without duplicating rows', async () => {
      const store = new FolderStore();
      const a = makeFolder({ path: '/r/a', name: 'a' });
      const b = makeFolder({ path: '/r/b', name: 'b' });
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_folders') {
          if ((cmd.offset ?? 0) === 0) return Promise.resolve(okListFolders([a], ['/roots'], { total: 2, orderToken: 'tok-1', more: true }));
          // A mid-scroll re-pin: the window overlaps an already-cached row.
          return Promise.resolve(okListFolders([a, b], ['/roots'], { total: 2, orderToken: 'tok-2', more: false }));
        }
        return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
      });

      await store.ensureLoaded();
      await store.fetchNextWindow();

      expect(store.folders.map((f) => f.path).sort()).toEqual(['/r/a', '/r/b']);
    });

    it('fetchNextWindow makes no request once the last window reported more=false', async () => {
      const store = new FolderStore();
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_folders') {
          return Promise.resolve(okListFolders([makeFolder({ path: '/r/a', name: 'a' })], ['/roots'], { total: 1, orderToken: 'tok-1', more: false }));
        }
        return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
      });

      await store.ensureLoaded();
      fakeConnection.send.mockClear();
      await store.fetchNextWindow();

      expect(fakeConnection.send).not.toHaveBeenCalled();
    });

    it('continuation windows key off the fetched frontier, not the display tail', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        // 100 prefix rows (fetched window 0) sort above 47 cached extras whose
        // pin positions sit in unfetched territory — the shape a query merge
        // or a delta leaves behind: a hole between the fetched prefix and the
        // extras at the display tail.
        const prefix = Array.from({ length: 100 }, (_, i) => makeFolder({ path: `/p/pad${i}`, name: `pad${i}`, lastActivity: 2_000 - i }));
        const extras = Array.from({ length: 47 }, (_, i) => makeFolder({ path: `/p/low${i}`, name: `low${i}`, lastActivity: 100 - i }));
        fakeConnection.send.mockImplementation((cmd: any) => {
          if (cmd.type !== 'list_folders') return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
          if (cmd.query === 'low') return Promise.resolve(okListFolders(extras, ['/roots'], { total: 47, orderToken: 'tok-1', more: false }));
          return Promise.resolve(okListFolders(prefix, ['/roots'], { total: 147, orderToken: 'tok-1', more: true }));
        });

        await store.ensureLoaded();
        const searching = store.search('low');
        await vi.advanceTimersByTimeAsync(250);
        await searching;
        const clearing = store.search('');
        await vi.advanceTimersByTimeAsync(250);
        await clearing;

        // Display order mirrors the pin: fetched prefix first, then the extras.
        expect(store.visibleFolders.slice(0, 100).map((f) => f.name)).toEqual(prefix.map((f) => f.name));
        expect(store.visibleFolders.slice(100).map((f) => f.name)).toEqual(extras.map((f) => f.name));
        // The next window's rows insert at the frontier (index 100). The view
        // past that point must fetch — its rendered rows face the insertion —
        // even though the display tail (147) is still far away.
        expect(store.shouldFetchNextWindow(130)).toBe(true);
        // A view short of the frontier lets the rows above it settle first.
        expect(store.shouldFetchNextWindow(85)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('with a contiguous fetched prefix the trigger sits at the display tail', async () => {
      const store = new FolderStore();
      const prefix = Array.from({ length: 100 }, (_, i) => makeFolder({ path: `/p/pad${i}`, name: `pad${i}`, lastActivity: 2_000 - i }));
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type !== 'list_folders') return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
        return Promise.resolve(okListFolders(prefix, ['/roots'], { total: 300, orderToken: 'tok-1', more: true }));
      });

      await store.ensureLoaded();

      expect(store.shouldFetchNextWindow(90)).toBe(true);
      expect(store.shouldFetchNextWindow(85)).toBe(false);
    });

    it('search is debounced (250ms) and fetches the offset-0 window for the query, merging matches in', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        const sends: any[] = [];
        fakeConnection.send.mockImplementation((cmd: any) => {
          sends.push(cmd);
          if (cmd.type === 'list_folders') {
            return Promise.resolve(okListFolders([makeFolder({ path: '/r/far', name: 'far' })], ['/roots'], { total: 1, orderToken: 'tok-1', more: false }));
          }
          return Promise.resolve({ success: true, data: { sessions: [], repos: [] } });
        });

        const searches = [store.search('alp'), store.search('alph')].map((p) => p.catch(() => {}));
        await vi.advanceTimersByTimeAsync(250);
        await Promise.all(searches);

        const windows = sends.filter((c) => c.type === 'list_folders');
        expect(windows).toHaveLength(1); // rapid calls coalesce into one fetch
        expect(windows[0]).toMatchObject({ query: 'alph', offset: 0 });
        // Server-authoritative matches merge into the cache, fetched or not.
        expect(store.folders.map((f) => f.path)).toEqual(['/r/far']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('with a query active, fetchNextWindow fetches further match windows for that query', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        const sends: any[] = [];
        fakeConnection.send.mockImplementation((cmd: any) => {
          sends.push(cmd);
          return Promise.resolve(okListFolders([makeFolder({ path: '/r/a', name: 'a' })], ['/roots'], { total: 5, orderToken: 'tok-1', more: true }));
        });
        const search = store.search('alp');
        void search.catch(() => {});
        await vi.advanceTimersByTimeAsync(250);
        await search;
        await store.fetchNextWindow();
        const windows = sends.filter((c) => c.type === 'list_folders');
        expect(windows[1]).toMatchObject({ query: 'alp', offset: 1 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('query views and recoverable errors', () => {
    it('server-authoritative search filters the view while preserving accumulated cache and narrowing session-only matches', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        const cached = makeFolder({ path: '/r/local', name: 'needle-local' });
        const match = makeFolder({ path: '/r/far', name: 'unrelated', matchedSessionIds: ['matched'] });
        store.folders = [cached];
        store.sessions.set(match.path, [makeSession('matched', '2024-01-01T00:00:00Z'), makeSession('other', '2024-01-01T00:00:00Z')]);
        routeSends({ list_folders: () => okListFolders([match]), list_repos: () => ({ success: true, data: { repos: [] } }) });
        const search = store.search('needle');
        void search.catch(() => {}); // attach immediately while fake timers advance
        await vi.advanceTimersByTimeAsync(250);
        await search;
        expect(store.folders.map((f) => f.path).sort()).toEqual(['/r/far', '/r/local']);
        expect(store.visibleFolders.map((f) => f.path)).toEqual(['/r/far']);
        expect(store.visibleSessions(match.path).map((s) => s.id)).toEqual(['matched']);
        expect(fakeConnection.send.mock.calls.every(([c]: any[]) => c.type !== 'list_sessions')).toBe(true);
        const clear = store.search('');
        void clear.catch(() => {});
        await vi.advanceTimersByTimeAsync(250);
        await clear;
        expect(store.visibleFolders.map((f) => f.path)).toContain('/r/local');
        expect(
          store
            .visibleSessions(match.path)
            .map((s) => s.id)
            .sort(),
        ).toEqual(['matched', 'other']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('folder-tier query matches show all loaded sessions under an active query', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        const folder = makeFolder({ path: '/r/a', name: 'needle' });
        store.sessions.set(folder.path, [makeSession('one', '2024-01-01T00:00:00Z'), makeSession('two', '2024-01-01T00:00:00Z')]);
        routeSends({ list_folders: () => okListFolders([folder]) });
        const search = store.search('needle');
        void search.catch(() => {});
        await vi.advanceTimersByTimeAsync(250);
        await search;
        expect(store.visibleSessions(folder.path).map((s) => s.id)).toEqual(['one', 'two']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('failed continuation preserves rows and can retry the same window', async () => {
      const store = new FolderStore();
      const a = makeFolder({ path: '/r/a', name: 'a' });
      routeSends({ list_folders: () => okListFolders([a], [], { more: true, total: 2 }), list_repos: () => ({ success: true, data: { repos: [] } }) });
      await store.ensureLoaded();
      fakeConnection.send.mockRejectedValueOnce(new Error('offline'));
      await store.fetchNextWindow();
      expect(store.folders).toEqual([a]);
      routeSends({
        list_folders: (cmd) => {
          expect(cmd.offset).toBe(1);
          return okListFolders([makeFolder({ path: '/r/b', name: 'b' })]);
        },
      });
      await store.fetchNextWindow();
      expect(store.folders.map((f) => f.path).sort()).toEqual(['/r/a', '/r/b']);
    });

    it('failed search preserves cache and can retry', async () => {
      vi.useFakeTimers();
      try {
        const store = new FolderStore();
        const cached = makeFolder({ path: '/r/a', name: 'a' });
        store.folders = [cached];
        fakeConnection.send.mockRejectedValueOnce(new Error('offline'));
        const failed = store.search('needle');
        void failed.catch(() => {});
        await vi.advanceTimersByTimeAsync(250);
        await failed;
        expect(store.folders).toEqual([cached]);
        routeSends({ list_folders: () => okListFolders([makeFolder({ path: '/r/b', name: 'b' })]) });
        const retry = store.search('needle');
        void retry.catch(() => {});
        await vi.advanceTimersByTimeAsync(250);
        await retry;
        expect(store.folders.map((f) => f.path).sort()).toEqual(['/r/a', '/r/b']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('loadRepos', () => {
    it('populates the repo index for create/manage flows', async () => {
      const store = new FolderStore();
      const repos = [{ path: '/r/a', name: 'a', branch: 'main', dirty: false, ahead: 0, behind: 0 }];
      routeSends({ list_repos: () => ({ success: true, data: { repos } }) });

      await store.loadRepos();

      expect(fakeConnection.send).toHaveBeenCalledWith({ type: 'list_repos' });
      expect(store.repos).toEqual(repos);
    });
  });

  describe('session loads', () => {
    it('correlates by path: concurrent loads for one path single-flight', async () => {
      const store = new FolderStore();

      let resolveSessions!: (v: unknown) => void;
      fakeConnection.send.mockImplementation(
        () =>
          new Promise((res) => {
            resolveSessions = res;
          }),
      );

      const p1 = store.loadSessions('/r/a');
      const p2 = store.loadSessions('/r/a');

      // Same flags → one in-flight request, one send.
      expect(fakeConnection.send).toHaveBeenCalledTimes(1);

      const sessions = [makeSession('s1', '2024-01-02T00:00:00Z')];
      resolveSessions({ success: true, data: { sessions } });
      await Promise.all([p1, p2]);

      expect(store.sessions.get('/r/a')).toEqual(sessions);
    });

    it('correlates by path: a stale response never clobbers a newer load', async () => {
      const store = new FolderStore();
      const responses: Array<(v: unknown) => void> = [];
      fakeConnection.send.mockImplementation(
        () =>
          new Promise((res) => {
            responses.push(res);
          }),
      );

      const stale = store.loadSessions('/r/a'); // includeArchived=false
      store.showArchived = true;
      const fresh = store.loadSessions('/r/a'); // new flags → new request

      // Fresh request finishes first…
      const freshSessions = [makeSession('s2', '2024-01-03T00:00:00Z')];
      responses[1]({ success: true, data: { sessions: freshSessions } });
      await fresh;
      expect(store.sessions.get('/r/a')).toEqual(freshSessions);

      // …then the stale response lands and must be dropped.
      const staleSessions = [makeSession('s1', '2024-01-01T00:00:00Z')];
      responses[0]({ success: true, data: { sessions: staleSessions } });
      await stale;
      expect(store.sessions.get('/r/a')).toEqual(freshSessions);

      await flush();
      // In-flight entry cleaned up — a new load sends again and resolves fresh.
      const third = store.loadSessions('/r/a');
      responses[2]({ success: true, data: { sessions: freshSessions } });
      await third;
      expect(fakeConnection.send).toHaveBeenCalledTimes(3);
    });

    it('setShowArchived persists the preference and reloads only loaded session lists', async () => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      });
      try {
        const store = new FolderStore();
        expect(store.showArchived).toBe(false);
        store.folders = [makeFolder({ path: '/r/a', name: 'a' }), makeFolder({ path: '/r/b', name: 'b' })];
        store.sessions.set('/r/a', []);
        routeSends({ list_sessions: (cmd) => ({ success: true, data: { sessions: cmd.includeArchived ? [makeSession('s1', '2024-01-01T00:00:00Z')] : [] } }) });

        store.setShowArchived(true);
        await flush();

        const cmd = fakeConnection.send.mock.calls.find(([c]: any[]) => c.type === 'list_sessions')?.[0];
        expect(cmd).toMatchObject({ type: 'list_sessions', folderPath: '/r/a', includeArchived: true });
        expect(store.sessions.get('/r/a')).toHaveLength(1);
        expect(fakeConnection.send).toHaveBeenCalledTimes(1);
        expect(store.sessions.has('/r/b')).toBe(false);

        await store.loadSessions('/r/b');
        expect(fakeConnection.send).toHaveBeenLastCalledWith({ type: 'list_sessions', folderPath: '/r/b', includeArchived: true });
        expect(store.sessions.get('/r/b')).toHaveLength(1);

        // The preference round-trips into a fresh store instance.
        expect(new FolderStore().showArchived).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
