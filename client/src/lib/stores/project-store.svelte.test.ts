import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PimoteEvent, ProjectInfo } from '@pimote/shared';

const { fakeConnection, eventListeners } = vi.hoisted(() => {
  const eventListeners = new Set<(event: unknown) => void>();
  const fakeConnection = {
    clientId: 'test-client',
    send: vi.fn(),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
  };
  return { fakeConnection, eventListeners };
});

vi.mock('$lib/stores/connection.svelte.js', () => ({ connection: fakeConnection }));

const { ProjectStore, projectStore } = await import('./project-store.svelte.js');

function makeProject(overrides: Partial<ProjectInfo> & Pick<ProjectInfo, 'path' | 'name'>): ProjectInfo {
  return { kind: 'single', activeSessionCount: 0, externalProcessCount: 0, ...overrides };
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

function okListProjects(projects: ProjectInfo[], roots: string[] = ['/roots']) {
  return { success: true, data: { projects, roots } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeConnection.send.mockReset();
});

describe('ProjectStore', () => {
  describe('projects_changed routing', () => {
    it('module-scope subscription replaces the project list', () => {
      expect(eventListeners.size).toBeGreaterThan(0);

      const listener = [...eventListeners].at(-1)!;
      const next = [makeProject({ path: '/r/new', name: 'new' })];
      listener({ type: 'projects_changed', projects: next } as PimoteEvent);

      expect(projectStore.projects).toEqual(next);
    });

    it('ignores non-projects_changed events', () => {
      const listener = [...eventListeners].at(-1)!;
      const before = projectStore.projects;
      listener({ type: 'session_renamed', sessionId: 's1', name: 'x' } as PimoteEvent);
      expect(projectStore.projects).toBe(before);
    });

    it('applyProjectsChanged() replaces the whole list', () => {
      const store = new ProjectStore();
      store.projects = [makeProject({ path: '/r/old', name: 'old' })];

      const next = [makeProject({ path: '/r/a', name: 'a' }), makeProject({ path: '/r/b', name: 'b' })];
      store.applyProjectsChanged({ type: 'projects_changed', projects: next });

      expect(store.projects).toEqual(next);
    });
  });

  describe('visibleProjects', () => {
    it('filters archived projects unless showArchived is set', () => {
      const store = new ProjectStore();
      const plain = makeProject({ path: '/r/a', name: 'a' });
      const archived = makeProject({ path: '/r/b', name: 'b', archived: true });
      store.projects = [plain, archived];

      store.showArchived = false;
      expect(store.visibleProjects).toEqual([plain]);

      store.showArchived = true;
      expect(store.visibleProjects).toEqual([plain, archived]);
    });

    it('sorts by most recent session activity, name as tiebreak (old-sidebar order)', () => {
      const store = new ProjectStore();
      const stale = makeProject({ path: '/r/stale', name: 'stale' });
      const fresh = makeProject({ path: '/r/fresh', name: 'zeta' });
      const mid = makeProject({ path: '/r/mid', name: 'mid' });
      const untouched = makeProject({ path: '/r/none', name: 'alpha' });
      store.projects = [stale, fresh, mid, untouched];
      store.sessions.set('/r/stale', [makeSession('s1', '2026-01-01T00:00:00Z')]);
      store.sessions.set('/r/fresh', [makeSession('s2', '2026-03-01T00:00:00Z')]);
      store.sessions.set('/r/mid', [makeSession('s3', '2026-02-01T00:00:00Z')]);

      expect(store.visibleProjects).toEqual([fresh, mid, stale, untouched]);
    });

    it('manually ordered projects keep their curated position ahead of recency', () => {
      const store = new ProjectStore();
      const pinned = makeProject({ path: '/r/pin', name: 'pin', order: 0 });
      const active = makeProject({ path: '/r/active', name: 'active' });
      store.projects = [active, pinned];
      store.sessions.set('/r/active', [makeSession('s1', '2026-03-01T00:00:00Z')]);
      store.sessions.set('/r/pin', [makeSession('s2', '2026-01-01T00:00:00Z')]);

      expect(store.visibleProjects).toEqual([pinned, active]);
    });
  });

  describe('loadProjects', () => {
    it('single-flights concurrent calls and seeds per-project session loads', async () => {
      const store = new ProjectStore();
      const projects = [makeProject({ path: '/r/a', name: 'a' }), makeProject({ path: '/r/b', name: 'b' })];

      let resolveProjects!: (v: unknown) => void;
      fakeConnection.send.mockImplementation((cmd: any) => {
        if (cmd.type === 'list_projects') {
          return new Promise((res) => (resolveProjects = res));
        }
        if (cmd.type === 'list_sessions') {
          return Promise.resolve({ success: true, data: { sessions: [] } });
        }
        throw new Error(`Unexpected command: ${cmd.type}`);
      });

      expect(store.loading).toBe(false);
      const p1 = store.loadProjects();
      const p2 = store.loadProjects();
      expect(store.loading).toBe(true);

      // One list_projects send for both callers.
      expect(fakeConnection.send).toHaveBeenCalledTimes(1);
      expect(fakeConnection.send).toHaveBeenCalledWith({ type: 'list_projects' });

      resolveProjects(okListProjects(projects));
      await Promise.all([p1, p2]);

      expect(store.projects).toEqual(projects);
      expect(store.roots).toEqual(['/roots']);
      expect(store.loading).toBe(false);

      // Session loads seeded per project path, keyed by path in the map.
      const sessionCommands = fakeConnection.send.mock.calls.filter(([c]: any[]) => c.type === 'list_sessions');
      expect(sessionCommands.map(([c]: any[]) => c.folderPath)).toEqual(['/r/a', '/r/b']);
      expect(store.sessions.get('/r/a')).toEqual([]);
      expect(store.sessions.get('/r/b')).toEqual([]);
    });

    it('a failed load resets loading and leaves state intact', async () => {
      const store = new ProjectStore();
      fakeConnection.send.mockRejectedValue(new Error('WebSocket closed'));

      await expect(store.loadProjects()).resolves.toBeUndefined();
      expect(store.loading).toBe(false);
      expect(store.projects).toEqual([]);
    });
  });

  describe('loadRepos', () => {
    it('populates the repo index for create/manage flows', async () => {
      const store = new ProjectStore();
      const repos = [{ path: '/r/a', name: 'a', branch: 'main', dirty: false, ahead: 0, behind: 0 }];
      routeSends({ list_repos: () => ({ success: true, data: { repos } }) });

      await store.loadRepos();

      expect(fakeConnection.send).toHaveBeenCalledWith({ type: 'list_repos' });
      expect(store.repos).toEqual(repos);
    });
  });

  describe('session loads', () => {
    it('correlates by path: concurrent loads for one path single-flight', async () => {
      const store = new ProjectStore();

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
      const store = new ProjectStore();
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

    it('setShowArchived persists the preference and reloads sessions per project', async () => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      });
      try {
        const store = new ProjectStore();
        expect(store.showArchived).toBe(false);
        store.projects = [makeProject({ path: '/r/a', name: 'a' })];
        routeSends({ list_sessions: (cmd) => ({ success: true, data: { sessions: cmd.includeArchived ? [makeSession('s1', '2024-01-01T00:00:00Z')] : [] } }) });

        store.setShowArchived(true);
        await flush();

        const cmd = fakeConnection.send.mock.calls.find(([c]: any[]) => c.type === 'list_sessions')?.[0];
        expect(cmd).toMatchObject({ type: 'list_sessions', folderPath: '/r/a', includeArchived: true });
        expect(store.sessions.get('/r/a')).toHaveLength(1);

        // The preference round-trips into a fresh store instance.
        expect(new ProjectStore().showArchived).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
