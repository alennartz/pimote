import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePersonaFrontMatter } from '../folder-model/marker.js';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { ManagerToolContext } from './types.js';

// The persona creation path of pimote_create_folder (DR-062): kind "persona"
// creates <parentPath>/<name>/ with a persona AGENTS.md and a memory.md stub
// and then invalidates folder-model discovery so folders_changed fires.
// Driven through the registered tool surface — what goes in, what comes out,
// what lands on disk.

interface FakeToolDef {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details?: any; structuredContent: any; isError?: boolean }>;
}

function makeFakePi(): { toolDefs: FakeToolDef[]; api: any } {
  const toolDefs: FakeToolDef[] = [];
  const api = {
    registerTool(def: FakeToolDef) {
      toolDefs.push(def);
    },
    on() {},
    events: { emit() {}, on: () => () => {} },
  };
  return { toolDefs, api: api as any };
}

function toolNamed(toolDefs: FakeToolDef[], name: string): FakeToolDef {
  const def = toolDefs.find((tool) => tool.name === name);
  if (!def) throw new Error(`${name} not registered`);
  return def;
}

function makePorts(overrides: Partial<ManagerToolContext> = {}): ManagerToolContext {
  return {
    sessions: {
      getAllSessions: vi.fn(() => []),
      listDiskSessions: vi.fn(async () => []),
      openSession: vi.fn(async () => 'session-new'),
      archiveSessions: vi.fn(async () => []),
      resumeSession: vi.fn(async (sessionId: string) => ({ sessionId, outcome: 'not_found' as const })),
    },
    folders: {
      list: vi.fn(async () => [] as FolderInfo[]),
      update: vi.fn(async () => undefined),
      createHub: vi.fn(async () => ({}) as FolderInfo),
      addMember: vi.fn(async () => undefined),
      removeMember: vi.fn(async () => undefined),
    },
    repos: { invalidateListing: vi.fn() },
    creators: { create: vi.fn(async () => ({ folderPath: '/unused' })) },
    notifyFoldersChanged: vi.fn(),
    config: { roots: ['/tmp'], managerRoot: '/srv/manager-home', idleTimeout: 1_000, bufferSize: 10, port: 3000 },
    ...overrides,
  };
}

describe('pimote_create_folder (kind: persona)', () => {
  async function makeSandbox(): Promise<{
    root: string;
    parentPath: string;
    ports: ManagerToolContext;
    run: (params: unknown) => Promise<{ details?: any; structuredContent: any; isError?: boolean }>;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'persona-create-'));
    const parentPath = join(root, 'personas');
    await mkdir(parentPath);
    const ports = makePorts({ config: { roots: [root], managerRoot: join(root, 'manager-home'), idleTimeout: 1_000, bufferSize: 10, port: 3000 } });
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(ports)(api);
    const tool = toolNamed(toolDefs, 'pimote_create_folder');
    return {
      root,
      parentPath,
      ports,
      run: (params: unknown) => tool.execute('call-1', params, undefined, undefined, {}),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it('creates the persona folder with a persona AGENTS.md and a memory.md stub, and returns its canonical path', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({
        kind: 'persona',
        name: 'ada',
        parentPath: sandbox.parentPath,
        description: 'helpful agent',
        prompt: 'You are Ada, the debugging specialist.',
      });

      expect(result.isError ?? false).toBe(false);
      const folderPath = result.structuredContent.folderPath as string;
      await expect(realpath(join(sandbox.parentPath, 'ada'))).resolves.toBe(folderPath);

      // AGENTS.md front matter carries the persona name and description —
      // parseable by the folder model's persona marker.
      const agents = await readFile(join(folderPath, 'AGENTS.md'), 'utf8');
      expect(parsePersonaFrontMatter(agents)).toEqual({ name: 'ada', description: 'helpful agent' });
      // The body folds in the caller prompt and keeps the maintain-memory.md
      // instruction of the persona prompt template.
      expect(agents).toContain('You are Ada, the debugging specialist.');
      expect(agents).toContain('memory.md');

      await expect(stat(join(folderPath, 'memory.md'))).resolves.toBeTruthy();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('invalidates folder-model discovery after creation so folders_changed fires', async () => {
    const sandbox = await makeSandbox();
    try {
      await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });

      expect(sandbox.ports.repos.invalidateListing).toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).toHaveBeenCalledWith([await realpath(join(sandbox.parentPath, 'ada'))]);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('uses the persona template when prompt is omitted', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      const agents = await readFile(join(result.structuredContent.folderPath, 'AGENTS.md'), 'utf8');
      expect(parsePersonaFrontMatter(agents)).toEqual({ name: 'ada', description: 'helpful agent' });
      expect(agents).toContain('memory.md');
      await expect(stat(join(result.structuredContent.folderPath, 'memory.md'))).resolves.toBeTruthy();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('returns an error and creates nothing when parentPath is not under any scan root', async () => {
    const sandbox = await makeSandbox();
    try {
      const outside = await mkdtemp(join(tmpdir(), 'persona-outside-'));
      try {
        const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: outside, description: 'helpful agent' });

        expect(result.isError).toBe(true);
        await expect(stat(join(outside, 'ada'))).rejects.toThrow();
        expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
        expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await sandbox.cleanup();
    }
  });

  it('rejects a sibling whose path only shares the scan-root prefix', async () => {
    const sandbox = await makeSandbox();
    const sibling = `${sandbox.root}-sibling`;
    try {
      await mkdir(sibling);
      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sibling, description: 'helpful agent' });
      expect(result.isError).toBe(true);
      await expect(readdir(sibling)).resolves.toEqual([]);
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('permits creation directly under a scan root', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sandbox.root, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      await expect(realpath(join(sandbox.root, 'ada'))).resolves.toBe(result.structuredContent.folderPath);
    } finally {
      await sandbox.cleanup();
    }
  });

  it.each(['', '/', '.', '..', '../escape', 'nested/ada'])('rejects invalid basename %j without creating files', async (name) => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ kind: 'persona', name, parentPath: sandbox.parentPath, description: 'helpful agent' });
      expect(result.isError).toBe(true);
      await expect(readdir(sandbox.parentPath)).resolves.toEqual([]);
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('rejects a parent symlink that escapes the canonical scan root', async () => {
    const sandbox = await makeSandbox();
    const outside = await mkdtemp(join(tmpdir(), 'persona-escape-'));
    try {
      const alias = join(sandbox.root, 'escape');
      await symlink(outside, alias);
      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: alias, description: 'helpful agent' });
      expect(result.isError).toBe(true);
      await expect(readdir(outside)).resolves.toEqual([]);
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a canonical scan-root alias and returns the real persona path', async () => {
    const sandbox = await makeSandbox();
    try {
      const alias = join(sandbox.root, 'alias');
      await symlink(sandbox.parentPath, alias);
      sandbox.ports.config.roots = [alias];
      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      await expect(realpath(join(sandbox.parentPath, 'ada'))).resolves.toBe(result.structuredContent.folderPath);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('returns an error and leaves the existing folder untouched on a name collision', async () => {
    const sandbox = await makeSandbox();
    try {
      const existing = join(sandbox.parentPath, 'ada');
      await mkdir(existing);
      await writeFile(join(existing, 'notes.txt'), 'user-owned\n', 'utf8');

      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });

      expect(result.isError).toBe(true);
      // The collision error carries the structural hint (DR-062): the leaf
      // rule and the symlink alternative, at the error site.
      expect(result.structuredContent.error).toContain('leaves');
      expect(result.structuredContent.error).toContain('never nested');
      await expect(readdir(existing)).resolves.toEqual(['notes.txt']);
      await expect(readFile(join(existing, 'notes.txt'), 'utf8')).resolves.toBe('user-owned\n');
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('returns an error when creation fails on the filesystem', async () => {
    const sandbox = await makeSandbox();
    try {
      // parentPath is a plain file under the scan root: the folder cannot be
      // created below it.
      const fileParent = join(sandbox.root, 'a-file');
      await writeFile(fileParent, 'not a directory\n', 'utf8');

      const result = await sandbox.run({ kind: 'persona', name: 'ada', parentPath: fileParent, description: 'helpful agent' });

      expect(result.isError).toBe(true);
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });
});
