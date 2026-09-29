import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readdir, lstat, readlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from './project-registry.js';
import { RepoIndex } from './repo-index.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let storeDir: string;
let rootDir: string;
let repoA: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'project-registry-test-'));
  storeDir = join(tempDir, 'registry');
  rootDir = join(tempDir, 'root');
  repoA = join(rootDir, 'repo-a');
  await mkdir(rootDir, { recursive: true });
  await initRepo(repoA);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function initRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const gitArgs = ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: repoPath, env });
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, env });
}

function makeIndex(): RepoIndex {
  return new RepoIndex([rootDir], { now: () => 0, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
}

function makeRegistry(index: RepoIndex = makeIndex()): ProjectRegistry {
  return new ProjectRegistry(index, storeDir);
}

/** A symlink inside `hubPath` pointing at `target`, if any. */
async function findSymlinkTo(hubPath: string, target: string): Promise<string | undefined> {
  for (const entry of await readdir(hubPath)) {
    const full = join(hubPath, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink() && (await readlink(full)) === target) return full;
  }
  return undefined;
}

describe('ProjectRegistry.list()', () => {
  it('lists every discovered repo as a single project with no curation applied', async () => {
    const registry = makeRegistry();
    const project = (await registry.list()).find((p) => p.path === repoA);

    expect(project).toBeDefined();
    expect(project?.kind).toBe('single');
    expect(project?.name).toBe('repo-a');
    expect(project?.favorite).toBeUndefined();
    expect(project?.order).toBeUndefined();
    expect(project?.archived).toBeUndefined();
  });

  it('applies curation overrides to single-repo projects and rejects unknown project paths', async () => {
    const registry = makeRegistry();
    await registry.update({ projectPath: repoA, favorite: true, order: 3, archived: true });

    const project = (await registry.list()).find((p) => p.path === repoA);
    expect(project?.favorite).toBe(true);
    expect(project?.order).toBe(3);
    expect(project?.archived).toBe(true);
    expect(project?.kind).toBe('single');

    await expect(registry.update({ projectPath: join(tempDir, 'ghost'), favorite: true })).rejects.toThrow();
  });

  it('applies curation overrides to hub projects', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub('hub', rootDir, [repoA]);
    await registry.update({ projectPath: hubPath, favorite: true, archived: true });

    const project = (await registry.list()).find((p) => p.path === hubPath);
    expect(project?.favorite).toBe(true);
    expect(project?.archived).toBe(true);
  });

  it('sorts by manual order where set and by name otherwise', async () => {
    const repoB = join(rootDir, 'repo-b');
    await initRepo(repoB);

    const registry = makeRegistry();
    expect((await registry.list()).map((p) => p.path)).toEqual([repoA, repoB]);

    await registry.update({ projectPath: repoB, order: 1 });
    await registry.update({ projectPath: repoA, order: 2 });

    expect((await registry.list()).map((p) => p.path)).toEqual([repoB, repoA]);
  });
});

describe('ProjectRegistry.createHub()', () => {
  it('creates a hub project with symlinked members and a generated AGENTS.md', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub('hub', rootDir, [repoA]);

    expect(hubPath).toBe(join(rootDir, 'hub'));
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(join(hubPath, 'AGENTS.md'))).toBe(true);
    expect(await findSymlinkTo(hubPath, repoA)).toBeDefined();

    const project = (await registry.list()).find((p) => p.path === hubPath);
    expect(project?.kind).toBe('multi');
    expect(project?.name).toBe('hub');
    expect(project?.repos?.map((r) => r.path)).toContain(repoA);
  });

  it('rejects hub creation when a member is missing from the repo index and creates nothing', async () => {
    const registry = makeRegistry();
    await registry.createHub('valid-hub', rootDir, [repoA]);

    const ghost = join(rootDir, 'ghost');
    await expect(registry.createHub('hub', rootDir, [repoA, ghost])).rejects.toThrow();
    expect(existsSync(join(rootDir, 'hub'))).toBe(false);
  });

  it('rejects hub creation when the target folder already exists and leaves it untouched', async () => {
    const registry = makeRegistry();
    await registry.createHub('hub', rootDir, [repoA]);

    await expect(registry.createHub('hub', rootDir, [repoA])).rejects.toThrow();

    const hubs = (await registry.list()).filter((p) => p.path === join(rootDir, 'hub'));
    expect(hubs).toHaveLength(1);
  });

  it('rejects duplicate member basenames up front and cleans up so a retry can succeed', async () => {
    const repoB = join(rootDir, 'nested', 'repo-a');
    await initRepo(repoB);
    const registry = makeRegistry();

    // Two members sharing a basename collide on one symlink target; a
    // duplicated path fails the same way. Either used to fail partway,
    // leaving an un-disbandable half-built hub folder.
    await expect(registry.createHub('hub', rootDir, [repoA, repoB])).rejects.toThrow(/Duplicate member name/);
    await expect(registry.createHub('hub', rootDir, [repoA, repoA])).rejects.toThrow(/Duplicate member name/);
    expect(existsSync(join(rootDir, 'hub'))).toBe(false);
    expect((await registry.list()).filter((p) => p.name === 'hub')).toHaveLength(0);

    // The failed attempts left nothing behind — the same call now succeeds.
    const second = makeRegistry();
    const { path: hubPath } = await second.createHub('hub', rootDir, [repoA]);
    expect(existsSync(hubPath)).toBe(true);
  });
});

describe('ProjectRegistry.disband()', () => {
  it('removes the hub project and deletes the hub folder', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub('hub', rootDir, [repoA]);

    await registry.disband(hubPath);

    expect((await registry.list()).find((p) => p.path === hubPath)).toBeUndefined();
    expect(existsSync(hubPath)).toBe(false);
    // The member repo itself must survive.
    expect(existsSync(repoA)).toBe(true);
  });

  it('refuses to disband a single-repo project', async () => {
    const registry = makeRegistry();
    await registry.createHub('hub', rootDir, [repoA]);

    await expect(registry.disband(repoA)).rejects.toThrow();
    expect(existsSync(repoA)).toBe(true);
    expect(existsSync(join(rootDir, 'hub'))).toBe(true);
  });

  it('rejects disbanding an unknown project path', async () => {
    const registry = makeRegistry();
    await registry.createHub('hub', rootDir, [repoA]);

    await expect(registry.disband(join(tempDir, 'ghost'))).rejects.toThrow();
    expect(existsSync(join(rootDir, 'hub'))).toBe(true);
  });
});

describe('ProjectRegistry persistence', () => {
  it('persists hub projects across registry instances', async () => {
    const first = makeRegistry();
    const { path: hubPath } = await first.createHub('hub', rootDir, [repoA]);

    const second = makeRegistry();
    const project = (await second.list()).find((p) => p.path === hubPath);
    expect(project?.kind).toBe('multi');
  });

  it('persists curation overrides across registry instances', async () => {
    const first = makeRegistry();
    await first.update({ projectPath: repoA, favorite: true, archived: true });

    const second = makeRegistry();
    const project = (await second.list()).find((p) => p.path === repoA);
    expect(project?.favorite).toBe(true);
    expect(project?.archived).toBe(true);
  });
});

describe('ProjectRegistry.onChange()', () => {
  it('notifies subscribers on update, createHub, and disband', async () => {
    const registry = makeRegistry();
    const onChange = vi.fn();
    const unsubscribe = registry.onChange(onChange);

    await registry.update({ projectPath: repoA, favorite: true });
    expect(onChange).toHaveBeenCalledTimes(1);

    const { path: hubPath } = await registry.createHub('hub', rootDir, [repoA]);
    expect(onChange).toHaveBeenCalledTimes(2);

    await registry.disband(hubPath);
    expect(onChange).toHaveBeenCalledTimes(3);

    unsubscribe();
    await registry.update({ projectPath: repoA, favorite: false });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('ProjectRegistry hub AGENTS.md', () => {
  it('generates an AGENTS.md naming each member repo and the sub-project convention', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub('hub', rootDir, [repoA]);

    const content = await readFile(join(hubPath, 'AGENTS.md'), 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('repo-a');
    expect(content.toLowerCase()).toContain('agents.md');
  });
});
