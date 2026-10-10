import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePersonaFrontMatter } from '../folder-model/marker.js';
import type { FolderOccurrence, SparseTree } from '../folder-model/index.js';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { createManagerExtension } from './extension.js';
import type { ManagerToolContext } from './types.js';

// The persona tools of the manager extension (plan: manager-lifecycle):
// pimote_create_persona creates <parentPath>/<name>/ with a persona AGENTS.md
// and a memory.md stub and then invalidates folder-model discovery so
// folders_changed fires; pimote_list_personas reports the folder model's
// persona rows. Driven through the registered tool surface — what goes in,
// what comes out, what lands on disk.

interface FakeToolDef {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: any; isError?: boolean }>;
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
    },
    folders: {
      list: vi.fn(async () => [] as FolderInfo[]),
      update: vi.fn(async () => undefined),
      createHub: vi.fn(async () => ({}) as FolderInfo),
      disbandHub: vi.fn(async () => undefined),
    },
    repos: { list: vi.fn(async () => []), invalidateListing: vi.fn() },
    notifyFoldersChanged: vi.fn(),
    tree: { tree: vi.fn(async () => ({ occurrences: [] })) },
    config: { roots: ['/tmp'], managerRoot: '/srv/manager-home', idleTimeout: 1_000, bufferSize: 10, port: 3000 },
    ...overrides,
  };
}

function makeFolder(path: string, nature: 'code' | 'persona', persona?: { name: string; description?: string }): FolderInfo {
  return {
    path,
    name: path.split('/').pop() ?? path,
    nature,
    ...(persona ? { persona } : {}),
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

function occurrenceFor(folder: FolderInfo): FolderOccurrence {
  return {
    path: folder.path,
    via: 'scan',
    entry: { path: folder.path, name: folder.name, nature: folder.nature, ...(folder.persona ? { persona: folder.persona } : {}) },
    children: [],
  };
}

function treeFor(folders: FolderInfo[]): SparseTree {
  return { occurrences: folders.map(occurrenceFor) };
}

describe('pimote_create_persona', () => {
  async function makeSandbox(): Promise<{
    root: string;
    parentPath: string;
    ports: ManagerToolContext;
    run: (params: unknown) => Promise<{ details: any; isError?: boolean }>;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'persona-create-'));
    const parentPath = join(root, 'personas');
    await mkdir(parentPath);
    const ports = makePorts({ config: { roots: [root], managerRoot: join(root, 'manager-home'), idleTimeout: 1_000, bufferSize: 10, port: 3000 } });
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(ports)(api);
    const tool = toolNamed(toolDefs, 'pimote_create_persona');
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
        name: 'ada',
        parentPath: sandbox.parentPath,
        description: 'helpful agent',
        prompt: 'You are Ada, the debugging specialist.',
      });

      expect(result.isError ?? false).toBe(false);
      const folderPath = result.details.folderPath as string;
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
      await sandbox.run({ name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });

      expect(sandbox.ports.repos.invalidateListing).toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).toHaveBeenCalledWith([await realpath(join(sandbox.parentPath, 'ada'))]);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('uses the persona template when prompt is omitted', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      const agents = await readFile(join(result.details.folderPath, 'AGENTS.md'), 'utf8');
      expect(parsePersonaFrontMatter(agents)).toEqual({ name: 'ada', description: 'helpful agent' });
      expect(agents).toContain('memory.md');
      await expect(stat(join(result.details.folderPath, 'memory.md'))).resolves.toBeTruthy();
    } finally {
      await sandbox.cleanup();
    }
  });

  it('returns an error and creates nothing when parentPath is not under any scan root', async () => {
    const sandbox = await makeSandbox();
    try {
      const outside = await mkdtemp(join(tmpdir(), 'persona-outside-'));
      try {
        const result = await sandbox.run({ name: 'ada', parentPath: outside, description: 'helpful agent' });

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
      const result = await sandbox.run({ name: 'ada', parentPath: sibling, description: 'helpful agent' });
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
      const result = await sandbox.run({ name: 'ada', parentPath: sandbox.root, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      await expect(realpath(join(sandbox.root, 'ada'))).resolves.toBe(result.details.folderPath);
    } finally {
      await sandbox.cleanup();
    }
  });

  it.each(['', '/', '.', '..', '../escape', 'nested/ada'])('rejects invalid basename %j without creating files', async (name) => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run({ name, parentPath: sandbox.parentPath, description: 'helpful agent' });
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
      const result = await sandbox.run({ name: 'ada', parentPath: alias, description: 'helpful agent' });
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
      const result = await sandbox.run({ name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });
      expect(result.isError ?? false).toBe(false);
      await expect(realpath(join(sandbox.parentPath, 'ada'))).resolves.toBe(result.details.folderPath);
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

      const result = await sandbox.run({ name: 'ada', parentPath: sandbox.parentPath, description: 'helpful agent' });

      expect(result.isError).toBe(true);
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

      const result = await sandbox.run({ name: 'ada', parentPath: fileParent, description: 'helpful agent' });

      expect(result.isError).toBe(true);
      expect(sandbox.ports.repos.invalidateListing).not.toHaveBeenCalled();
      expect(sandbox.ports.notifyFoldersChanged).not.toHaveBeenCalled();
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('pimote_list_personas', () => {
  function run(folders: FolderInfo[]): Promise<{ details: any; isError?: boolean }> {
    const ports = makePorts({
      folders: {
        list: vi.fn(async () => folders),
        update: vi.fn(async () => undefined),
        createHub: vi.fn(async () => ({}) as FolderInfo),
        disbandHub: vi.fn(async () => undefined),
      },
      tree: { tree: vi.fn(async () => treeFor(folders)) },
    });
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(ports)(api);
    return toolNamed(toolDefs, 'pimote_list_personas').execute('call-1', {}, undefined, undefined, {});
  }

  it('reports one row per persona folder with workingDirectory equal to the canonical folderPath', async () => {
    const code = makeFolder('/workspace/app', 'code');
    const ada = makeFolder('/workspace/personas/ada', 'persona', { name: 'Ada', description: 'helpful agent' });
    const bo = makeFolder('/workspace/personas/bo', 'persona', { name: 'Bo' });

    const result = await run([code, ada, bo]);

    expect(result.isError ?? false).toBe(false);
    const personas = result.details.personas as Array<{ name: string; description: string; folderPath: string; workingDirectory: string }>;
    expect(personas).toHaveLength(2);
    expect(personas).toContainEqual({ name: 'Ada', description: 'helpful agent', folderPath: '/workspace/personas/ada', workingDirectory: '/workspace/personas/ada' });
    const boRow = personas.find((persona) => persona.name === 'Bo')!;
    expect(boRow.name).toBe('Bo');
    expect(boRow.folderPath).toBe('/workspace/personas/bo');
    expect(boRow.workingDirectory).toBe(boRow.folderPath);
    expect(typeof boRow.description).toBe('string');
  });

  it('excludes code folders and code hubs', async () => {
    const code = makeFolder('/workspace/app', 'code');
    const hub = { ...makeFolder('/workspace/hub', 'code'), shortcutCount: 2 };

    const result = await run([code, hub]);

    expect(result.details.personas).toEqual([]);
  });

  it('returns a tool error when folder-model dependencies fail', async () => {
    const ports = makePorts();
    ports.folders.list = vi.fn(async () => {
      throw new Error('listing failed');
    });
    ports.tree.tree = vi.fn(async () => {
      throw new Error('listing failed');
    });
    ports.repos.list = vi.fn(async () => {
      throw new Error('listing failed');
    });
    ports.sessions.listDiskSessions = vi.fn(async () => {
      throw new Error('listing failed');
    });
    ports.sessions.getAllSessions = vi.fn(() => {
      throw new Error('listing failed');
    });
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(ports)(api);
    const result = await toolNamed(toolDefs, 'pimote_list_personas').execute('call-1', {}, undefined, undefined, {});
    expect(result.isError).toBe(true);
  });

  it('reports an empty list when the folder model knows no personas', async () => {
    const result = await run([]);

    expect(result.details.personas).toEqual([]);
  });
});
