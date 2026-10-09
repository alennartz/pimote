import { describe, it, expect, vi } from 'vitest';
import { Value } from 'typebox/value';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { DiskSessionRecord, ManagerToolContext, ManagerSessionSummary } from './types.js';
import type { FolderOccurrence, SparseTree } from '../folder-model/index.js';

// Minimal fake ExtensionAPI: records registerTool defs and hands back
// observable port-routing behavior when the tests drive `execute` directly.
function makeFakePi(): { toolDefs: any[]; api: any } {
  const toolDefs: any[] = [];
  const api = {
    registerTool(def: any) {
      toolDefs.push(def);
    },
    on() {},
    events: { emit() {}, on: () => () => {} },
  };
  return { toolDefs, api: api as any };
}

const MANAGER_TOOL_NAMES = [
  'pimote_list_folders',
  'pimote_folder_tree',
  'pimote_list_repos',
  'pimote_list_sessions',
  'pimote_search_sessions',
  'pimote_start_session',
  'pimote_archive_sessions',
  'pimote_create_persona',
  'pimote_list_personas',
];

function spyPorts() {
  return {
    sessions: {
      getAllSessions: vi.fn(() => [] as ManagerSessionSummary[]),
      listDiskSessions: vi.fn(async (_folderPath: string) => [] as DiskSessionRecord[]),
      openSession: vi.fn(async (_folderPath: string, _firstMessage?: string) => 'session-new'),
      archiveSessions: vi.fn(async (_sessionIds: string[]) => []),
    },
    folders: { list: vi.fn(async () => [] as FolderInfo[]) },
    repos: { list: vi.fn(async () => []), invalidateListing: vi.fn() },
    tree: { tree: vi.fn(async () => ({ occurrences: [] })) },
  };
}

function makeContext(ports: ReturnType<typeof spyPorts>): ManagerToolContext {
  return { ...ports, config: { roots: ['/tmp'], managerRoot: '/srv/manager-home', idleTimeout: 1_000, bufferSize: 10, port: 3000 } };
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

function makePersonaFolder(path: string): FolderInfo {
  return { ...makeFolder(path), nature: 'persona', persona: { name: 'Ada', description: 'helpful agent' } };
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

    for (const name of ['pimote_list_folders', 'pimote_folder_tree', 'pimote_list_repos', 'pimote_list_sessions']) {
      const def = toolDefs.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      await def.execute('call-1', {}, undefined, undefined, {});
    }

    expect(ports.folders.list).toHaveBeenCalledTimes(1);
    expect(ports.tree.tree).toHaveBeenCalledTimes(1);
    expect(ports.repos.list).toHaveBeenCalledTimes(1);
    // Called by pimote_list_sessions and by the folders tool's live-count
    // enrichment.
    expect(ports.sessions.getAllSessions).toHaveBeenCalledTimes(2);
  });

  it('describes folder nature, identity versus reach, and unfiltered repo discovery accurately', () => {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(spyPorts()))(api);
    const descriptionOf = (name: string) => toolDefs.find((t) => t.name === name).description as string;

    // Code/persona nature is explained wherever folders surface.
    expect(descriptionOf('pimote_list_folders')).toContain('code');
    expect(descriptionOf('pimote_list_folders')).toContain('persona');
    // Canonical identity versus reach paths.
    expect(descriptionOf('pimote_folder_tree')).toContain('canonical');
    expect(descriptionOf('pimote_folder_tree')).toContain('reach');
    // Unfiltered repo discovery: the complete code-folder view, persona folders excluded.
    expect(descriptionOf('pimote_list_repos')).toContain('not filtered');
    expect(descriptionOf('pimote_list_repos')).toContain('Persona folders are excluded');
  });
});

describe('pimote_list_folders', () => {
  function listTool(ports: ReturnType<typeof spyPorts>) {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);
    return toolDefs.find((t) => t.name === 'pimote_list_folders');
  }

  it('declares the complete FolderInfo schema: all fields, defaults on the defaulted ones, only persona/repos/userTags optional', () => {
    const def = listTool(spyPorts());
    const schema = def.outputSchema.items;

    expect(Object.keys(schema.properties).sort()).toEqual(
      ['activeSessionCount', 'archived', 'externalProcessCount', 'favorite', 'missing', 'name', 'nature', 'path', 'persona', 'repos', 'shortcutCount', 'tags', 'userTags'].sort(),
    );
    expect([...schema.required].sort()).toEqual(
      ['activeSessionCount', 'archived', 'externalProcessCount', 'favorite', 'missing', 'name', 'nature', 'path', 'shortcutCount', 'tags'].sort(),
    );
    expect(schema.properties.favorite.default).toBe(false);
    expect(schema.properties.archived.default).toBe(false);
    expect(schema.properties.missing.default).toBe(false);
    expect(schema.properties.tags.default).toEqual([]);
    expect(schema.properties.shortcutCount.default).toBe(0);
    expect(schema.properties.activeSessionCount.default).toBe(0);
    expect(schema.properties.externalProcessCount.default).toBe(0);
  });

  it('serves every FolderInfo field with wire defaults, preserving persona and hub metadata', async () => {
    const ports = spyPorts();
    const sparseRow = { path: '/w/alpha', name: 'alpha', nature: 'code' } as FolderInfo;
    const personaRow = makePersonaFolder('/w/personas/ada');
    const hubRow: FolderInfo = {
      ...makeFolder('/w/hubs/mono'),
      shortcutCount: 2,
      favorite: true,
      archived: true,
      tags: ['team', 'own'],
      userTags: ['own'],
      missing: true,
      repos: [{ path: '/w/alpha', name: 'alpha', branch: 'main', dirty: false, ahead: 1, behind: 2, missing: false, tags: ['team'] }],
    };
    ports.folders.list.mockResolvedValue([sparseRow, personaRow, hubRow]);

    const result = (await listTool(ports).execute('call-1', {}, undefined, undefined, {})) as { details: FolderInfo[] };

    const [sparse, persona, hub] = result.details;
    // Defaults materialized on the sparse row.
    expect(sparse).toEqual({
      path: '/w/alpha',
      name: 'alpha',
      nature: 'code',
      shortcutCount: 0,
      favorite: false,
      archived: false,
      tags: [],
      missing: false,
      activeSessionCount: 0,
      externalProcessCount: 0,
    });
    // Persona metadata rides through.
    expect(persona.nature).toBe('persona');
    expect(persona.persona).toEqual({ name: 'Ada', description: 'helpful agent' });
    // Hub metadata rides through.
    expect(hub.repos).toHaveLength(1);
    expect(hub.userTags).toEqual(['own']);
    expect(hub.shortcutCount).toBe(2);
    expect(hub.favorite).toBe(true);
    expect(hub.archived).toBe(true);
    expect(hub.missing).toBe(true);
  });

  it('enriches live session counts from the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([{ ...makeFolder('/w/alpha'), externalProcessCount: 3 }]);
    ports.sessions.getAllSessions.mockReturnValue([
      { sessionId: 's1', folderPath: '/w/alpha', status: 'idle', needsAttention: false },
      { sessionId: 's2', folderPath: '/w/alpha', status: 'working', needsAttention: false },
      { sessionId: 's3', folderPath: '/w/beta', status: 'idle', needsAttention: false },
    ]);

    const result = (await listTool(ports).execute('call-1', {}, undefined, undefined, {})) as { details: FolderInfo[] };

    expect(result.details[0].activeSessionCount).toBe(2);
    expect(result.details[0].externalProcessCount).toBe(3);
  });
});

describe('pimote_folder_tree', () => {
  function treeTool(ports: ReturnType<typeof spyPorts>) {
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);
    return toolDefs.find((t) => t.name === 'pimote_folder_tree');
  }

  const sampleTree: SparseTree = {
    occurrences: [
      {
        path: '/root/hub',
        via: 'scan',
        entry: { path: '/root/hub', name: 'hub', nature: 'code' },
        children: [
          { path: '/root/hub/link', via: 'shortcut', entry: { path: '/external/member', name: 'member', nature: 'code' }, children: [] },
          {
            path: '/root/hub/ada-link',
            via: 'shortcut',
            entry: { path: '/external/ada', name: 'ada', nature: 'persona', persona: { name: 'Ada' } },
            // First-discovery children reused; a cycle back-reference stays a leaf.
            children: [{ path: '/root/hub/ada-link/hub-link', via: 'shortcut', entry: { path: '/root/hub', name: 'hub', nature: 'code' }, children: [] }],
          },
        ],
      },
    ],
  };

  it('is read-only and takes no arguments', () => {
    const def = treeTool(spyPorts());

    expect(def.annotations.readOnlyHint).toBe(true);
    expect(def.parameters.type).toBe('object');
    expect(Object.keys(def.parameters.properties ?? {})).toHaveLength(0);
  });

  it('returns the injected sparse tree as finite, JSON-serializable structured output', async () => {
    const ports = spyPorts();
    ports.tree.tree.mockResolvedValue(sampleTree);

    const result = (await treeTool(ports).execute('call-1', {}, undefined, undefined, {})) as { details: SparseTree };

    expect(ports.tree.tree).toHaveBeenCalledTimes(1);
    expect(result.details).toEqual(sampleTree);
    // Finite and JSON-safe end to end (the scanner guarantees acyclic shapes;
    // the tool must not break that).
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(sampleTree);
  });

  it('declares a recursive occurrence schema (path/via/entry/children) that the output validates against', () => {
    const ports = spyPorts();
    ports.tree.tree.mockResolvedValue(sampleTree);
    const def = treeTool(ports);

    const defs = def.outputSchema.$defs;
    const occurrence = defs.FolderOccurrence;
    expect([...occurrence.required].sort()).toEqual(['children', 'entry', 'path', 'via']);
    // Recursion: children items reference the occurrence schema again.
    expect(occurrence.properties.children.items.$ref).toBe('FolderOccurrence');
    expect(def.outputSchema.$ref).toBe('SparseTree');
    const entry = defs.FolderEntry;
    expect([...entry.required].sort()).toEqual(['name', 'nature', 'path']);
  });

  it('emits tree output that validates against its own recursive schema', async () => {
    const ports = spyPorts();
    ports.tree.tree.mockResolvedValue(sampleTree);
    const def = treeTool(ports);

    const result = await def.execute('call-1', {}, undefined, undefined, {});

    expect(Value.Check(def.outputSchema, result.structuredContent)).toBe(true);
  });

  it('bounds output on a shared-descendant DAG instead of unfolding it exponentially', async () => {
    const ports = spyPorts();
    // Each level carries two occurrences of the same shared child — in memory
    // this is a small DAG, but JSON serialization unfolds it 2^depth times.
    const leaf: FolderOccurrence = { path: '/leaf', via: 'shortcut', entry: { path: '/leaf', name: 'leaf', nature: 'code' }, children: [] };
    let shared: FolderOccurrence = leaf;
    for (let i = 0; i < 30; i++) {
      const entry = { path: `/e${i}`, name: `e${i}`, nature: 'code' as const };
      shared = { path: `/l${i}`, via: 'shortcut', entry, children: [shared, { ...shared, path: `${shared.path}-b` }] };
    }
    ports.tree.tree.mockResolvedValue({ occurrences: [shared] });
    const def = treeTool(ports);

    const result = (await def.execute('call-1', {}, undefined, undefined, {})) as { structuredContent: SparseTree & { truncated?: boolean } };

    // Bounded serialization with an explicit truncation signal, and still
    // schema-valid.
    expect(result.structuredContent.truncated).toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(2_000_000);
    expect(Value.Check(def.outputSchema, result.structuredContent)).toBe(true);
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

  it('matches name and firstMessage across every folder, newest first, with open state and excerpts', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
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
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue(
      ['a', 'b', 'c'].map((id) => makeRecord({ id, name: `login ${id}`, modified: `2025-06-0${id.charCodeAt(0) - 96}T10:00:00.000Z` })),
    );

    const tool = searchTool(ports);
    const limited = (await tool.execute('call-1', { query: 'login', limit: 2 }, undefined, undefined, {})) as { details: { results: unknown[] } };
    const uncapped = (await tool.execute('call-2', { query: 'login', limit: 500 }, undefined, undefined, {})) as { details: { results: unknown[] } };

    expect(limited.details.results).toHaveLength(2);
    expect(uncapped.details.results).toHaveLength(3);
  });

  it('searches only the given folderPath when provided', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await searchTool(ports).execute('call-1', { query: 'login', folderPath: '/w/beta' }, undefined, undefined, {})) as {
      details: { results: Array<Record<string, unknown>> };
    };

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(1);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/beta');
    expect(result.details.results[0].folderPath).toBe('/w/beta');
  });

  it('searches persona folders', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makePersonaFolder('/w/personas/ada')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await searchTool(ports).execute('call-1', { query: 'login', folderPath: '/w/personas/ada' }, undefined, undefined, {})) as {
      details: { results: Array<Record<string, unknown>> };
    };

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/personas/ada');
    expect(result.details.results[0].folderPath).toBe('/w/personas/ada');
  });

  it('rejects an unknown folderPath without touching the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await searchTool(ports).execute('call-1', { query: 'login', folderPath: '/w/unknown' }, undefined, undefined, {})) as {
      details: { error: string };
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown folder');
    expect(result.details.error).toContain('use pimote_list_folders to see known folders');
    expect(ports.sessions.listDiskSessions).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only query', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

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

  it('opens a session in a known folder and forwards the firstMessage', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-42');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/alpha', firstMessage: ' fix the flaky test ' }, undefined, undefined, {})) as {
      details: { sessionId: string; folderPath: string; firstMessageSent: boolean };
    };

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', 'fix the flaky test');
    expect(result.details).toEqual({ sessionId: 'sess-42', folderPath: '/w/alpha', firstMessageSent: true });
  });

  it('opens a session without a firstMessage when none is given', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-43');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/alpha' }, undefined, undefined, {})) as { details: { firstMessageSent: boolean } };

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', undefined);
    expect(result.details.firstMessageSent).toBe(false);
  });

  it('opens a session in a persona folder', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makePersonaFolder('/w/personas/ada')]);
    ports.sessions.openSession.mockResolvedValue('sess-44');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/personas/ada' }, undefined, undefined, {})) as {
      details: { sessionId: string; folderPath: string };
    };

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/personas/ada', undefined);
    expect(result.details).toEqual({ sessionId: 'sess-44', folderPath: '/w/personas/ada', firstMessageSent: false });
  });

  it('rejects an unknown folder without opening a session', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/unknown' }, undefined, undefined, {})) as { details: { error: string }; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown folder');
    expect(result.details.error).toContain('use pimote_list_folders to see known folders');
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
