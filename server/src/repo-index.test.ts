import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepoIndex, type RepoIndexOptions } from './repo-index.js';
import type { RepoInfo } from '../../shared/dist/index.js';
import type { FolderOccurrence, SparseTree } from './folder-model/index.js';

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

/** Every folder-entry path across the occurrence tree, in discovery order. */
function treeEntryPaths(tree: SparseTree): string[] {
  const paths: string[] = [];
  const visit = (occurrence: FolderOccurrence): void => {
    paths.push(occurrence.entry.path);
    occurrence.children.forEach(visit);
  };
  tree.occurrences.forEach(visit);
  return paths;
}

/** Poll until the condition holds (bounded; the assertion after it fails loudly on stall). */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('RepoIndex.list() — folder-model discovery', () => {
  it('discovers repos at any depth below a root through skipped folders', async () => {
    const deep = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'repo');
    await initRepo(deep);

    const index = makeIndex();
    expect((await index.list()).map((r) => r.path)).toContain(deep);
  });

  it('stops discovery at an included repo: nested repos inside it are never listed', async () => {
    const outer = join(tempDir, 'outer');
    await initRepo(outer);
    await initRepo(join(outer, 'inner'));
    await initRepo(join(outer, 'skipped', 'deep', 'inner-deep'));

    const index = makeIndex();
    expect((await index.list()).map((r) => r.path)).toEqual([outer]);
  });

  it('never enters node_modules, dist, build, target, or .venv directories', async () => {
    // `.git` is deliberately absent from this list: a `.git` entry makes its
    // folder an included repo before any descent, so pruning it is unreachable.
    const excluded = ['node_modules', 'dist', 'build', 'target', '.venv'];
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

  it('follows symlinks met during skipped descent and lists their canonical targets', async () => {
    const externalRepo = join(externalDir, 'outside');
    await initRepo(externalRepo);
    await symlink(externalRepo, join(tempDir, 'link'));

    const index = makeIndex();
    expect((await index.list()).map((r) => r.path)).toContain(externalRepo);
  });

  it('includes shortcut targets outside the roots: top-level symlinks of an included repo', async () => {
    const hub = join(tempDir, 'hub');
    await initRepo(hub);
    const member = join(externalDir, 'member');
    await initRepo(member);
    await symlink(member, join(hub, 'member'));

    const index = makeIndex();
    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(hub);
    expect(paths).toContain(member);
  });

  it('excludes persona folders even when they contain git', async () => {
    const persona = join(tempDir, 'persona');
    await initRepo(persona);
    await writeFile(join(persona, 'AGENTS.md'), '---\nname: Ada\ndescription: helper\n---\n\n# Ada\n');
    const code = join(tempDir, 'code');
    await initRepo(code);

    const index = makeIndex();
    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(code);
    expect(paths).not.toContain(persona);
  });

  it('excludes persona targets reached through shortcuts', async () => {
    const hub = join(tempDir, 'hub');
    await initRepo(hub);
    const persona = join(externalDir, 'persona');
    await initRepo(persona);
    await writeFile(join(persona, 'AGENTS.md'), '---\nname: Ada\n---\n');
    await symlink(persona, join(hub, 'persona-link'));

    const index = makeIndex();
    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(hub);
    expect(paths).not.toContain(persona);
  });

  it('lists a newly materialized hub as a repo alongside its members', async () => {
    const groupPath = join(tempDir, 'group');
    const member = join(externalDir, 'member-a');
    await initRepo(member);
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'hub', path: groupPath, name: 'group', memberPaths: [member] }],
    });

    await index.runOpenHooks(groupPath);
    index.invalidate();

    const paths = (await index.list()).map((r) => r.path);
    expect(paths).toContain(groupPath);
    expect(paths).toContain(member);
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

  it('routes source hub entries to listSourceHubs, not the repo listing', async () => {
    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'hub', path: join(tempDir, 'virtual-group'), name: 'virtual-group', memberPaths: [join(tempDir, 'alpha')] }],
    });

    const hubs = await index.listSourceHubs();
    expect(hubs).toHaveLength(1);
    expect(hubs[0]).toMatchObject({ name: 'virtual-group', memberPaths: [join(tempDir, 'alpha')] });
    // The hub entry must not leak into the repo index.
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

  it('carries source tags and lastActivity into a scanned path, not just external ones', async () => {
    const repoA = join(tempDir, 'repo-a');
    await initRepo(repoA);

    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'repo', path: repoA, name: 'renamed', branch: null, dirty: false, ahead: 0, behind: 0, tags: ['work'], lastActivity: 123 }],
    });

    const listed = await repoAt(index, repoA);
    expect(listed?.tags).toEqual(['work']);
    expect(listed?.lastActivity).toBe(123);
    // The scan row wins on identity fields.
    expect(listed?.name).toBe('repo-a');
  });

  it('excludes a persona-natured source entry from the repo listing', async () => {
    const personaHome = join(externalDir, 'ada');
    await mkdir(personaHome, { recursive: true });
    await writeFile(join(personaHome, 'AGENTS.md'), '---\nname: Ada\n---\nprompt body', 'utf8');

    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'repo', path: personaHome, name: 'ada', branch: null, dirty: false, ahead: 0, behind: 0 }],
    });

    // A persona home is never a repo — even when a source lists it.
    expect((await index.list()).map((r) => r.path)).not.toContain(personaHome);
  });

  it('excludes an in-tree persona path that only a source lists', async () => {
    const personaHome = join(tempDir, 'ada');
    await mkdir(personaHome, { recursive: true });
    await writeFile(join(personaHome, 'AGENTS.md'), '---\nname: Ada\n---\nprompt body', 'utf8');

    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'repo', path: personaHome, name: 'ada', branch: null, dirty: false, ahead: 0, behind: 0 }],
    });

    expect((await index.list()).map((r) => r.path)).not.toContain(personaHome);
  });

  it('routes persona source entries to listSourcePersonas with their classification and tags', async () => {
    const personaHome = join(externalDir, 'ada');
    await mkdir(personaHome, { recursive: true });
    await writeFile(join(personaHome, 'AGENTS.md'), '---\nname: Ada\n---\nprompt body', 'utf8');

    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'repo', path: personaHome, name: 'ada', branch: null, dirty: false, ahead: 0, behind: 0, tags: ['voice'] }],
    });

    expect((await index.list()).map((r) => r.path)).not.toContain(personaHome);
    expect(await index.listSourcePersonas()).toEqual([{ path: personaHome, persona: { name: 'Ada' }, tags: ['voice'] }]);
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
  it('materializes the standard layout for a missing source-listed hub before hooks run', async () => {
    const groupPath = join(tempDir, 'group');
    const memberA = join(externalDir, 'member-a');
    await mkdir(memberA, { recursive: true });
    const virtualMember = join(tempDir, 'virtual-member'); // never created — dangling link is fine
    const order: string[] = [];
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'hub', path: groupPath, name: 'group', memberPaths: [memberA, virtualMember] }],
      onFolderOpen: async (path) => {
        // The hook must see the complete materialized folder already on disk.
        expect((await stat(join(groupPath, '.git'))).isDirectory()).toBe(true);
        expect(await readFile(join(groupPath, 'AGENTS.md'), 'utf8')).toContain('member-a');
        order.push(`hook:${path}`);
      },
    });

    await index.runOpenHooks(groupPath);

    expect(await readlink(join(groupPath, 'virtual-member'))).toBe(virtualMember); // dangling is fine
    const agents = await readFile(join(groupPath, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('group');
    expect(agents).toContain('virtual-member');
    // The member links are ignored by git.
    const ignore = await readFile(join(groupPath, '.gitignore'), 'utf8');
    expect(ignore.split('\n').filter(Boolean)).toEqual(['/member-a', '/virtual-member']);
    expect(order).toEqual([`hook:${groupPath}`]);
  });

  it('leaves an existing hub folder untouched', async () => {
    const groupPath = join(tempDir, 'existing-group');
    await mkdir(groupPath, { recursive: true });
    await writeFile(join(groupPath, 'sentinel.txt'), 'keep me');
    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'hub', path: groupPath, name: 'existing-group', memberPaths: [] }],
      onFolderOpen: async () => {},
    });

    await index.runOpenHooks(groupPath);

    await expect(readFile(join(groupPath, 'sentinel.txt'), 'utf8')).resolves.toBe('keep me');
    await expect(readFile(join(groupPath, 'AGENTS.md'), 'utf8')).rejects.toThrow();
    // No backfill: a pre-existing hub without git stays without git.
    await expect(stat(join(groupPath, '.git'))).rejects.toThrow();
    await expect(readFile(join(groupPath, '.gitignore'), 'utf8')).rejects.toThrow();
  });
});

describe('RepoIndex.runOpenHooks()', () => {
  it('awaits every source hook with the opened path, in registration order', async () => {
    const index = makeIndex();
    const calls: string[] = [];
    index.registerSource({
      id: 'a',
      list: async () => [],
      onFolderOpen: async (path) => {
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`a:${path}`);
      },
    });
    index.registerSource({
      id: 'b',
      list: async () => [],
      onFolderOpen: async (path) => calls.push(`b:${path}`),
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
      onFolderOpen: async () => {
        throw new Error('scaffold failed: unmounted volume');
      },
    });
    index.registerSource({
      id: 'never',
      list: async () => [],
      onFolderOpen: async () => {
        secondCalled = true;
      },
    });

    await expect(index.runOpenHooks('/r/x')).rejects.toThrow('scaffold failed: unmounted volume');
    expect(secondCalled).toBe(false);
  });

  it('is a no-op when no source defines onFolderOpen', async () => {
    const index = makeIndex();
    index.registerSource({ id: 'plain', list: async () => [] });
    await expect(index.runOpenHooks('/r/x')).resolves.toBeUndefined();
  });
});

describe('RepoIndex.list() — TTL cache', () => {
  it('serves the cached listing until the TTL expires, then serves it stale while refreshing in the background', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex([tempDir], { ttlMs: 100 });
    expect(await repoAt(index, repoA)).toBeDefined();

    await initRepo(repoB);
    clock = 50;
    expect((await index.list()).map((r) => r.path)).toEqual([repoA]);

    // Past the TTL: the stale view is served immediately (no walk on the
    // request path), while a background refresh picks up repoB.
    clock = 200;
    expect((await index.list()).map((r) => r.path)).toEqual([repoA]);
    await index.whenRefreshed();
    expect((await index.list()).map((r) => r.path).sort()).toEqual([repoA, repoB].sort());
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

  it('never serves a walk that was invalidated while it was in flight', async () => {
    await initRepo(join(tempDir, 'repo-a'));

    const index = makeIndex();
    let sourceCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    index.registerSource({
      id: 'gated',
      list: async () => {
        sourceCalls++;
        if (sourceCalls === 1) {
          await gate; // hold walk 1 mid-flight
          return [];
        }
        return [{ kind: 'repo', path: join(externalDir, 'late'), name: 'late', branch: null, dirty: false, ahead: 0, behind: 0 }];
      },
    });

    const pending = index.list(); // walk 1 in flight, stuck in its source
    index.invalidate(); // a hub/create change lands mid-walk
    release();
    const rows = await pending;

    // The invalidated walk's pre-invalidation entries are never served: the
    // caller joined the walk but gets the post-invalidation state.
    expect(sourceCalls).toBe(2);
    expect(rows.map((r) => r.path)).toContain(join(externalDir, 'late'));
  });
});

describe('RepoIndex.tree() — cached discovery', () => {
  it('serves repeated tree and list reads from one shared discovery walk', async () => {
    const repoA = join(tempDir, 'repo-a');
    await initRepo(repoA);

    const index = makeIndex();
    let walks = 0;
    index.registerSource({
      id: 'probe',
      list: async () => {
        walks++;
        return [];
      },
    });

    const first = await index.tree();
    expect(treeEntryPaths(first)).toContain(repoA);

    // Warm reads reuse the retained walk — same tree object, no rescan — and
    // the repo listing shares that discovery instead of re-walking.
    const second = await index.tree();
    expect(second).toBe(first);
    expect((await index.list()).map((r) => r.path)).toContain(repoA);
    expect(walks).toBe(1);
  });

  it('joins one single-flight walk when a cold tree and list read race', async () => {
    const repoA = join(tempDir, 'repo-a');
    await initRepo(repoA);

    const index = makeIndex();
    let walks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    index.registerSource({
      id: 'gated',
      list: async () => {
        walks++;
        await gate; // hold the one shared walk mid-flight
        return [];
      },
    });

    const treePending = index.tree();
    const listPending = index.list();
    release();
    const [tree, repos] = await Promise.all([treePending, listPending]);

    expect(walks).toBe(1);
    expect(treeEntryPaths(tree)).toContain(repoA);
    expect(repos.map((r) => r.path)).toContain(repoA);
  });

  it('serves the previous tree on TTL-expired reads while the refresh replaces it in the background', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex([tempDir], { ttlMs: 100 });
    let walks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    index.registerSource({
      id: 'gated',
      list: async () => {
        walks++;
        if (walks > 1) await gate; // hold the background refresh mid-flight
        return [];
      },
    });

    const warm = await index.tree();
    await initRepo(repoB);
    clock = 500; // past the TTL

    // The expired read serves the previous tree immediately — never the
    // in-flight refresh (walk 2 is held at the gated source until released).
    const stalePromise = index.tree();
    await until(() => walks === 2);
    const stale = await stalePromise;
    expect(stale).toBe(warm);

    release();
    await index.whenRefreshed();
    const refreshed = await index.tree();
    expect(refreshed).not.toBe(warm);
    expect(treeEntryPaths(refreshed)).toContain(repoB);
  });

  it('discards the retained tree with the listing on invalidate()', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex();
    let walks = 0;
    index.registerSource({
      id: 'probe',
      list: async () => {
        walks++;
        return [];
      },
    });

    const before = await index.tree();
    expect(walks).toBe(1);

    await initRepo(repoB);
    index.invalidate();
    const after = await index.tree();

    expect(walks).toBe(2); // cold again — the retained tree went with the listing
    expect(after).not.toBe(before);
    expect(treeEntryPaths(after)).toContain(repoB);
  });
});

describe('RepoIndex background refresh — onRefreshed', () => {
  it('notifies when the refreshed view differs from the stale one', async () => {
    const repoA = join(tempDir, 'repo-a');
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoA);

    const index = makeIndex();
    expect(await repoAt(index, repoA)).toBeDefined();
    const onRefreshed = vi.fn();
    index.setOnRefreshed(onRefreshed);

    await initRepo(repoB);
    clock = 5_000; // well past both TTLs
    await index.list(); // stale serve + kick
    await index.whenRefreshed();

    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenLastCalledWith({ changedPaths: [repoB], removedPaths: [] });
    expect((await index.list()).map((r) => r.path)).toContain(repoB);

    await rm(repoA, { recursive: true, force: true });
    clock = 10_000;
    await index.list();
    await index.whenRefreshed();
    expect(onRefreshed).toHaveBeenLastCalledWith({ changedPaths: [], removedPaths: [repoA] });
  });

  it('does not notify when a refresh finds nothing changed', async () => {
    const repoA = join(tempDir, 'repo-a');
    await initRepo(repoA);

    const index = makeIndex();
    expect(await repoAt(index, repoA)).toBeDefined();
    const onRefreshed = vi.fn();
    index.setOnRefreshed(onRefreshed);

    clock = 5_000; // expired TTLs, nothing changed on disk
    await index.list();
    await index.whenRefreshed();

    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it('does not report first-time git status probes as row changes', async () => {
    const repoA = join(tempDir, 'repo-a');
    await initRepo(repoA);

    const index = makeIndex();
    // Tree-only reads never probe git status, so the status cache is still
    // empty when the refresh below is kicked — its probes fill empty slots,
    // which is not row movement.
    await index.tree();
    const onRefreshed = vi.fn();
    index.setOnRefreshed(onRefreshed);

    clock = 5_000;
    await index.list(); // statuses due → background refresh re-probes
    await index.whenRefreshed();

    expect(onRefreshed).not.toHaveBeenCalled();
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

    // Past the status TTL the stale value is served (no git probe on the
    // request path); the background refresh re-probes.
    clock = 200;
    expect((await repoAt(index, repo))?.dirty).toBe(false);
    await index.whenRefreshed();
    expect((await repoAt(index, repo))?.dirty).toBe(true);
  });

  it('invalidateListing re-walks discovery while keeping warm git probes', async () => {
    const repo = join(tempDir, 'repo');
    await initRepo(repo);

    const index = makeIndex();
    expect((await repoAt(index, repo))?.dirty).toBe(false);

    await writeFile(join(repo, 'notes.txt'), 'work in progress');
    index.invalidateListing();

    // The listing re-walks (discovery shape can change), but the warm status
    // probe is served until its own TTL instead of re-probing every repo.
    expect((await repoAt(index, repo))?.dirty).toBe(false);
    clock = 5_000;
    await index.list();
    await index.whenRefreshed();
    expect((await repoAt(index, repo))?.dirty).toBe(true);
  });
});
