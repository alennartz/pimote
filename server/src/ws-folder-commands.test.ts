import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import { createBuiltinCreator } from './folder-sources/builtin.js';
import type { FolderRegistry } from './folder-registry.js';
import type { RepoIndex } from './repo-index.js';
import type { PimoteResponse } from '../../shared/dist/index.js';

const { seedPersonaFolderMock } = vi.hoisted(() => ({
  seedPersonaFolderMock: vi.fn(async () => '/w/ada'),
}));

vi.mock('./manager/seed.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manager/seed.js')>()),
  seedPersonaFolder: seedPersonaFolderMock,
}));

function createMockWs(): { ws: any; sent: Array<PimoteResponse> } {
  const sent: Array<PimoteResponse> = [];
  const ws = {
    readyState: 1, // OPEN
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
  };
  return { ws, sent };
}

interface TestContext {
  handler: WsHandler;
  sent: Array<PimoteResponse>;
  folderRegistry: { addMember: ReturnType<typeof vi.fn>; removeMember: ReturnType<typeof vi.fn> };
}

function createHandler(roots: string[]): TestContext {
  const { ws, sent } = createMockWs();
  const folderRegistry = {
    addMember: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  };
  const repoIndex = { roots, invalidateListing: vi.fn() };
  const handler = new WsHandler(
    '/srv/manager-home',
    {} as any,
    {} as any,
    ws,
    {} as any,
    {} as any,
    'client-1',
    new Map() as ClientRegistry,
    undefined,
    repoIndex as unknown as RepoIndex,
    folderRegistry as unknown as FolderRegistry,
    [createBuiltinCreator()],
    undefined,
  );
  return { handler, sent, folderRegistry };
}

function findResponse(sent: Array<PimoteResponse>, id: string): PimoteResponse | undefined {
  return sent.find((m) => 'id' in m && m.id === id);
}

let tempDir: string;
let rootDir: string;

beforeEach(async () => {
  seedPersonaFolderMock.mockClear();
  tempDir = await mkdtemp(join(tmpdir(), 'ws-folder-commands-test-'));
  rootDir = join(tempDir, 'root');
  await mkdir(rootDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('add_hub_member / remove_hub_member routing', () => {
  it('routes add_hub_member to the registry membership seam and responds success', async () => {
    const ctx = createHandler([rootDir]);

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'add_hub_member', hubPath: '/w/hub', memberPath: '/w/ada' }));

    expect(ctx.folderRegistry.addMember).toHaveBeenCalledWith('/w/hub', '/w/ada');
    expect(findResponse(ctx.sent, 'r1')?.success).toBe(true);
  });

  it('routes remove_hub_member to the registry membership seam and responds success', async () => {
    const ctx = createHandler([rootDir]);

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'remove_hub_member', hubPath: '/w/hub', memberPath: '/w/ada' }));

    expect(ctx.folderRegistry.removeMember).toHaveBeenCalledWith('/w/hub', '/w/ada');
    expect(findResponse(ctx.sent, 'r1')?.success).toBe(true);
  });

  it('surfaces a membership validation failure as an error response with the user-presentable message', async () => {
    const ctx = createHandler([rootDir]);
    ctx.folderRegistry.addMember.mockRejectedValueOnce(new Error('Duplicate member name: ada'));

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'add_hub_member', hubPath: '/w/hub', memberPath: '/w/ada' }));

    const response = findResponse(ctx.sent, 'r1');
    expect(response?.success).toBe(false);
    expect(response?.error).toContain('Duplicate member name: ada');
  });
});

describe('create_persona_folder routing', () => {
  it('routes to the persona seeding seam and responds with the created folder path', async () => {
    const ctx = createHandler([rootDir]);

    await ctx.handler.handleMessage(
      JSON.stringify({ id: 'r1', type: 'create_persona_folder', root: rootDir, name: 'ada', description: 'Research assistant', personaText: 'You are Ada.' }),
    );

    expect(seedPersonaFolderMock).toHaveBeenCalledWith(rootDir, 'ada', 'Research assistant', 'You are Ada.');
    const response = findResponse(ctx.sent, 'r1');
    expect(response?.success).toBe(true);
    expect(response?.data).toEqual({ folderPath: '/w/ada' });
  });
});

describe('create_folder with a seeded body', () => {
  it('returns the canonical path when the configured root is a symlink alias', async () => {
    const aliasRoot = join(tempDir, 'root-alias');
    await symlink(rootDir, aliasRoot);
    const ctx = createHandler([aliasRoot]);

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'create_folder', root: aliasRoot, name: 'proj' }));

    const response = findResponse(ctx.sent, 'r1');
    expect(response?.success).toBe(true);
    expect(response?.data).toEqual({ folderPath: await realpath(join(aliasRoot, 'proj')) });
    expect(response?.data).toEqual({ folderPath: join(rootDir, 'proj') });
  });

  it('seeds the new folder AGENTS.md with the given body', async () => {
    const ctx = createHandler([rootDir]);

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'create_folder', root: rootDir, name: 'proj', body: 'We build the widget.' }));

    expect(findResponse(ctx.sent, 'r1')?.success).toBe(true);
    expect(await readFile(join(rootDir, 'proj', 'AGENTS.md'), 'utf8')).toContain('We build the widget.');
  });

  it('seeds an AGENTS.md stub even when the body is omitted', async () => {
    const ctx = createHandler([rootDir]);

    await ctx.handler.handleMessage(JSON.stringify({ id: 'r1', type: 'create_folder', root: rootDir, name: 'proj' }));

    expect(findResponse(ctx.sent, 'r1')?.success).toBe(true);
    expect(await readFile(join(rootDir, 'proj', 'AGENTS.md'), 'utf8')).toEqual(expect.any(String));
  });
});
