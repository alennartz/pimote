import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepoIndex, type RepoIndexOptions } from './repo-index.js';
import type { RepoInfo } from '../../shared/dist/index.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let externalDir: string;
let clock: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'repo-index-test-'));
  externalDir = await mkdtemp(join(tmpdir(), 'repo-index-external-'));
  clock = 0;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await rm(externalDir, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  // Guard against inherited Git env vars forcing resolution to another repo.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env,
  });
}

/** Create a real git repository with one commit at the given path. */
async function initRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await git(['init'], repoPath);
  await git(['commit', '--allow-empty', '-m', 'init'], repoPath);
}

function makeIndex(roots: string[] = [tempDir], options: RepoIndexOptions = {}): RepoIndex {
  return new RepoIndex(roots, { now: () => clock, ttlMs: 1_000, statusTtlMs: 1_000, ...options });
}

function repoAt(index: RepoIndex, repoPath: string): RepoInfo | undefined {
  return index.list().then((repos) => repos.find((r) => r.path === repoPath));
}

describe('RepoIndex.list() — recursive discovery', () => {
  it('discovers git repositories up to three directory levels below a root', async () => {
    const depth1 = join(tempDir, 'one');
    const depth3 = join(tempDir, 'one', 'two', 'three');
    const depth4 = join(tempDir, 'one', 'two', 'three', 'four');
    await initRepo(depth1);
    await initRepo(depth3);
    await initRepo(depth4);

    const index = makeIndex();
    const repos = await index.list();
    const paths = repos.map((r) => r.path);

    expect(paths).toContain(depth1);
    expect(paths).toContain(depth3);
    expect(paths).not.toContain(depth4);
  });

  it('does not descend into node_modules, .git, dist, build, target, or .venv directories', async () => {
    const excluded = ['node_modules', '.git', 'dist', 'build', 'target', '.venv'];
    for (const name of excluded) {
      await initRepo(join(tempDir, name, 'nested-repo'));
    }
    const visible = join(tempDir, 'visible-repo');
    await initRepo(visible);

    const index = makeIndex();
    const repos = await index.list();
    const paths = repos.map((r) => r.path);

    expect(paths).toContain(visible);
    expect(paths.filter((p) => excluded.some((name) => p.includes(join(tempDir, name))))).toEqual([]);
  });

  it('does not follow symlinks that point outside the scanned tree', async () => {
    const externalRepo = join(externalDir, 'outside');
    await initRepo(externalRepo);
    await symlink(externalRepo, join(tempDir, 'link'));

    const index = makeIndex();
    const repos = await index.list();

    expect(repos.map((r) => r.path)).not.toContain(externalRepo);
  });

  it('discovers repos across all configured roots', async () => {
    const rootA = join(tempDir, 'root-a');
    const rootB = join(tempDir, 'root-b');
    const repoA = join(rootA, 'a');
    const repoB = join(rootB, 'b');
    await initRepo(repoA);
    await initRepo(repoB);

    const index = makeIndex([rootA, rootB]);
    const paths = (await index.list()).map((r) => r.path);

    expect(paths).toContain(repoA);
    expect(paths).toContain(repoB);
  });

  it('tolerates a configured root that does not exist', async () => {
    const repo = join(tempDir, 'repo');
    await initRepo(repo);

    const index = makeIndex([tempDir, join(tempDir, 'gone')]);
    const paths = (await index.list()).map((r) => r.path);

    expect(paths).toContain(repo);
  });
});

describe('RepoIndex.list() — registered sources', () => {
  it('includes repos contributed by registered sources', async () => {
    const externalRepo: RepoInfo = { path: join(externalDir, 'contributed'), name: 'contributed', branch: null, dirty: false, ahead: 0, behind: 0 };

    const index = makeIndex();
    index.registerSource({ id: 'test-source', list: async () => [externalRepo] });

    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(externalRepo.path);
  });

  it('marks paths that no longer exist as missing instead of dropping them', async () => {
    const vanished: RepoInfo = { path: join(tempDir, 'vanished'), name: 'vanished', branch: null, dirty: false, ahead: 0, behind: 0 };

    const index = makeIndex();
    index.registerSource({ id: 'test-source', list: async () => [vanished] });

    const listed = await repoAt(index, vanished.path);
    expect(listed).toBeDefined();
    expect(listed?.missing).toBe(true);
  });

  it('routes source project entries to listSourceProjects, not the repo listing', async () => {
    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'project', path: join(tempDir, 'virtual-group'), name: 'virtual-group', memberPaths: [join(tempDir, 'alpha')] }],
    });

    const projects = await index.listSourceProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: 'virtual-group', memberPaths: [join(tempDir, 'alpha')] });
    // The project entry must not leak into the repo index.
    expect((await index.list()).some((r) => r.path === join(tempDir, 'virtual-group'))).toBe(false);
  });

  it('preserves source-contributed tags through the listing', async () => {
    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'repo', path: join(externalDir, 'tagged'), name: 'tagged', branch: 'main', dirty: false, ahead: 0, behind: 0, tags: ['work'] }],
    });

    const listed = await repoAt(index, join(externalDir, 'tagged'));
    expect(listed?.tags).toEqual(['work']);
  });

  it('normalizes bare repo shapes without a kind as repo entries', async () => {
    const index = makeIndex();
    const bare = { path: join(externalDir, 'bare'), name: 'bare', branch: null, dirty: false, ahead: 0, behind: 0 };
    index.registerSource({ id: 'test-source', list: async () => [bare as never] });

    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(bare.path);
  });
});

describe('RepoIndex.runOpenHooks() — materialization', () => {
  it('materializes the standard layout for a missing source-listed project before hooks run', async () => {
    const groupPath = join(tempDir, 'group');
    const memberA = join(externalDir, 'member-a');
    await mkdir(memberA, { recursive: true });
    const virtualMember = join(tempDir, 'virtual-member'); // never created — dangling link is fine
    const order: string[] = [];
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'project', path: groupPath, name: 'group', memberPaths: [memberA, virtualMember] }],
      onProjectOpen: async (path) => {
        // The hook must see the materialized folder already on disk.
        expect(await readFile(join(groupPath, 'AGENTS.md'), 'utf8')).toContain('member-a');
        order.push(`hook:${path}`);
      },
    });

    await index.runOpenHooks(groupPath);

    expect(await readlink(join(groupPath, 'virtual-member'))).toBe(virtualMember); // dangling is fine
    const agents = await readFile(join(groupPath, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('group');
    expect(agents).toContain('virtual-member');
    expect(order).toEqual([`hook:${groupPath}`]);
  });

  it('leaves an existing project folder untouched', async () => {
    const groupPath = join(tempDir, 'existing-group');
    await mkdir(groupPath, { recursive: true });
    await writeFile(join(groupPath, 'sentinel.txt'), 'keep me');
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'project', path: groupPath, name: 'existing-group', memberPaths: [] }],
      onProjectOpen: async () => {},
    });

    await index.runOpenHooks(groupPath);

    await expect(readFile(join(groupPath, 'sentinel.txt'), 'utf8')).resolves.toBe('keep me');
    await expect(readFile(join(groupPath, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});

describe('RepoIndex.runOpenHooks()', () => {
  it('awaits every source hook with the opened path, in registration order', async () => {
    const index = makeIndex();
    const calls: string[] = [];
    index.registerSource({
      id: 'a',
      list: async () => [],
      onProjectOpen: async (path) => {
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`a:${path}`);
      },
    });
    index.registerSource({
      id: 'b',
      list: async () => [],
      onProjectOpen: async (path) => calls.push(`b:${path}`),
    });

    await index.runOpenHooks('/r/some-project');
    expect(calls).toEqual([`a:/r/some-project`, `b:/r/some-project`]);
  });

  it('aborts on the first hook error and surfaces its message', async () => {
    const index = makeIndex();
    let secondCalled = false;
    index.registerSource({
      id: 'boom',
      list: async () => [],
      onProjectOpen: async () => {
        throw new Error('scaffold failed: unmounted volume');
      },
    });
    index.registerSource({
      id: 'never',
      list: async () => [],
      onProjectOpen: async () => {
        secondCalled = true;
      },
    });

    await expect(index.runOpenHooks('/r/x')).rejects.toThrow('scaffold failed: unmounted volume');
    expect(secondCalled).toBe(false);
  });

  it('is a no-op when no source defines onProjectOpen', async () => {
    const index = makeIndex();
    index.registerSource({ id: 'plain', list: async () => [] });
    await expect(index.runOpenHooks('/r/x')).resolves.toBeUndefined();
  });
});

describe('RepoIndex.list() — TTL cache', () => {
  it('serves a cached listing until the TTL expires', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex([tempDir], { ttlMs: 100 });
    expect(await repoAt(index, repoA)).toBeDefined();

    await initRepo(repoB);
    clock = 50;
    expect((await index.list()).map((r) => r.path)).toEqual([repoA]);

    clock = 200;
    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(repoA);
    expect(paths).toContain(repoB);
  });

  it('re-walks immediately after invalidate()', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex();
    expect(await repoAt(index, repoA)).toBeDefined();

    await initRepo(repoB);
    index.invalidate();
    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(repoA);
    expect(paths).toContain(repoB);
  });
});

describe('RepoIndex.list() — git status enrichment', () => {
  it('reports the branch, a clean tree, and zero ahead/behind for a fresh committed repo', async () => {
    const repo = join(tempDir, 'repo');
    await initRepo(repo);

    const info = await repoAt(makeIndex(), repo);
    expect(info).toBeDefined();
    expect(typeof info?.branch).toBe('string');
    expect(info?.branch?.length).toBeGreaterThan(0);
    expect(info?.dirty).toBe(false);
    expect(info?.ahead).toBe(0);
    expect(info?.behind).toBe(0);
  });

  it('reports dirty when the working tree has untracked changes', async () => {
    const repo = join(tempDir, 'repo');
    await initRepo(repo);
    await writeFile(join(repo, 'notes.txt'), 'work in progress');

    const info = await repoAt(makeIndex(), repo);
    expect(info?.dirty).toBe(true);
  });

  it('counts commits ahead of the upstream after a push', async () => {
    const remote = join(tempDir, 'remote.git');
    await mkdir(remote);
    await git(['init', '--bare', remote], tempDir);

    const work = join(tempDir, 'work');
    await git(['clone', remote, work], tempDir);
    await writeFile(join(work, 'README.md'), '# work');
    await git(['add', '.'], work);
    await git(['commit', '-m', 'c1'], work);
    await git(['push', '-u', 'origin', 'HEAD'], work);

    const index = makeIndex([work], { ttlMs: 1_000_000 });
    const synced = await repoAt(index, work);
    expect(synced?.ahead).toBe(0);
    expect(synced?.behind).toBe(0);

    index.invalidate();
    await git(['commit', '--allow-empty', '-m', 'c2'], work);
    index.invalidate();

    const aheadOne = await repoAt(index, work);
    expect(aheadOne?.ahead).toBe(1);
    expect(aheadOne?.behind).toBe(0);
  });

  it('caches git status on its own TTL, separate from the listing', async () => {
    const repo = join(tempDir, 'repo');
    await initRepo(repo);

    const index = makeIndex([tempDir], { ttlMs: 1_000_000, statusTtlMs: 100 });
    expect((await repoAt(index, repo))?.dirty).toBe(false);

    await writeFile(join(repo, 'notes.txt'), 'work in progress');

    clock = 50;
    expect((await repoAt(index, repo))?.dirty).toBe(false);

    clock = 200;
    expect((await repoAt(index, repo))?.dirty).toBe(true);
  });
});
