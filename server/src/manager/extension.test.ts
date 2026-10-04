import { describe, it, expect, vi } from 'vitest';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { DiskSessionRecord, ManagerToolContext, ManagerSessionSummary } from './types.js';

// Minimal fake ExtensionAPI: records registerTool defs and hands back
// observable port-routing behavior when the tests drive `execute` directly.
function makeFakePi(): { toolDefs: Array<{ name: string; execute: (...args: unknown[]) => unknown }>; api: any } {
  const toolDefs: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
  const api = {
    registerTool(def: any) {
      toolDefs.push(def);
    },
    on() {},
    events: { emit() {}, on: () => () => {} },
  };
  return { toolDefs, api: api as any };
}

const MANAGER_TOOL_NAMES = ['pimote_list_projects', 'pimote_list_repos', 'pimote_list_sessions', 'pimote_search_sessions', 'pimote_start_session', 'pimote_archive_sessions'];

function spyPorts() {
  return {
    sessions: {
      getAllSessions: vi.fn(() => [] as ManagerSessionSummary[]),
      listDiskSessions: vi.fn(async (_folderPath: string) => [] as DiskSessionRecord[]),
      openSession: vi.fn(async (_folderPath: string, _firstMessage?: string) => 'session-new'),
      archiveSessions: vi.fn(async (_sessionIds: string[]) => []),
    },
    projects: { list: vi.fn(async () => [] as FolderInfo[]) },
    repos: { list: vi.fn(async () => []) },
  };
}

function makeContext(ports: ReturnType<typeof spyPorts>): ManagerToolContext {
  return { ...ports, config: { roots: ['/tmp'], idleTimeout: 1_000, bufferSize: 10, port: 3000 } };
}

function makeFolder(path: string): FolderInfo {
  return {
    path,
    name: path.split('/').pop() ?? path,
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

function makeRecord(overrides: Partial<DiskSessionRecord> & { id: string }): DiskSessionRecord {
  return { name: undefined, firstMessage: '', created: '2025-01-01T00:00:00.000Z', modified: '2025-01-01T00:00:00.000Z', messageCount: 1, archived: false, ...overrides };
}

describe('createManagerExtension()', () => {
  it('registers exactly the pinned pimote toolset on the extension API', () => {
    const { toolDefs, api } = makeFakePi();
    const factory = createManagerExtension(makeContext(spyPorts()));

    factory(api);

    expect(toolDefs.map((t) => t.name)).toEqual(MANAGER_TOOL_NAMES);
  });

  it('routes each listing tool through the injected context ports', async () => {
    const ports = spyPorts();
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);

    for (const name of ['pimote_list_projects', 'pimote_list_repos', 'pimote_list_sessions']) {
      const def = toolDefs.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      await def!.execute('call-1', {}, undefined, undefined, {});
    }

    expect(ports.projects.list).toHaveBeenCalledTimes(1);
    expect(ports.repos.list).toHaveBeenCalledTimes(1);
    // Called by pimote_list_sessions and by the projects tool's live-count
    // enrichment.
    expect(ports.sessions.getAllSessions).toHaveBeenCalledTimes(2);
  });
});

describe('pimote_search_sessions', () => {
  function searchTool(ports: ReturnType<typeof spyPorts>) {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);
    const def = toolDefs.find((t) => t.name === 'pimote_search_sessions');
    if (!def) throw new Error('pimote_search_sessions not registered');
    return def;
  }

  it('matches name and firstMessage across every project, newest first, with open state and excerpts', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
    ports.sessions.listDiskSessions.mockImplementation(async (folderPath: string) => {
      if (folderPath === '/w/alpha') {
        return [
          makeRecord({ id: 's1', name: 'Fix login bug', firstMessage: 'the login page 500s', modified: '2025-06-02T10:00:00.000Z', messageCount: 4 }),
          makeRecord({ id: 's2', firstMessage: 'unrelated work', modified: '2025-06-04T10:00:00.000Z' }),
        ];
      }
      return [makeRecord({ id: 's3', firstMessage: `login refactor discussion — ${'context '.repeat(60)}`, modified: '2025-06-03T10:00:00.000Z', archived: true })];
    });
    ports.sessions.getAllSessions.mockReturnValue([{ sessionId: 's1', folderPath: '/w/alpha', status: 'idle', needsAttention: false }]);

    const result = (await searchTool(ports).execute('call-1', { query: 'LOGIN' }, undefined, undefined, {})) as {
      details: { query: string; results: Array<Record<string, unknown>> };
    };

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(2);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha');
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/beta');
    expect(result.details.query).toBe('LOGIN');
    // Newest first: s3 (06-03) before s1 (06-02); s2 never matched.
    expect(result.details.results.map((r) => r.id)).toEqual(['s3', 's1']);
    const [first, second] = result.details.results;
    expect(first.open).toBe(false);
    expect(first.archived).toBe(true);
    expect(first.status).toBeUndefined();
    expect(second.open).toBe(true);
    expect(second.status).toBe('idle');
    expect(second.folderPath).toBe('/w/alpha');
    // Excerpted firstMessage: collapsed whitespace, capped at 200 chars + ellipsis.
    expect((first.firstMessage as string).length).toBe(201);
    expect((first.firstMessage as string).endsWith('…')).toBe(true);
  });

  it('honors the limit, capping above the maximum', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue(
      ['a', 'b', 'c'].map((id) => makeRecord({ id, name: `login ${id}`, modified: `2025-06-0${id.charCodeAt(0) - 96}T10:00:00.000Z` })),
    );

    const tool = searchTool(ports);
    const limited = (await tool.execute('call-1', { query: 'login', limit: 2 }, undefined, undefined, {})) as { details: { results: unknown[] } };
    const uncapped = (await tool.execute('call-2', { query: 'login', limit: 500 }, undefined, undefined, {})) as { details: { results: unknown[] } };

    expect(limited.details.results).toHaveLength(2);
    expect(uncapped.details.results).toHaveLength(3);
  });

  it('searches only the given projectPath when provided', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await searchTool(ports).execute('call-1', { query: 'login', projectPath: '/w/beta' }, undefined, undefined, {})) as {
      details: { results: Array<Record<string, unknown>> };
    };

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(1);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/beta');
    expect(result.details.results[0].folderPath).toBe('/w/beta');
  });

  it('rejects an unknown projectPath without touching the session port', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await searchTool(ports).execute('call-1', { query: 'login', projectPath: '/w/unknown' }, undefined, undefined, {})) as {
      details: { error: string };
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown project');
    expect(ports.sessions.listDiskSessions).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only query', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await searchTool(ports).execute('call-1', { query: '   ' }, undefined, undefined, {})) as { details: { error: string }; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('query is required');
    expect(ports.sessions.listDiskSessions).not.toHaveBeenCalled();
  });
});

describe('pimote_start_session', () => {
  function startTool(ports: ReturnType<typeof spyPorts>) {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);
    const def = toolDefs.find((t) => t.name === 'pimote_start_session');
    if (!def) throw new Error('pimote_start_session not registered');
    return def;
  }

  it('opens a session in a known project and forwards the firstMessage', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-42');

    const result = (await startTool(ports).execute('call-1', { projectPath: '/w/alpha', firstMessage: ' fix the flaky test ' }, undefined, undefined, {})) as {
      details: { sessionId: string; projectPath: string; firstMessageSent: boolean };
    };

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', 'fix the flaky test');
    expect(result.details).toEqual({ sessionId: 'sess-42', projectPath: '/w/alpha', firstMessageSent: true });
  });

  it('opens a session without a firstMessage when none is given', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-43');

    const result = (await startTool(ports).execute('call-1', { projectPath: '/w/alpha' }, undefined, undefined, {})) as { details: { firstMessageSent: boolean } };

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', undefined);
    expect(result.details.firstMessageSent).toBe(false);
  });

  it('rejects an unknown project without opening a session', async () => {
    const ports = spyPorts();
    ports.projects.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await startTool(ports).execute('call-1', { projectPath: '/w/unknown' }, undefined, undefined, {})) as { details: { error: string }; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown project');
    expect(ports.sessions.openSession).not.toHaveBeenCalled();
  });
});

describe('pimote_archive_sessions', () => {
  function archiveTool(ports: ReturnType<typeof spyPorts>) {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);
    const def = toolDefs.find((t) => t.name === 'pimote_archive_sessions');
    if (!def) throw new Error('pimote_archive_sessions not registered');
    return def;
  }

  it('routes the ids through the session port and surfaces per-id outcomes', async () => {
    const ports = spyPorts();
    ports.sessions.archiveSessions.mockResolvedValue([
      { sessionId: 's1', outcome: 'archived' },
      { sessionId: 's2', outcome: 'not_found' },
      { sessionId: 's3', outcome: 'open_slot_evicted' },
    ]);

    const result = (await archiveTool(ports).execute('call-1', { sessionIds: ['s1', 's2', 's3'] }, undefined, undefined, {})) as {
      details: { results: Array<{ sessionId: string; outcome: string }> };
    };

    expect(ports.sessions.archiveSessions).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(result.details.results).toEqual([
      { sessionId: 's1', outcome: 'archived' },
      { sessionId: 's2', outcome: 'not_found' },
      { sessionId: 's3', outcome: 'open_slot_evicted' },
    ]);
  });
});
