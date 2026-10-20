import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { DiskSessionRecord, ManagerSessionSummary, ManagerToolContext } from './types.js';

// Spill files land in a per-process temp dir: the guard's real fs behavior
// (JSONL write, inline prefix) is under test; the shared state dir is not.
// vi.hoisted runs before import bindings initialize, so path helpers come
// from a dynamic import; the mock factory awaits the same promise.
const spillDirPromise = vi.hoisted(async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return join(tmpdir(), `pimote-spill-test-${process.pid}`);
});
vi.mock('../paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PIMOTE_TOOL_SPILL_DIR: await spillDirPromise,
}));
afterAll(async () => {
  await rm(await spillDirPromise, { recursive: true, force: true });
});

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

// The pinned toolset (DR-062, revised by DR-074): seven tools — one folder
// read (rows carry git facts and hub membership; query/nature/hub/archived
// filters), a unified sessions view, kind-parameterized creation, batched
// hub membership.
const MANAGER_TOOL_NAMES = [
  'pimote_find_folders',
  'pimote_find_sessions',
  'pimote_start_session',
  'pimote_archive_sessions',
  'pimote_create_folder',
  'pimote_update_folder',
  'pimote_update_hub_members',
];

function spyPorts() {
  return {
    sessions: {
      getAllSessions: vi.fn(() => [] as ManagerSessionSummary[]),
      listDiskSessions: vi.fn(async (_folderPath: string) => [] as DiskSessionRecord[]),
      openSession: vi.fn(async (_folderPath: string, _firstMessage?: string) => 'session-new'),
      archiveSessions: vi.fn(async (_sessionIds: string[]) => []),
    },
    folders: {
      list: vi.fn(async () => [] as FolderInfo[]),
      update: vi.fn(async () => undefined),
      createHub: vi.fn(async () => ({ path: '/w/hub' }) as FolderInfo),
      addMember: vi.fn(async () => undefined),
      removeMember: vi.fn(async () => undefined),
    },
    repos: { invalidateListing: vi.fn() },
    creators: { create: vi.fn(async () => ({ folderPath: '/w/created' })) },
    notifyFoldersChanged: vi.fn(),
  };
}

function makeContext(ports: ReturnType<typeof spyPorts>, roots: string[] = ['/tmp']): ManagerToolContext {
  return { ...ports, config: { roots, managerRoot: '/srv/manager-home', idleTimeout: 1_000, bufferSize: 10, port: 3000 } };
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

type ToolResult = { content: [{ type: 'text'; text: string }]; details?: any; structuredContent: any; isError?: boolean };

function register(ports: ReturnType<typeof spyPorts>, roots?: string[]) {
  const { toolDefs, api } = makeFakePi();
  createManagerExtension(makeContext(ports, roots))(api);
  return toolDefs;
}

function toolNamed(toolDefs: any[], name: string) {
  const def = toolDefs.find((t) => t.name === name);
  if (!def) throw new Error(`${name} not registered`);
  return def;
}

describe('createManagerExtension()', () => {
  it('registers exactly the pinned pimote toolset on the extension API', () => {
    const toolDefs = register(spyPorts());
    expect(toolDefs.map((def) => def.name).sort()).toEqual([...MANAGER_TOOL_NAMES].sort());
  });

  it('routes each listing tool through the injected context ports', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    const toolDefs = register(ports);

    await toolNamed(toolDefs, 'pimote_find_folders').execute('c', {}, undefined, undefined, {});
    expect(ports.folders.list).toHaveBeenCalledTimes(1);

    await toolNamed(toolDefs, 'pimote_find_sessions').execute('c', {}, undefined, undefined, {});
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha', undefined);
  });

  it('describes the folder query semantics and the leaf rule in the tool descriptions', () => {
    const toolDefs = register(spyPorts());
    const descriptions = Object.fromEntries(toolDefs.map((def) => [def.name, def.description as string]));

    expect(descriptions.pimote_find_folders).toContain('session text');
    expect(descriptions.pimote_find_folders).toContain('curation state');
    expect(descriptions.pimote_create_folder).toContain('Included folders are leaves');
    expect(descriptions.pimote_create_folder).toContain('never nested');
  });
});

describe('pimote_find_folders', () => {
  it('declares the complete FolderInfo schema: all fields, defaults on the defaulted ones', () => {
    const toolDefs = register(spyPorts());
    const schema = toolNamed(toolDefs, 'pimote_find_folders').outputSchema;

    // Every FolderInfo field is declared, and the defaulted fields are marked
    // `default` so the wire row is self-describing. The payload is the spill
    // envelope: `folders` rows plus the optional spill pointer.
    const properties = (schema as any).properties.folders.items.properties;
    for (const field of [
      'path',
      'name',
      'nature',
      'persona',
      'shortcutCount',
      'favorite',
      'archived',
      'tags',
      'missing',
      'repos',
      'members',
      'repo',
      'lastActivity',
      'userTags',
      'activeSessionCount',
      'externalProcessCount',
    ]) {
      expect(properties, `missing FolderInfo field ${field}`).toHaveProperty(field);
    }
    expect(Value.Check(schema, { folders: [] })).toBe(true);
  });

  it('serves complete rows with defaults, hub membership, and own repo facts', async () => {
    const ports = spyPorts();
    const hubMembers = [{ path: '/w/api', name: 'api', branch: 'main', dirty: true, ahead: 1, behind: 0 }];
    const inventory = [{ path: '/w/api', name: 'api', nature: 'code' as const }];
    const ownRepo = { path: '/w/bare', name: 'bare', branch: 'main', dirty: false, ahead: 0, behind: 0 };
    ports.folders.list.mockResolvedValue([
      { ...makePersonaFolder('/w/ada'), repos: hubMembers, members: inventory },
      { ...makeFolder('/w/bare'), repo: ownRepo },
    ]);

    const result = (await toolNamed(register(ports), 'pimote_find_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    const [ada, bare] = result.structuredContent.folders;
    expect(ada.persona).toEqual({ name: 'Ada', description: 'helpful agent' });
    expect(ada.repos).toEqual(hubMembers);
    expect(ada.members).toEqual(inventory);
    expect(bare.repo).toEqual(ownRepo);
    expect(Value.Check(toolNamed(register(ports), 'pimote_find_folders').outputSchema, result.structuredContent)).toBe(true);
    expect(bare).toMatchObject({ shortcutCount: 0, favorite: false, archived: false, tags: [], missing: false, activeSessionCount: 0, externalProcessCount: 0 });
  });

  it('enriches live session counts from the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
    ports.sessions.getAllSessions.mockReturnValue([
      { sessionId: 's1', folderPath: '/w/alpha', status: 'idle', needsAttention: false },
      { sessionId: 's2', folderPath: '/w/alpha', status: 'working', needsAttention: true },
    ]);

    const result = (await toolNamed(register(ports), 'pimote_find_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    const byPath = new Map((result.structuredContent.folders as FolderInfo[]).map((folder) => [folder.path, folder]));
    expect(byPath.get('/w/alpha')!.activeSessionCount).toBe(2);
    expect(byPath.get('/w/beta')!.activeSessionCount).toBe(0);
  });

  it('filters by nature for the team and code views', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/app'), makePersonaFolder('/w/ada')]);

    const toolDefs = register(ports);
    const personas = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', { nature: 'persona' }, undefined, undefined, {})) as ToolResult;
    const code = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', { nature: 'code' }, undefined, undefined, {})) as ToolResult;

    expect((personas.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/ada']);
    expect((code.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/app']);
  });

  it('filters hub rows with the hub flag', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/app'), { ...makeFolder('/w/hub'), shortcutCount: 2 }]);

    const toolDefs = register(ports);
    const hubs = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', { hub: true }, undefined, undefined, {})) as ToolResult;
    const plain = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', { hub: false }, undefined, undefined, {})) as ToolResult;
    const both = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect((hubs.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/hub']);
    expect((plain.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/app']);
    expect(both.structuredContent.folders).toHaveLength(2);
  });

  it('hides archived folders unless includeArchived is set', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/app'), { ...makeFolder('/w/old'), archived: true }]);

    const toolDefs = register(ports);
    const deflt = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;
    const all = (await toolNamed(toolDefs, 'pimote_find_folders').execute('c', { includeArchived: true }, undefined, undefined, {})) as ToolResult;

    expect((deflt.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/app']);
    expect(all.structuredContent.folders).toHaveLength(2);
  });

  it('matches the query two-tier: folder text, else member session text', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([{ ...makeFolder('/w/tagged'), tags: ['deploy'] }, makeFolder('/w/session-hit'), makeFolder('/w/miss')]);
    ports.sessions.listDiskSessions.mockImplementation(async (folderPath: string) =>
      folderPath === '/w/session-hit' ? [makeRecord({ id: 's1', firstMessage: 'deploy the api' })] : [],
    );

    const result = (await toolNamed(register(ports), 'pimote_find_folders').execute('c', { query: 'DEPLOY' }, undefined, undefined, {})) as ToolResult;

    expect((result.structuredContent.folders as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/tagged', '/w/session-hit']);
    // Folder-text hits skip the session tier; only the unmatched rows are read.
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(2);
  });

  it('returns a tool error when the folder model fails', async () => {
    const ports = spyPorts();
    ports.folders.list.mockRejectedValue(new Error('listing failed'));

    const result = (await toolNamed(register(ports), 'pimote_find_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('failed to list folders');
  });
});

describe('pimote_find_sessions', () => {
  function listTool(ports: ReturnType<typeof spyPorts>) {
    return toolNamed(register(ports), 'pimote_find_sessions');
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

    const result = (await listTool(ports).execute('call-1', { query: 'LOGIN', includeArchived: true }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(2);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha', undefined);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/beta', undefined);
    // Newest first: s3 (06-03) before s1 (06-02); s2 never matched.
    const rows = result.structuredContent.sessions as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['s3', 's1']);
    const [first, second] = rows;
    expect(first.open).toBe(false);
    expect(first.archived).toBe(true);
    expect(first.status).toBeUndefined();
    expect(second.open).toBe(true);
    expect(second.status).toBe('idle');
    expect(second.needsAttention).toBe(false);
    expect(second.folderPath).toBe('/w/alpha');
    // Excerpted firstMessage: collapsed whitespace, capped at 200 chars + ellipsis.
    expect((first.firstMessage as string).length).toBe(201);
    expect((first.firstMessage as string).endsWith('…')).toBe(true);
  });

  it('lists without a query, newest first', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue(['a', 'b', 'c'].map((id) => makeRecord({ id, modified: `2025-06-0${id.charCodeAt(0) - 96}T10:00:00.000Z` })));

    const all = (await listTool(ports).execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect((all.structuredContent.sessions as unknown[]).map((row: any) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('hides archived sessions unless includeArchived is set', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue([
      makeRecord({ id: 's1', modified: '2025-06-02T10:00:00.000Z' }),
      makeRecord({ id: 's2', modified: '2025-06-03T10:00:00.000Z', archived: true }),
    ]);

    const tool = listTool(ports);
    const deflt = (await tool.execute('c', {}, undefined, undefined, {})) as ToolResult;
    const all = (await tool.execute('c', { includeArchived: true }, undefined, undefined, {})) as ToolResult;

    expect((deflt.structuredContent.sessions as unknown[]).map((row: any) => row.id)).toEqual(['s1']);
    expect((all.structuredContent.sessions as unknown[]).map((row: any) => row.id)).toEqual(['s2', 's1']);
  });

  it('keeps only live sessions when open: true, with live status and attention', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue([
      makeRecord({ id: 's1', name: 'live one', modified: '2025-06-02T10:00:00.000Z' }),
      makeRecord({ id: 's2', name: 'closed one', modified: '2025-06-03T10:00:00.000Z' }),
    ]);
    ports.sessions.getAllSessions.mockReturnValue([{ sessionId: 's1', folderPath: '/w/alpha', status: 'working', needsAttention: true }]);

    const result = (await listTool(ports).execute('c', { open: true }, undefined, undefined, {})) as ToolResult;

    const rows = result.structuredContent.sessions as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['s1']);
    expect(rows[0].status).toBe('working');
    expect(rows[0].needsAttention).toBe(true);
  });

  it('searches only the given folderPath when provided, including persona folders', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha'), makePersonaFolder('/w/personas/ada')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await listTool(ports).execute('call-1', { query: 'login', folderPath: '/w/personas/ada' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(1);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/personas/ada', undefined);
    expect(result.structuredContent.sessions[0].folderPath).toBe('/w/personas/ada');
  });

  it('rejects an unknown folderPath without touching the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await listTool(ports).execute('call-1', { query: 'login', folderPath: '/w/unknown' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('unknown folder');
    expect(result.structuredContent.error).toContain('use pimote_find_folders to see known folders');
    expect(ports.sessions.listDiskSessions).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only query as absent', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await listTool(ports).execute('call-1', { query: '   ' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.sessions).toHaveLength(1);
  });
});

describe('pimote_start_session', () => {
  function startTool(ports: ReturnType<typeof spyPorts>) {
    return toolNamed(register(ports), 'pimote_start_session');
  }

  it('opens a session in a known folder and forwards the firstMessage', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-42');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/alpha', firstMessage: ' fix the flaky test ' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', 'fix the flaky test');
    expect(result.structuredContent).toEqual({ sessionId: 'sess-42', folderPath: '/w/alpha', firstMessageSent: true });
  });

  it('opens a session without a firstMessage when none is given', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-43');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/alpha' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', undefined);
    expect(result.structuredContent.firstMessageSent).toBe(false);
  });

  it('opens a session in a persona folder', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makePersonaFolder('/w/personas/ada')]);
    ports.sessions.openSession.mockResolvedValue('sess-44');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/personas/ada' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/personas/ada', undefined);
    expect(result.structuredContent).toEqual({ sessionId: 'sess-44', folderPath: '/w/personas/ada', firstMessageSent: false });
  });

  it('rejects an unknown folder without opening a session', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/unknown' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('unknown folder');
    expect(ports.sessions.openSession).not.toHaveBeenCalled();
  });
});

describe('pimote_archive_sessions', () => {
  it('routes the ids through the session port and surfaces per-id outcomes', async () => {
    const ports = spyPorts();
    ports.sessions.archiveSessions.mockResolvedValue([
      { sessionId: 's1', outcome: 'archived' },
      { sessionId: 's2', outcome: 'not_found' },
      { sessionId: 's3', outcome: 'open_slot_evicted' },
    ]);

    const result = (await toolNamed(register(ports), 'pimote_archive_sessions').execute('call-1', { sessionIds: ['s1', 's2', 's3'] }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.archiveSessions).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(result.structuredContent.results).toEqual([
      { sessionId: 's1', outcome: 'archived' },
      { sessionId: 's2', outcome: 'not_found' },
      { sessionId: 's3', outcome: 'open_slot_evicted' },
    ]);
  });
});

describe('pimote_create_folder', () => {
  /** Sandbox with a real scan root so parentPath resolution runs for real. */
  async function makeSandbox() {
    const root = await mkdtemp(join(tmpdir(), 'create-folder-'));
    const ports = spyPorts();
    const toolDefs = register(ports, [root]);
    return {
      root,
      ports,
      run: (params: Record<string, unknown>) => toolNamed(toolDefs, 'pimote_create_folder').execute('c', params, undefined, undefined, {}) as Promise<ToolResult>,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it('routes kind code through the creators seam, then invalidates and broadcasts', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'code', name: 'app', parentPath: sandbox.root, body: 'vision text' });

      expect(result.isError ?? false).toBe(false);
      expect(sandbox.ports.creators.create).toHaveBeenCalledWith({ root: sandbox.root, name: 'app', body: 'vision text' });
      expect(result.structuredContent.folderPath).toBe('/w/created');
      expect(sandbox.ports.repos.invalidateListing).toHaveBeenCalledTimes(1);
      expect(sandbox.ports.notifyFoldersChanged).toHaveBeenCalledWith(['/w/created']);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('appends the nesting hint when the creators seam reports a collision', async () => {
    const sandbox = await makeSandbox();
    try {
      sandbox.ports.creators.create.mockRejectedValue(new Error('Directory already exists: /w/app'));

      const result = await sandbox.run({ kind: 'code', name: 'app', parentPath: sandbox.root });

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toContain('Directory already exists');
      expect(result.structuredContent.error).toContain('leaves');
    } finally {
      await sandbox.cleanup();
    }
  });

  it('routes code-hub through the registry; the registry owns invalidation and broadcast', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'code-hub', name: 'platform', parentPath: sandbox.root, memberPaths: ['/w/api', '/w/web'], body: 'hub vision' });

      expect(result.isError ?? false).toBe(false);
      expect(sandbox.ports.folders.createHub).toHaveBeenCalledWith({ name: 'platform', root: sandbox.root, memberPaths: ['/w/api', '/w/web'], body: 'hub vision' });
      expect(result.structuredContent.folderPath).toBe('/w/hub');
      // The registry owns both effects; the tool adds neither.
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('routes persona-hub with description and personaText (empty prompt folds to empty text)', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'persona-hub', name: 'crew', parentPath: sandbox.root, description: 'crew lead', memberPaths: ['/w/rusty'] });

      expect(result.isError ?? false).toBe(false);
      expect(sandbox.ports.folders.createHub).toHaveBeenCalledWith({ name: 'crew', root: sandbox.root, memberPaths: ['/w/rusty'], description: 'crew lead', personaText: '' });
    } finally {
      await sandbox.cleanup();
    }
  });

  it('rejects hub kinds without members and persona kinds without description, before any port call', async () => {
    const sandbox = await makeSandbox();
    try {
      const noMembers = await sandbox.run({ kind: 'code-hub', name: 'h', parentPath: sandbox.root });
      const noDescription = await sandbox.run({ kind: 'persona', name: 'p', parentPath: sandbox.root });
      const noDescriptionHub = await sandbox.run({ kind: 'persona-hub', name: 'ph', parentPath: sandbox.root, memberPaths: ['/w/x'] });

      for (const result of [noMembers, noDescription, noDescriptionHub]) {
        expect(result.isError).toBe(true);
      }
      expect(noMembers.structuredContent.error).toContain('memberPaths is required');
      expect(noDescription.structuredContent.error).toContain('description is required');
      expect(noDescriptionHub.structuredContent.error).toContain('description is required');
      expect(sandbox.ports.folders.createHub).not.toHaveBeenCalled();
      expect(sandbox.ports.creators.create).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('rejects an invalid name and a parentPath outside every scan root', async () => {
    const sandbox = await makeSandbox();
    const outside = await mkdtemp(join(tmpdir(), 'create-outside-'));
    try {
      const badName = await sandbox.run({ kind: 'code', name: '../escape', parentPath: sandbox.root });
      const badParent = await sandbox.run({ kind: 'code', name: 'app', parentPath: outside });

      expect(badName.isError).toBe(true);
      expect(badName.structuredContent.error).toContain('invalid name');
      expect(badParent.isError).toBe(true);
      expect(badParent.structuredContent.error).toContain('not under any scan root');
    } finally {
      await sandbox.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('surfaces hub creation errors with the member hint', async () => {
    const sandbox = await makeSandbox();
    try {
      sandbox.ports.folders.createHub.mockRejectedValue(new Error('Unknown folder: /w/ghost'));

      const result = await sandbox.run({ kind: 'code-hub', name: 'h', parentPath: sandbox.root, memberPaths: ['/w/ghost'] });

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toContain('Unknown folder: /w/ghost');
      expect(result.structuredContent.error).toContain('pimote_find_folders');
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('pimote_update_folder', () => {
  it('applies a curation patch through the registry', async () => {
    const ports = spyPorts();
    const result = (await toolNamed(register(ports), 'pimote_update_folder').execute(
      'c',
      { folderPath: '/w/app', favorite: true, addTags: ['work'] },
      undefined,
      undefined,
      {},
    )) as ToolResult;

    expect(ports.folders.update).toHaveBeenCalledWith({ folderPath: '/w/app', favorite: true, addTags: ['work'] });
    expect(result.structuredContent).toEqual({ folderPath: '/w/app' });
  });

  it('restores an archived folder with archived: false', async () => {
    const ports = spyPorts();
    await toolNamed(register(ports), 'pimote_update_folder').execute('c', { folderPath: '/w/app', archived: false }, undefined, undefined, {});

    expect(ports.folders.update).toHaveBeenCalledWith({ folderPath: '/w/app', archived: false });
  });

  it('rejects an empty patch and surfaces registry validation errors', async () => {
    const ports = spyPorts();
    const tool = toolNamed(register(ports), 'pimote_update_folder');

    const empty = (await tool.execute('c', { folderPath: '/w/app' }, undefined, undefined, {})) as ToolResult;
    expect(empty.isError).toBe(true);
    expect(empty.structuredContent.error).toContain('nothing to update');

    ports.folders.update.mockRejectedValue(new Error('Unknown folder: /w/ghost'));
    const unknown = (await tool.execute('c', { folderPath: '/w/ghost', favorite: true }, undefined, undefined, {})) as ToolResult;
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent.error).toContain('use pimote_find_folders');
  });
});

describe('pimote_update_hub_members', () => {
  it('runs removals before additions and reports one outcome per member', async () => {
    const ports = spyPorts();
    const calls: string[] = [];
    ports.folders.removeMember.mockImplementation(async (_hub: string, member: string) => {
      calls.push(`remove:${member}`);
    });
    ports.folders.addMember.mockImplementation(async (_hub: string, member: string) => {
      calls.push(`add:${member}`);
      if (member === '/w/ghost') throw new Error('Unknown folder: /w/ghost');
    });

    const result = (await toolNamed(register(ports), 'pimote_update_hub_members').execute(
      'c',
      { hubPath: '/w/hub', add: ['/w/api', '/w/ghost'], remove: ['/w/old'] },
      undefined,
      undefined,
      {},
    )) as ToolResult;

    // Removals first, then additions — a same-name swap works in one call.
    expect(calls).toEqual(['remove:/w/old', 'add:/w/api', 'add:/w/ghost']);
    expect(result.structuredContent.results).toEqual([
      { memberPath: '/w/old', action: 'remove', outcome: 'removed' },
      { memberPath: '/w/api', action: 'add', outcome: 'added' },
      { memberPath: '/w/ghost', action: 'add', outcome: 'error', error: 'Unknown folder: /w/ghost' },
    ]);
  });

  it('rejects an empty batch', async () => {
    const ports = spyPorts();
    const result = (await toolNamed(register(ports), 'pimote_update_hub_members').execute('c', { hubPath: '/w/hub' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('nothing to update');
    expect(ports.folders.addMember).not.toHaveBeenCalled();
    expect(ports.folders.removeMember).not.toHaveBeenCalled();
  });
});

describe('list tool spill guard', () => {
  async function executeFolders(ports: ReturnType<typeof spyPorts>, params: Record<string, unknown> = {}) {
    return (await toolNamed(register(ports), 'pimote_find_folders').execute('c', params, undefined, undefined, {})) as ToolResult;
  }

  function bulkFolders(count: number, tagLength = 500): FolderInfo[] {
    return Array.from({ length: count }, (_, i) => ({ ...makeFolder(`/w/bulk-${i}`), tags: ['x'.repeat(tagLength)] }));
  }

  it('keeps small results fully inline with no spill pointer', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = await executeFolders(ports);

    expect(result.structuredContent.folders).toHaveLength(1);
    // Under budget: no spill pointer on the model view; details still reports the row counts.
    expect(JSON.parse(result.content[0].text).spill).toBeUndefined();
    expect(result.details).toEqual({ totalRows: 1, inlineRows: 1 });
    expect(Value.Check(toolNamed(register(ports), 'pimote_find_folders').outputSchema, result.structuredContent)).toBe(true);
  });

  it('spills rows past the inline budget: inline prefix, JSONL remainder, path and jq hint in the payload', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue(bulkFolders(30));

    const result = await executeFolders(ports);

    // Codemode channel carries every row; the guard bounds only the model view.
    expect(result.structuredContent.folders).toHaveLength(30);
    const view = JSON.parse(result.content[0].text) as { folders: FolderInfo[]; spill?: { file: string; rows: number; hint: string } };
    const inline = view.folders;
    expect(inline.length).toBeGreaterThanOrEqual(1);
    expect(inline.length).toBeLessThan(30);
    const spill = view.spill!;
    expect(spill.file).toContain('pimote_find_folders');
    expect(spill.rows).toBe(30 - inline.length);
    expect(spill.hint).toContain('jq');
    expect(spill.hint).toContain(spill.file);
    const lines = (await readFile(spill.file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(spill.rows);
    // The remainder continues exactly where the inline prefix stopped.
    expect(JSON.parse(lines[0]).path).toBe(`/w/bulk-${inline.length}`);
    // details carries the truncation metadata, never a row copy.
    expect(result.details).toEqual({ totalRows: 30, inlineRows: inline.length, spill: { file: spill.file, rows: spill.rows } });
    expect(Value.Check(toolNamed(register(ports), 'pimote_find_folders').outputSchema, result.structuredContent)).toBe(true);
  });

  it('spills the sessions view the same way once rows pass the inline budget', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue(Array.from({ length: 60 }, (_, i) => makeRecord({ id: `s${i}`, firstMessage: 'x'.repeat(300) })));

    const result = (await toolNamed(register(ports), 'pimote_find_sessions').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect(result.structuredContent.sessions).toHaveLength(60);
    const view = JSON.parse(result.content[0].text) as { sessions: unknown[]; spill?: { file: string; rows: number } };
    expect(view.sessions.length).toBeLessThan(60);
    expect(view.spill!.rows).toBe(60 - view.sessions.length);
    const lines = (await readFile(view.spill!.file, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0]).id).toBe(`s${view.sessions.length}`);
    expect(result.details).toEqual({ totalRows: 60, inlineRows: view.sessions.length, spill: { file: view.spill!.file, rows: view.spill!.rows } });
  });

  it('keeps a single oversized row inline with no spill file', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue(bulkFolders(1, 20_000));

    const result = await executeFolders(ports);

    expect(result.structuredContent.folders).toHaveLength(1);
    // A single monster row stays fully inline: no spill pointer; details reports the counts.
    expect(JSON.parse(result.content[0].text).spill).toBeUndefined();
    expect(result.details).toEqual({ totalRows: 1, inlineRows: 1 });
  });
});

describe('list tool interruption', () => {
  it('threads the tool signal into the folder listing port', async () => {
    const ports = spyPorts();
    const controller = new AbortController();

    await toolNamed(register(ports), 'pimote_find_folders').execute('c', {}, controller.signal, undefined, {});

    expect(ports.folders.list).toHaveBeenCalledWith(controller.signal);
  });

  it('threads the tool signal into the per-folder session reads', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    const controller = new AbortController();

    await toolNamed(register(ports), 'pimote_find_sessions').execute('c', {}, controller.signal, undefined, {});

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha', controller.signal);
  });

  it('rejects before touching the ports when the signal is already aborted', async () => {
    const ports = spyPorts();
    const controller = new AbortController();
    controller.abort();

    const run = toolNamed(register(ports), 'pimote_find_folders').execute('c', {}, controller.signal, undefined, {});

    await expect(run).rejects.toThrow();
    expect(ports.folders.list).not.toHaveBeenCalled();
  });

  it('rejects promptly when the signal aborts mid-fill; the shared fill still completes', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [makeRecord({ id: 's1' })];
    });
    const controller = new AbortController();
    const run = toolNamed(register(ports), 'pimote_find_sessions').execute('c', {}, controller.signal, undefined, {});
    controller.abort();

    // The shared fill runs to completion, but the caller rejects instead of
    // consuming its result.
    await expect(run).rejects.toThrow();
  });
});
