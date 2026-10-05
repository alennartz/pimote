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

function okListFolders(folders: FolderInfo[], roots: string[] = ['/roots']) {
  return { success: true, data: { folders, roots } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeConnection.send.mockReset();
});

describe('FolderStore', () => {
  describe('module-scope event routing', () => {
    it('folders_changed replaces the folder list', () => {
      expect(eventListeners.size).toBeGreaterThan(0);

      const listener = [...eventListeners].at(-1)!;
      const next = [makeFolder({ path: '/r/new', name: 'new' })];
      listener({ type: 'folders_changed', folders: next } as PimoteEvent);

      expect(folderStore.folders).toEqual(next);
    });

    it('folders_changed replaces the list without wiping live session indicators', () => {
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

      // A folder broadcast replaces the whole list; the new rows carry the
      // live counts and the sessions map keeps its liveStatus entry.
      const next = [makeFolder({ path: '/r/live', name: 'live', activeSessionCount: 1 })];
      listener({ type: 'folders_changed', folders: next } as PimoteEvent);

      expect(folderStore.folders).toEqual(next);
      expect(folderStore.folders[0].activeSessionCount).toBe(1);
      const sessions = folderStore.sessions.get('/r/live');
      expect(sessions).toHaveLength(1);
      expect(sessions![0]).toMatchObject({ id: 's1', liveStatus: 'working' });
      folderStore.sessions.delete('/r/live');
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

    it('applyFoldersChanged() replaces the whole list', () => {
      const store = new FolderStore();
      store.folders = [makeFolder({ path: '/r/old', name: 'old' })];

      const next = [makeFolder({ path: '/r/a', name: 'a' }), makeFolder({ path: '/r/b', name: 'b' })];
      store.applyFoldersChanged({ type: 'folders_changed', folders: next });

      expect(store.folders).toEqual(next);
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
  });

  describe('loadFolders', () => {
    it('single-flights concurrent calls and seeds per-folder session loads', async () => {
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
      expect(fakeConnection.send).toHaveBeenCalledWith({ type: 'list_folders' });

      resolveFolders(okListFolders(folders));
      await Promise.all([p1, p2]);

      expect(store.folders).toEqual(folders);
      expect(store.roots).toEqual(['/roots']);
      expect(store.loading).toBe(false);

      // Session loads seeded per folder path, keyed by path in the map.
      const sessionCommands = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_sessions');
      expect(sessionCommands.map(([c]: any[]) => c.folderPath)).toEqual(['/r/a', '/r/b']);
      expect(store.sessions.get('/r/a')).toEqual([]);
      expect(store.sessions.get('/r/b')).toEqual([]);
    });

    it('shows the folder list before the per-folder session loads finish', async () => {
      const store = new FolderStore();
      const folders = [makeFolder({ path: '/r/a', name: 'a' })];
      let resolveSessions!: (v: unknown) => void;
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_folders') return Promise.resolve(okListFolders(folders));
        if (cmd.type === 'list_repos') return Promise.resolve({ success: true, data: { repos: [] } });
        if (cmd.type === 'list_sessions') return new Promise((res) => (resolveSessions = res));
        throw new Error(`Unexpected command: ${cmd.type}`);
      });

      const load = store.loadFolders();
      await flush();

      // Folders are assigned and the spinner is down while list_sessions is
      // still in flight — the list must not wait on session metadata.
      expect(store.folders).toEqual(folders);
      expect(store.loading).toBe(false);
      expect(store.sessions.has('/r/a')).toBe(false);

      resolveSessions({ success: true, data: { sessions: [makeSession('s1', '2026-01-01T00:00:00Z')] } });
      await load;
      expect(store.sessions.get('/r/a')).toHaveLength(1);
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

      const listFoldersSends = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_folders');
      expect(listFoldersSends).toHaveLength(2);
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

    it('setShowArchived persists the preference and reloads sessions per folder', async () => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      });
      try {
        const store = new FolderStore();
        expect(store.showArchived).toBe(false);
        store.folders = [makeFolder({ path: '/r/a', name: 'a' })];
        routeSends({ list_sessions: (cmd) => ({ success: true, data: { sessions: cmd.includeArchived ? [makeSession('s1', '2024-01-01T00:00:00Z')] : [] } }) });

        store.setShowArchived(true);
        await flush();

        const cmd = fakeConnection.send.mock.calls.find(([c]: any[]) => c.type === 'list_sessions')?.[0];
        expect(cmd).toMatchObject({ type: 'list_sessions', folderPath: '/r/a', includeArchived: true });
        expect(store.sessions.get('/r/a')).toHaveLength(1);

        // The preference round-trips into a fresh store instance.
        expect(new FolderStore().showArchived).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
