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

/** A symlink inside `projectDir` pointing at `target`, if any. */
async function findSymlinkTo(projectDir: string, target: string): Promise<string | undefined> {
  for (const entry of await readdir(projectDir)) {
    const full = join(projectDir, entry);
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

  it('applies curation overrides to multi-repo projects', async () => {
    const registry = makeRegistry();
    const { path: projectPath } = await registry.createMultiRepoProject('multi', rootDir, [repoA]);
    await registry.update({ projectPath: projectPath, favorite: true, archived: true });

    const project = (await registry.list()).find((p) => p.path === projectPath);
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

describe('project tags', () => {
  it('addTags/removeTags round-trip as user tags at the project path', async () => {
    const registry = makeRegistry();
    await registry.createMultiRepoProject('tagged', rootDir, []);
    const path = join(rootDir, 'tagged');

    await registry.update({ projectPath: path, addTags: ['client', '  urgent  ', ''] });
    let project = (await registry.list()).find((p) => p.path === path);
    expect(project?.tags).toEqual(['client', 'urgent']);
    expect(project?.userTags).toEqual(['client', 'urgent']);

    await registry.update({ projectPath: path, removeTags: ['client'] });
    project = (await registry.list()).find((p) => p.path === path);
    expect(project?.tags).toEqual(['urgent']);
  });

  it('multi-repo projects inherit member repo tags', async () => {
    const member = join(rootDir, 'member');
    await initRepo(member);
    const registry = makeRegistry();
    await registry.update({ projectPath: member, addTags: ['legacy'] });

    await registry.createMultiRepoProject('group', rootDir, [member]);
    const group = (await registry.list()).find((p) => p.name === 'group');
    expect(group?.tags).toContain('legacy');
    // The member itself carries it too; the group's own user tags do not.
    expect(group?.userTags ?? []).not.toContain('legacy');
  });

  it('source-contributed tags merge in and are not user-removable', async () => {
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'repo', path: join(rootDir, 'src-repo'), name: 'src-repo', branch: 'main', dirty: false, ahead: 0, behind: 0, tags: ['from-source'] }],
    });
    const registry = makeRegistry(index);
    const path = join(rootDir, 'src-repo');

    await registry.update({ projectPath: path, addTags: ['mine'], removeTags: ['from-source'] });
    const project = (await registry.list()).find((p) => p.path === path);
    expect(project?.tags).toEqual(['from-source', 'mine']);
    expect(project?.userTags).toEqual(['mine']);
  });
});

describe('source-listed multi-repo projects', () => {
  function makeIndexWith(projects: { path: string; name: string; memberPaths: string[] }[]): RepoIndex {
    const index = makeIndex();
    index.registerSource({ id: 'test-source', list: async () => projects.map((p) => ({ kind: 'project' as const, ...p })) });
    return index;
  }

  it('appear in list() as derived multi projects with resolved (or missing) members', async () => {
    const memberRepo = join(rootDir, 'member');
    await initRepo(memberRepo);
    const virtualMember = join(rootDir, 'not-created-yet');
    const registry = makeRegistry(makeIndexWith([{ path: join(rootDir, 'group'), name: 'group', memberPaths: [memberRepo, virtualMember] }]));

    const group = (await registry.list()).find((p) => p.name === 'group');
    expect(group?.kind).toBe('multi');
    const members = group?.repos ?? [];
    expect(members.find((m) => m.path === memberRepo)?.branch).toBe('main');
    expect(members.find((m) => m.path === virtualMember)?.missing).toBe(true);
  });

  it('are derived: disappearing from the source removes them, persisted entries stay', async () => {
    let clock = 0;
    let projects: { path: string; name: string; memberPaths: string[] }[] = [{ path: join(rootDir, 'ghost'), name: 'ghost', memberPaths: [] }];
    const index = new RepoIndex([rootDir], { now: () => clock, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
    index.registerSource({
      id: 'test-source',
      list: async () => projects.map((p) => ({ kind: 'project' as const, ...p })),
    });
    const registry = makeRegistry(index);
    await registry.createMultiRepoProject('persisted', rootDir, []);

    expect((await registry.list()).some((p) => p.name === 'ghost')).toBe(true);

    projects = [];
    clock += 1_000_001; // TTL miss: the next list() re-runs the source and drops 'ghost'
    const names = (await registry.list()).map((p) => p.name);
    expect(names).toContain('persisted');
    expect(names).not.toContain('ghost');
  });

  it('persisted entries win on a path collision with a source-listed project', async () => {
    const projects = [{ path: join(rootDir, 'from-user'), name: 'from-source', memberPaths: [] }];
    const index = makeIndex();
    index.registerSource({ id: 'test-source', list: async () => projects.map((p) => ({ kind: 'project' as const, ...p })) });
    const registry = makeRegistry(index);

    // Persist a user-created multi-repo project at the same path the source lists.
    await registry.createMultiRepoProject('from-user', rootDir, []);

    const shared = (await registry.list()).filter((p) => p.path === join(rootDir, 'from-user'));
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe('from-user');
  });

  it('apply curation overrides (favorite) by path', async () => {
    const target = join(rootDir, 'fav-target');
    const registry = makeRegistry(makeIndexWith([{ path: target, name: 'fav-target', memberPaths: [] }]));
    await registry.update({ projectPath: target, favorite: true });
    const project = (await registry.list()).find((p) => p.path === target);
    expect(project?.favorite).toBe(true);
  });
});

describe('ProjectRegistry.createMultiRepoProject()', () => {
  it('creates a multi-repo project with symlinked members and a generated AGENTS.md', async () => {
    const registry = makeRegistry();
    const { path: projectPath } = await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    expect(projectPath).toBe(join(rootDir, 'multi'));
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, 'AGENTS.md'))).toBe(true);
    expect(await findSymlinkTo(projectPath, repoA)).toBeDefined();

    const project = (await registry.list()).find((p) => p.path === projectPath);
    expect(project?.kind).toBe('multi');
    expect(project?.name).toBe('multi');
    expect(project?.repos?.map((r) => r.path)).toContain(repoA);
  });

  it('rejects multi-repo project creation when a member is missing from the repo index and creates nothing', async () => {
    const registry = makeRegistry();
    await registry.createMultiRepoProject('valid-multi', rootDir, [repoA]);

    const ghost = join(rootDir, 'ghost');
    await expect(registry.createMultiRepoProject('multi', rootDir, [repoA, ghost])).rejects.toThrow();
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
  });

  it('rejects multi-repo project creation when the target folder already exists and leaves it untouched', async () => {
    const registry = makeRegistry();
    await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    await expect(registry.createMultiRepoProject('multi', rootDir, [repoA])).rejects.toThrow();

    const multi = (await registry.list()).filter((p) => p.path === join(rootDir, 'multi'));
    expect(multi).toHaveLength(1);
  });

  it('rejects duplicate member basenames up front and cleans up so a retry can succeed', async () => {
    const repoB = join(rootDir, 'nested', 'repo-a');
    await initRepo(repoB);
    const registry = makeRegistry();

    // Two members sharing a basename collide on one symlink target; a
    // duplicated path fails the same way. Either used to fail partway,
    // leaving an un-disbandable half-built project folder.
    await expect(registry.createMultiRepoProject('multi', rootDir, [repoA, repoB])).rejects.toThrow(/Duplicate member name/);
    await expect(registry.createMultiRepoProject('multi', rootDir, [repoA, repoA])).rejects.toThrow(/Duplicate member name/);
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
    expect((await registry.list()).filter((p) => p.name === 'multi')).toHaveLength(0);

    // The failed attempts left nothing behind — the same call now succeeds.
    const second = makeRegistry();
    const { path: projectPath } = await second.createMultiRepoProject('multi', rootDir, [repoA]);
    expect(existsSync(projectPath)).toBe(true);
  });
});

describe('ProjectRegistry.disband()', () => {
  it('removes the multi-repo project and deletes the project folder', async () => {
    const registry = makeRegistry();
    const { path: projectPath } = await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    await registry.disband(projectPath);

    expect((await registry.list()).find((p) => p.path === projectPath)).toBeUndefined();
    expect(existsSync(projectPath)).toBe(false);
    // The member repo itself must survive.
    expect(existsSync(repoA)).toBe(true);
  });

  it('refuses to disband a single-repo project', async () => {
    const registry = makeRegistry();
    await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    await expect(registry.disband(repoA)).rejects.toThrow();
    expect(existsSync(repoA)).toBe(true);
    expect(existsSync(join(rootDir, 'multi'))).toBe(true);
  });

  it('rejects disbanding an unknown project path', async () => {
    const registry = makeRegistry();
    await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    await expect(registry.disband(join(tempDir, 'ghost'))).rejects.toThrow();
    expect(existsSync(join(rootDir, 'multi'))).toBe(true);
  });
});

describe('ProjectRegistry persistence', () => {
  it('persists multi-repo projects across registry instances', async () => {
    const first = makeRegistry();
    const { path: projectPath } = await first.createMultiRepoProject('multi', rootDir, [repoA]);

    const second = makeRegistry();
    const project = (await second.list()).find((p) => p.path === projectPath);
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
  it('notifies subscribers on update, createMultiRepoProject, and disband', async () => {
    const registry = makeRegistry();
    const onChange = vi.fn();
    const unsubscribe = registry.onChange(onChange);

    await registry.update({ projectPath: repoA, favorite: true });
    expect(onChange).toHaveBeenCalledTimes(1);

    const { path: projectPath } = await registry.createMultiRepoProject('multi', rootDir, [repoA]);
    expect(onChange).toHaveBeenCalledTimes(2);

    await registry.disband(projectPath);
    expect(onChange).toHaveBeenCalledTimes(3);

    unsubscribe();
    await registry.update({ projectPath: repoA, favorite: false });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('ProjectRegistry project AGENTS.md', () => {
  it('generates an AGENTS.md naming each member repo and the sub-project convention', async () => {
    const registry = makeRegistry();
    const { path: projectPath } = await registry.createMultiRepoProject('multi', rootDir, [repoA]);

    const content = await readFile(join(projectPath, 'AGENTS.md'), 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('repo-a');
    expect(content.toLowerCase()).toContain('agents.md');
  });
});
