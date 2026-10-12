import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { DiskSessionRecord, ManagerToolContext, ManagerSessionSummary } from './types.js';

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

// The pinned toolset (DR-062): eight tools — one folder read (rows carry
// git facts and hub membership), a unified sessions view, freshness flags,
// kind-parameterized creation, batched hub membership.
const MANAGER_TOOL_NAMES = [
  'pimote_list_folders',
  'pimote_list_sessions',
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

type ToolResult = { details: any; isError?: boolean };

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

    await toolNamed(toolDefs, 'pimote_list_folders').execute('c', {}, undefined, undefined, {});
    expect(ports.folders.list).toHaveBeenCalledTimes(1);

    await toolNamed(toolDefs, 'pimote_list_sessions').execute('c', {}, undefined, undefined, {});
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha');
  });

  it('describes folder nature, identity versus reach, freshness, and the leaf rule in the tool descriptions', () => {
    const toolDefs = register(spyPorts());
    const descriptions = Object.fromEntries(toolDefs.map((def) => [def.name, def.description as string]));

    expect(descriptions.pimote_list_folders).toContain('canonical path');
    expect(descriptions.pimote_list_folders).toContain('fresh: true');
    expect(descriptions.pimote_create_folder).toContain('Included folders are leaves');
    expect(descriptions.pimote_create_folder).toContain('never nested');
  });
});

describe('pimote_list_folders', () => {
  it('declares the complete FolderInfo schema: all fields, defaults on the defaulted ones', () => {
    const toolDefs = register(spyPorts());
    const schema = toolNamed(toolDefs, 'pimote_list_folders').outputSchema;

    // Every FolderInfo field is declared, and the defaulted fields are marked
    // `default` so the wire row is self-describing.
    const properties = (schema as any).items.properties;
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
    expect(Value.Check(schema, [])).toBe(true);
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

    const result = (await toolNamed(register(ports), 'pimote_list_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    const [ada, bare] = result.details;
    expect(ada.persona).toEqual({ name: 'Ada', description: 'helpful agent' });
    expect(ada.repos).toEqual(hubMembers);
    expect(ada.members).toEqual(inventory);
    expect(bare.repo).toEqual(ownRepo);
    expect(Value.Check(toolNamed(register(ports), 'pimote_list_folders').outputSchema, result.details)).toBe(true);
    expect(bare).toMatchObject({ shortcutCount: 0, favorite: false, archived: false, tags: [], missing: false, activeSessionCount: 0, externalProcessCount: 0 });
  });

  it('enriches live session counts from the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha'), makeFolder('/w/beta')]);
    ports.sessions.getAllSessions.mockReturnValue([
      { sessionId: 's1', folderPath: '/w/alpha', status: 'idle', needsAttention: false },
      { sessionId: 's2', folderPath: '/w/alpha', status: 'working', needsAttention: true },
    ]);

    const result = (await toolNamed(register(ports), 'pimote_list_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    const byPath = new Map((result.details as FolderInfo[]).map((folder) => [folder.path, folder]));
    expect(byPath.get('/w/alpha')!.activeSessionCount).toBe(2);
    expect(byPath.get('/w/beta')!.activeSessionCount).toBe(0);
  });

  it('filters by nature for the team and code views', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/app'), makePersonaFolder('/w/ada')]);

    const toolDefs = register(ports);
    const personas = (await toolNamed(toolDefs, 'pimote_list_folders').execute('c', { nature: 'persona' }, undefined, undefined, {})) as ToolResult;
    const code = (await toolNamed(toolDefs, 'pimote_list_folders').execute('c', { nature: 'code' }, undefined, undefined, {})) as ToolResult;

    expect((personas.details as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/ada']);
    expect((code.details as FolderInfo[]).map((folder) => folder.path)).toEqual(['/w/app']);
  });

  it('drops the discovery cache first when fresh: true', async () => {
    const ports = spyPorts();
    const toolDefs = register(ports);

    await toolNamed(toolDefs, 'pimote_list_folders').execute('c', {}, undefined, undefined, {});
    expect(ports.repos.invalidateListing).not.toHaveBeenCalled();

    await toolNamed(toolDefs, 'pimote_list_folders').execute('c', { fresh: true }, undefined, undefined, {});
    expect(ports.repos.invalidateListing).toHaveBeenCalledTimes(1);
  });

  it('returns a tool error when the folder model fails', async () => {
    const ports = spyPorts();
    ports.folders.list.mockRejectedValue(new Error('listing failed'));

    const result = (await toolNamed(register(ports), 'pimote_list_folders').execute('c', {}, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('failed to list folders');
  });
});

describe('pimote_list_sessions', () => {
  function listTool(ports: ReturnType<typeof spyPorts>) {
    return toolNamed(register(ports), 'pimote_list_sessions');
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

    const result = (await listTool(ports).execute('call-1', { query: 'LOGIN' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.listDiskSessions).toHaveBeenCalledTimes(2);
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/alpha');
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/beta');
    // Newest first: s3 (06-03) before s1 (06-02); s2 never matched.
    const rows = result.details.sessions as Array<Record<string, unknown>>;
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

  it('lists without a query, newest first, capped by limit', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue(['a', 'b', 'c'].map((id) => makeRecord({ id, modified: `2025-06-0${id.charCodeAt(0) - 96}T10:00:00.000Z` })));

    const tool = listTool(ports);
    const all = (await tool.execute('c', {}, undefined, undefined, {})) as ToolResult;
    const limited = (await tool.execute('c', { limit: 2 }, undefined, undefined, {})) as ToolResult;

    expect((all.details.sessions as unknown[]).map((row: any) => row.id)).toEqual(['c', 'b', 'a']);
    expect(limited.details.sessions).toHaveLength(2);
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

    const rows = result.details.sessions as Array<Record<string, unknown>>;
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
    expect(ports.sessions.listDiskSessions).toHaveBeenCalledWith('/w/personas/ada');
    expect(result.details.sessions[0].folderPath).toBe('/w/personas/ada');
  });

  it('rejects an unknown folderPath without touching the session port', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await listTool(ports).execute('call-1', { query: 'login', folderPath: '/w/unknown' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown folder');
    expect(result.details.error).toContain('use pimote_list_folders to see known folders');
    expect(ports.sessions.listDiskSessions).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only query as absent', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.listDiskSessions.mockResolvedValue([makeRecord({ id: 's1', name: 'login bug' })]);

    const result = (await listTool(ports).execute('call-1', { query: '   ' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    expect(result.details.sessions).toHaveLength(1);
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
    expect(result.details).toEqual({ sessionId: 'sess-42', folderPath: '/w/alpha', firstMessageSent: true });
  });

  it('opens a session without a firstMessage when none is given', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);
    ports.sessions.openSession.mockResolvedValue('sess-43');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/alpha' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/alpha', undefined);
    expect(result.details.firstMessageSent).toBe(false);
  });

  it('opens a session in a persona folder', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makePersonaFolder('/w/personas/ada')]);
    ports.sessions.openSession.mockResolvedValue('sess-44');

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/personas/ada' }, undefined, undefined, {})) as ToolResult;

    expect(ports.sessions.openSession).toHaveBeenCalledWith('/w/personas/ada', undefined);
    expect(result.details).toEqual({ sessionId: 'sess-44', folderPath: '/w/personas/ada', firstMessageSent: false });
  });

  it('rejects an unknown folder without opening a session', async () => {
    const ports = spyPorts();
    ports.folders.list.mockResolvedValue([makeFolder('/w/alpha')]);

    const result = (await startTool(ports).execute('call-1', { folderPath: '/w/unknown' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('unknown folder');
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
    expect(result.details.results).toEqual([
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
      expect(result.details.folderPath).toBe('/w/created');
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
      expect(result.details.error).toContain('Directory already exists');
      expect(result.details.error).toContain('leaves');
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
      expect(result.details.folderPath).toBe('/w/hub');
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
      expect(noMembers.details.error).toContain('memberPaths is required');
      expect(noDescription.details.error).toContain('description is required');
      expect(noDescriptionHub.details.error).toContain('description is required');
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
      expect(badName.details.error).toContain('invalid name');
      expect(badParent.isError).toBe(true);
      expect(badParent.details.error).toContain('not under any scan root');
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
      expect(result.details.error).toContain('Unknown folder: /w/ghost');
      expect(result.details.error).toContain('pimote_list_folders');
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
    expect(result.details).toEqual({ folderPath: '/w/app' });
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
    expect(empty.details.error).toContain('nothing to update');

    ports.folders.update.mockRejectedValue(new Error('Unknown folder: /w/ghost'));
    const unknown = (await tool.execute('c', { folderPath: '/w/ghost', favorite: true }, undefined, undefined, {})) as ToolResult;
    expect(unknown.isError).toBe(true);
    expect(unknown.details.error).toContain('use pimote_list_folders');
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
    expect(result.details.results).toEqual([
      { memberPath: '/w/old', action: 'remove', outcome: 'removed' },
      { memberPath: '/w/api', action: 'add', outcome: 'added' },
      { memberPath: '/w/ghost', action: 'add', outcome: 'error', error: 'Unknown folder: /w/ghost' },
    ]);
  });

  it('rejects an empty batch', async () => {
    const ports = spyPorts();
    const result = (await toolNamed(register(ports), 'pimote_update_hub_members').execute('c', { hubPath: '/w/hub' }, undefined, undefined, {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details.error).toContain('nothing to update');
    expect(ports.folders.addMember).not.toHaveBeenCalled();
    expect(ports.folders.removeMember).not.toHaveBeenCalled();
  });
});
