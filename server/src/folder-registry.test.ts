import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readdir, lstat, readlink, readFile, symlink, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FolderInfo, RepoInfo } from '../../shared/dist/index.js';
import { FolderRegistry, enrichActiveSessionCounts } from './folder-registry.js';
import { RepoIndex } from './repo-index.js';
import { scanFolderModel } from './folder-model/index.js';
import type { FolderModelPort } from './manager/types.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let storeDir: string;
let rootDir: string;
let repoA: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'folder-registry-test-'));
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

/** A persona folder: marker front matter in AGENTS.md. */
async function makePersona(dirName: string, frontMatter = 'name: Friendly\ndescription: Greets everyone'): Promise<string> {
  const path = join(rootDir, dirName);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'AGENTS.md'), `---\n${frontMatter}\n---\n\nBody.\n`, 'utf8');
  return path;
}

function makeIndex(): RepoIndex {
  return new RepoIndex([rootDir], { now: () => 0, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
}

/** The on-demand folder-tree port: a fresh sparse scan per call (no shared cache). */
function makeTree(): FolderModelPort {
  return { tree: () => scanFolderModel({ roots: [rootDir] }) };
}

function makeRegistry(index: RepoIndex = makeIndex()): FolderRegistry {
  return new FolderRegistry(index, storeDir, makeTree());
}

/** Hand-written persistence document (legacy and new shapes). */
async function writeRegistryDocument(document: unknown): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, 'registry.json'), JSON.stringify(document), 'utf8');
}

async function readRegistryDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(storeDir, 'registry.json'), 'utf8')) as Record<string, unknown>;
}

async function findRow(registry: FolderRegistry, path: string): Promise<FolderInfo | undefined> {
  return (await registry.list()).find((folder) => folder.path === path);
}

/** A symlink inside `folderDir` pointing at `target`, if any. */
async function findSymlinkTo(folderDir: string, target: string): Promise<string | undefined> {
  for (const entry of await readdir(folderDir)) {
    const full = join(folderDir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink() && (await readlink(full)) === target) return full;
  }
  return undefined;
}

describe('FolderRegistry.list() — scan rows', () => {
  it('lists every discovered code folder with required defaults', async () => {
    const folder = await findRow(makeRegistry(), repoA);

    expect(folder).toEqual({
      path: repoA,
      name: 'repo-a',
      nature: 'code',
      shortcutCount: 0,
      favorite: false,
      archived: false,
      tags: [],
      missing: false,
      repo: { path: repoA, name: 'repo-a', branch: 'main', dirty: false, ahead: 0, behind: 0 },
      activeSessionCount: 0,
      externalProcessCount: 0,
    });
  });

  it('lists persona folders with persona metadata and basename entry names', async () => {
    const personaPath = await makePersona('persona-one');
    const folder = await findRow(makeRegistry(), personaPath);

    expect(folder).toMatchObject({
      path: personaPath,
      name: 'persona-one',
      nature: 'persona',
      persona: { name: 'Friendly', description: 'Greets everyone' },
      shortcutCount: 0,
    });
    // Personas never carry own repo facts.
    expect(folder?.repo).toBeUndefined();
  });

  it('sets shortcutCount from first-discovery immediate shortcut children', async () => {
    const withShortcut = join(rootDir, 'with-shortcut');
    await initRepo(withShortcut);
    await execFileAsync('ln', ['-s', repoA, join(withShortcut, 'link')]);

    const folder = await findRow(makeRegistry(), withShortcut);
    expect(folder?.shortcutCount).toBe(1);
    // The linked repo keeps its own plain row.
    expect((await findRow(makeRegistry(), repoA))?.shortcutCount).toBe(0);
  });

  it('sorts favorites first, then by name', async () => {
    const repoB = join(rootDir, 'repo-b');
    await initRepo(repoB);

    const registry = makeRegistry();
    expect((await registry.list()).map((p) => p.path)).toEqual([repoA, repoB]);

    await registry.update({ folderPath: repoB, favorite: true });

    expect((await registry.list()).map((p) => p.path)).toEqual([repoB, repoA]);
  });
});

describe('FolderRegistry.update()', () => {
  it('curates code and persona rows and rejects unknown paths', async () => {
    const personaPath = await makePersona('persona-one');
    const registry = makeRegistry();

    await registry.update({ folderPath: repoA, favorite: true, archived: true });
    await registry.update({ folderPath: personaPath, favorite: true, addTags: ['voice'] });

    const code = await findRow(registry, repoA);
    expect(code?.favorite).toBe(true);
    expect(code?.archived).toBe(true);
    expect(code?.userTags).toBeUndefined();

    const persona = await findRow(registry, personaPath);
    expect(persona?.favorite).toBe(true);
    expect(persona?.tags).toEqual(['voice']);
    expect(persona?.userTags).toEqual(['voice']);

    await expect(registry.update({ folderPath: join(tempDir, 'ghost'), favorite: true })).rejects.toThrow();
  });

  it('accepts source-listed and registry paths', async () => {
    const sourceRepo = join(rootDir, 'src-repo');
    const index = makeIndex();
    index.registerSource({ id: 'src', list: async () => [{ kind: 'repo', path: sourceRepo, name: 'src-repo', branch: null, dirty: false, ahead: 0, behind: 0 }] });
    const registry = makeRegistry(index);
    const { path: hubPath } = await registry.createHub({ name: 'hub', root: rootDir, memberPaths: [repoA] });

    await registry.update({ folderPath: sourceRepo, favorite: true });
    await registry.update({ folderPath: hubPath, favorite: true });

    expect((await findRow(registry, sourceRepo))?.favorite).toBe(true);
    expect((await findRow(registry, hubPath))?.favorite).toBe(true);
  });

  it('addTags/removeTags round-trip as user tags at the folder path', async () => {
    const registry = makeRegistry();
    await registry.createHub({ name: 'tagged', root: rootDir, memberPaths: [] });
    const path = join(rootDir, 'tagged');

    await registry.update({ folderPath: path, addTags: ['client', '  urgent  ', ''] });
    let folder = await findRow(registry, path);
    expect(folder?.tags).toEqual(['client', 'urgent']);
    expect(folder?.userTags).toEqual(['client', 'urgent']);

    await registry.update({ folderPath: path, removeTags: ['client'] });
    folder = await findRow(registry, path);
    expect(folder?.tags).toEqual(['urgent']);
    expect(folder?.userTags).toEqual(['urgent']);
  });

  it('hubs inherit member tags; userTags are own-path only', async () => {
    const member = join(rootDir, 'member');
    await initRepo(member);
    const registry = makeRegistry();
    await registry.update({ folderPath: member, addTags: ['legacy'] });

    await registry.createHub({ name: 'group', root: rootDir, memberPaths: [member] });
    const group = await findRow(registry, join(rootDir, 'group'));
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

    await registry.update({ folderPath: path, addTags: ['mine'], removeTags: ['from-source'] });
    const folder = await findRow(registry, path);
    expect(folder?.tags).toEqual(['from-source', 'mine']);
    expect(folder?.userTags).toEqual(['mine']);
  });

  it('surfaces a source-listed persona folder outside the scan roots as a persona row', async () => {
    const personaHome = join(tempDir, 'external-persona');
    await mkdir(personaHome, { recursive: true });
    await writeFile(join(personaHome, 'AGENTS.md'), '---\nname: Ada\ndescription: Builds bridges\n---\n\nBody.\n', 'utf8');

    const index = makeIndex();
    index.registerSource({
      id: 'src',
      list: async () => [{ kind: 'repo', path: personaHome, name: 'external-persona', branch: null, dirty: false, ahead: 0, behind: 0, tags: ['from-source'] }],
    });
    const registry = makeRegistry(index);

    // A persona folder is a folder of interest wherever it comes from: it is
    // never a repo, but it is never invisible either.
    const row = await findRow(registry, personaHome);
    expect(row).toMatchObject({
      path: personaHome,
      name: 'external-persona',
      nature: 'persona',
      persona: { name: 'Ada', description: 'Builds bridges' },
      missing: false,
    });
    expect(row?.tags).toEqual(['from-source']);
    // Excluded from the repo view only.
    expect((await index.list()).map((r) => r.path)).not.toContain(personaHome);
  });
});

describe('hub rows and path collisions', () => {
  function makeIndexWithHubs(hubs: { path: string; name: string; memberPaths: string[]; tags?: string[] }[]): RepoIndex {
    const index = makeIndex();
    index.registerSource({ id: 'test-source', list: async () => hubs.map((h) => ({ kind: 'hub' as const, ...h })) });
    return index;
  }

  it('source-listed hubs resolve members to git chips or missing placeholders', async () => {
    const memberRepo = join(rootDir, 'member');
    await initRepo(memberRepo);
    const virtualMember = join(rootDir, 'not-created-yet');
    const hubPath = join(rootDir, 'group');
    const registry = makeRegistry(makeIndexWithHubs([{ path: hubPath, name: 'group', memberPaths: [memberRepo, virtualMember] }]));

    const group = await findRow(registry, hubPath);
    // The hub itself is absent on disk.
    expect(group?.missing).toBe(true);
    expect(group?.nature).toBe('code');
    const members: RepoInfo[] = group?.repos ?? [];
    expect(members.find((m) => m.path === memberRepo)?.branch).toBe('main');
    expect(members.find((m) => m.path === virtualMember)?.missing).toBe(true);
  });

  it('keeps membership when discovery sees a hub first', async () => {
    const first = makeRegistry();
    const { path: hubPath } = await first.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    // A fresh instance re-discovers from scratch: the hub is scanned as a code
    // folder (it is a git repo now), and the scanned row is enriched with the
    // persisted membership instead of losing it.
    const second = makeRegistry();
    const folder = await findRow(second, hubPath);
    expect(folder?.nature).toBe('code');
    expect(folder?.name).toBe('multi');
    expect(folder?.repos?.map((r) => r.path)).toContain(repoA);
    expect(folder?.shortcutCount).toBe(1);
  });

  it('persisted hub metadata wins over source metadata on a path collision', async () => {
    const repoB = join(rootDir, 'repo-b');
    await initRepo(repoB);
    const hubPath = join(rootDir, 'from-user');
    const index = makeIndex();
    index.registerSource({
      id: 'test-source',
      list: async () => [{ kind: 'hub' as const, path: hubPath, name: 'from-source', memberPaths: [repoB] }],
    });
    const registry = makeRegistry(index);

    // A user-created hub at the same path the source lists.
    await registry.createHub({ name: 'from-user', root: rootDir, memberPaths: [repoA] });

    const shared = (await registry.list()).filter((folder) => folder.path === hubPath);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe('from-user');
    // Persisted membership wins over the source's members.
    expect(shared[0].repos?.map((r) => r.path)).toEqual([repoA]);
  });

  it('source hubs are derived: disappearing from the source removes them, persisted hubs stay', async () => {
    let clock = 0;
    let hubs: { path: string; name: string; memberPaths: string[] }[] = [{ path: join(rootDir, 'ghost'), name: 'ghost', memberPaths: [] }];
    const index = new RepoIndex([rootDir], { now: () => clock, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
    index.registerSource({
      id: 'test-source',
      list: async () => hubs.map((h) => ({ kind: 'hub' as const, ...h })),
    });
    const registry = makeRegistry(index);
    await registry.createHub({ name: 'persisted', root: rootDir, memberPaths: [] });

    expect((await registry.list()).some((p) => p.name === 'ghost')).toBe(true);

    hubs = [];
    clock += 1_000_001; // TTL miss: the stale view is served, a background refresh re-runs the source
    expect((await registry.list()).map((p) => p.name)).toContain('ghost');

    await index.whenRefreshed();
    const names = (await registry.list()).map((p) => p.name);
    expect(names).toContain('persisted');
    expect(names).not.toContain('ghost');
  });
});

describe('missing rows', () => {
  it('source-listed repos absent on disk get missing: true and stay curatable', async () => {
    const ghostRepo = join(rootDir, 'ghost-repo');
    const index = makeIndex();
    index.registerSource({ id: 'src', list: async () => [{ kind: 'repo', path: ghostRepo, name: 'ghost-repo', branch: null, dirty: false, ahead: 0, behind: 0 }] });
    const registry = makeRegistry(index);

    const folder = await findRow(registry, ghostRepo);
    expect(folder).toMatchObject({ path: ghostRepo, name: 'ghost-repo', nature: 'code', shortcutCount: 0, missing: true });

    await registry.update({ folderPath: ghostRepo, favorite: true });
    expect((await findRow(registry, ghostRepo))?.favorite).toBe(true);
  });

  it('registry hubs absent on disk get missing: true', async () => {
    await writeRegistryDocument({ version: 1, multiRepo: [{ path: join(rootDir, 'gone'), name: 'gone', memberPaths: [] }], overrides: {} });

    const folder = await findRow(makeRegistry(), join(rootDir, 'gone'));
    expect(folder).toMatchObject({ name: 'gone', nature: 'code', missing: true });
  });

  it('orphaned curation overrides alone produce no row', async () => {
    await writeRegistryDocument({ version: 1, hubs: [], overrides: { [join(tempDir, 'ghost')]: { favorite: true, tags: ['orphan'] } } });

    const rows = await makeRegistry().list();
    expect(rows.map((folder) => folder.path)).not.toContain(join(tempDir, 'ghost'));
  });
});

describe('git-less legacy hubs', () => {
  it('stays listed as code with member-count shortcuts and no disk changes', async () => {
    const hubPath = join(rootDir, 'legacy-hub');
    await mkdir(hubPath, { recursive: true });
    await writeRegistryDocument({ version: 1, multiRepo: [{ path: hubPath, name: 'legacy-hub', memberPaths: [repoA] }], overrides: {} });

    const before = await readdir(hubPath);
    const registry = makeRegistry();
    const folder = await findRow(registry, hubPath);

    expect(folder).toMatchObject({ path: hubPath, name: 'legacy-hub', nature: 'code', shortcutCount: 1, missing: false });
    expect(folder?.repos?.map((r) => r.path)).toEqual([repoA]);
    // No backfill: listing and re-listing never write to the folder.
    await registry.list();
    expect(await readdir(hubPath)).toEqual(before);
    expect(existsSync(join(hubPath, '.git'))).toBe(false);
  });
});

describe('FolderRegistry persistence', () => {
  it('reads legacy multiRepo documents and prefers hubs when both keys exist', async () => {
    const legacyOnly = join(rootDir, 'legacy-only');
    const newKey = join(rootDir, 'new-key');
    await writeRegistryDocument({
      version: 1,
      multiRepo: [{ path: legacyOnly, name: 'legacy-only', memberPaths: [] }],
      hubs: [{ path: newKey, name: 'new-key', memberPaths: [] }],
      overrides: {},
    });

    const rows = await makeRegistry().list();
    expect(rows.map((folder) => folder.name)).toContain('new-key');
    expect(rows.map((folder) => folder.name)).not.toContain('legacy-only');
  });

  it('lists legacy multiRepo documents when the hubs key is absent', async () => {
    await writeRegistryDocument({ version: 1, multiRepo: [{ path: join(rootDir, 'legacy-only'), name: 'legacy-only', memberPaths: [repoA] }], overrides: {} });

    const folder = await findRow(makeRegistry(), join(rootDir, 'legacy-only'));
    expect(folder?.name).toBe('legacy-only');
    expect(folder?.repos?.map((r) => r.path)).toEqual([repoA]);
  });

  it('isolates malformed hub entries', async () => {
    const good = join(rootDir, 'good');
    await writeRegistryDocument({
      version: 1,
      multiRepo: [
        { path: good, name: 'good', memberPaths: [] },
        { path: 42, name: 'bad' },
        { name: 'no-path', memberPaths: [] },
      ],
      overrides: {},
    });

    const rows = await makeRegistry().list();
    expect(rows.map((folder) => folder.name)).toContain('good');
    expect(rows).toHaveLength(2); // repo-a plus the one valid hub entry
  });

  it('round-trips existing registry data without loss, persisting hubs and stripping legacy order', async () => {
    const hubPath = join(rootDir, 'legacy-hub');
    await writeRegistryDocument({
      version: 1,
      multiRepo: [
        { path: hubPath, name: 'legacy-hub', memberPaths: [repoA] },
        { path: 42, name: 'malformed' },
      ],
      overrides: { [repoA]: { favorite: true, archived: true, tags: ['keep'], order: 3 } },
    });

    const registry = makeRegistry();
    await registry.update({ folderPath: repoA, addTags: ['more'] });

    const document = await readRegistryDocument();
    expect(document.multiRepo).toBeUndefined();
    expect(document.hubs).toEqual([{ path: hubPath, name: 'legacy-hub', memberPaths: [repoA] }]);
    expect(document.overrides).toEqual({ [repoA]: { favorite: true, archived: true, tags: ['keep', 'more'] } });

    // And the reloaded view still serves it all.
    const rows = await makeRegistry().list();
    expect(rows.map((folder) => folder.name)).toContain('legacy-hub');
    expect(rows.find((folder) => folder.path === repoA)?.tags).toEqual(['keep', 'more']);
  });

  it('persists curation overrides across registry instances', async () => {
    const first = makeRegistry();
    await first.update({ folderPath: repoA, favorite: true, archived: true });

    const folder = await findRow(makeRegistry(), repoA);
    expect(folder?.favorite).toBe(true);
    expect(folder?.archived).toBe(true);
  });

  it('recovers after a failed write: the cached document is dropped and later mutations re-read', async () => {
    const registry = makeRegistry();
    await registry.update({ folderPath: repoA, favorite: true });

    await chmod(storeDir, 0o555); // registry.json cannot be written
    try {
      await expect(registry.update({ folderPath: repoA, favorite: false })).rejects.toThrow();
    } finally {
      await chmod(storeDir, 0o755);
    }

    // The failed mutation must not linger in memory.
    expect((await findRow(registry, repoA))?.favorite).toBe(true);

    // A later mutation re-reads the persisted state and succeeds.
    await registry.update({ folderPath: repoA, favorite: false });
    expect((await findRow(makeRegistry(), repoA))?.favorite).toBe(false);
  });

  it('serializes concurrent mutations', async () => {
    const registry = makeRegistry();
    await Promise.all([
      registry.update({ folderPath: repoA, favorite: true }),
      registry.update({ folderPath: repoA, addTags: ['queued'] }),
      registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] }),
    ]);

    const rows = await makeRegistry().list();
    const repo = rows.find((folder) => folder.path === repoA);
    expect(repo?.favorite).toBe(true);
    expect(repo?.tags).toEqual(['queued']);
    expect(rows.some((folder) => folder.name === 'multi')).toBe(true);
  });
});

describe('FolderRegistry.createHub()', () => {
  it('persists the canonical identity when the root is a symlink alias', async () => {
    const aliasRoot = join(tempDir, 'alias-root');
    await symlink(rootDir, aliasRoot);

    const registry = makeRegistry();
    const created = await registry.createHub({ name: 'multi', root: aliasRoot, memberPaths: [repoA] });

    // Discovery identifies folders by their real path: a non-canonical
    // persisted key would split the hub into two rows and orphan its curation.
    expect(created.path).toBe(join(rootDir, 'multi'));
    const rows = (await registry.list()).filter((folder) => folder.name === 'multi');
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(join(rootDir, 'multi'));
    expect(rows[0].repos?.map((r) => r.path)).toEqual([repoA]);
  });

  it('returns the full FolderInfo row for the new hub', async () => {
    const registry = makeRegistry();
    const created = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    expect(created).toEqual({
      path: join(rootDir, 'multi'),
      name: 'multi',
      nature: 'code',
      shortcutCount: 1,
      favorite: false,
      archived: false,
      tags: [],
      missing: false,
      activeSessionCount: 0,
      externalProcessCount: 0,
      repos: [{ path: repoA, name: 'repo-a', branch: 'main', dirty: false, ahead: 0, behind: 0 }],
    });
  });

  it('creates a hub with symlinked members, a generated AGENTS.md, a git repo, and ignored member links', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    expect(hubPath).toBe(join(rootDir, 'multi'));
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(join(hubPath, 'AGENTS.md'))).toBe(true);
    expect(await findSymlinkTo(hubPath, repoA)).toBeDefined();
    // The hub is self-describing: a git repo that ignores its member links.
    expect(existsSync(join(hubPath, '.git'))).toBe(true);
    expect((await readFile(join(hubPath, '.gitignore'), 'utf8')).split('\n').filter(Boolean)).toEqual(['/repo-a']);

    // The generated AGENTS.md names each member and the sub-project convention.
    const content = await readFile(join(hubPath, 'AGENTS.md'), 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('repo-a');
    expect(content.toLowerCase()).toContain('agents.md');
  });

  it('rejects creation when a member is missing from the index and creates nothing', async () => {
    const registry = makeRegistry();
    await registry.createHub({ name: 'valid-multi', root: rootDir, memberPaths: [repoA] });

    const ghost = join(rootDir, 'ghost');
    await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA, ghost] })).rejects.toThrow();
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
  });

  it('rejects creation when the target folder already exists and leaves it untouched', async () => {
    const registry = makeRegistry();
    await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] })).rejects.toThrow();

    const multi = (await registry.list()).filter((folder) => folder.name === 'multi');
    expect(multi).toHaveLength(1);
  });

  it('rejects duplicate member basenames up front and cleans up so a retry can succeed', async () => {
    const repoB = join(rootDir, 'nested', 'repo-a');
    await initRepo(repoB);
    const registry = makeRegistry();

    // Two members sharing a basename collide on one symlink target; a
    // duplicated path fails the same way. Either used to fail partway,
    // leaving an un-disbandable half-built hub folder.
    await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA, repoB] })).rejects.toThrow(/Duplicate member name/);
    await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA, repoA] })).rejects.toThrow(/Duplicate member name/);
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
    expect((await registry.list()).filter((folder) => folder.name === 'multi')).toHaveLength(0);

    // The failed attempts left nothing behind — the same call now succeeds.
    const second = makeRegistry();
    const { path: hubPath } = await second.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });
    expect(existsSync(hubPath)).toBe(true);
  });

  it('cleans up the hub folder when materialization fails', async () => {
    const registry = makeRegistry();

    // git init cannot run: materialization fails partway, after the layout exists.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] })).rejects.toThrow();
    } finally {
      process.env.PATH = savedPath;
    }

    // All-or-nothing: no half-built hub survives, so a retry can succeed.
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
    expect((await registry.list()).filter((folder) => folder.name === 'multi')).toHaveLength(0);
    await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });
    expect(existsSync(join(rootDir, 'multi', '.git'))).toBe(true);
  });

  it('cleans up the hub folder when persistence fails', async () => {
    const registry = makeRegistry();
    await mkdir(storeDir, { recursive: true });
    await chmod(storeDir, 0o555); // registry.json cannot be written
    try {
      await expect(registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] })).rejects.toThrow();
    } finally {
      await chmod(storeDir, 0o755);
    }

    // The fully materialized hub is rolled back together with the lost entry.
    expect(existsSync(join(rootDir, 'multi'))).toBe(false);
    expect((await registry.list()).filter((folder) => folder.name === 'multi')).toHaveLength(0);
    await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });
    expect((await makeRegistry().list()).find((folder) => folder.name === 'multi')?.repos).toBeDefined();
  });
});

describe('FolderRegistry.disbandHub()', () => {
  it('removes the hub and deletes the hub folder; member repos survive', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    await registry.disbandHub(hubPath);

    expect(await findRow(registry, hubPath)).toBeUndefined();
    expect(existsSync(hubPath)).toBe(false);
    // The member repo itself must survive.
    expect(existsSync(repoA)).toBe(true);
  });

  it('keeps warm git probes for untouched member repos on disband', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });
    // Warm the member's status probe (clean tree).
    expect((await findRow(registry, repoA))?.repo?.dirty).toBe(false);

    // Git facts of the surviving member move after the warm probe.
    await writeFile(join(repoA, 'notes.txt'), 'work in progress');

    await registry.disbandHub(hubPath);

    // Discovery re-walks (the hub row is gone) but the member serves its
    // warm status: a disband moves no git facts of untouched repos.
    expect(await findRow(registry, hubPath)).toBeUndefined();
    expect((await findRow(registry, repoA))?.repo?.dirty).toBe(false);
  });

  it('refuses to disband a plain code folder and an unknown path', async () => {
    const registry = makeRegistry();
    const { path: hubPath } = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });

    await expect(registry.disbandHub(repoA)).rejects.toThrow();
    await expect(registry.disbandHub(join(tempDir, 'ghost'))).rejects.toThrow();
    expect(existsSync(repoA)).toBe(true);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('refuses to disband a source hub without a persisted registry entry', async () => {
    const hubPath = join(rootDir, 'src-hub');
    const index = makeIndex();
    index.registerSource({ id: 'src', list: async () => [{ kind: 'hub' as const, path: hubPath, name: 'src-hub', memberPaths: [repoA] }] });
    const registry = makeRegistry(index);
    await index.runOpenHooks(hubPath); // open-time materialization
    expect(existsSync(join(hubPath, '.git'))).toBe(true);

    await expect(registry.disbandHub(hubPath)).rejects.toThrow();
    expect(existsSync(hubPath)).toBe(true);
  });
});

describe('FolderRegistry.onChange()', () => {
  it('notifies subscribers on update, createHub, and disbandHub', async () => {
    const registry = makeRegistry();
    const onChange = vi.fn();
    const unsubscribe = registry.onChange(onChange);

    await registry.update({ folderPath: repoA, favorite: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ changedPaths: [repoA], removedPaths: [] });

    const { path: hubPath } = await registry.createHub({ name: 'multi', root: rootDir, memberPaths: [repoA] });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ changedPaths: [hubPath], removedPaths: [] });

    await registry.disbandHub(hubPath);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith({ changedPaths: [], removedPaths: [hubPath] });

    unsubscribe();
    await registry.update({ folderPath: repoA, favorite: false });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('reports member-tag changes to the member and every dependent hub', async () => {
    const member = join(rootDir, 'member');
    await initRepo(member);
    const sourceHubPath = join(rootDir, 'source-hub');
    const index = makeIndex();
    index.registerSource({ id: 'src', list: async () => [{ kind: 'hub', path: sourceHubPath, name: 'source-hub', memberPaths: [member] }] });
    const registry = makeRegistry(index);
    const { path: hubPath } = await registry.createHub({ name: 'group', root: rootDir, memberPaths: [member] });
    const before = await registry.list();

    const onChange = vi.fn();
    registry.onChange(onChange);
    await registry.update({ folderPath: member, addTags: ['legacy'] });

    // The member plus every hub whose inherited tags move with it — no more.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ changedPaths: [member, hubPath, sourceHubPath], removedPaths: [] });

    // The emitted targets are exactly the rows a fresh listing shows changed.
    const after = await registry.list();
    const changedRows = after.filter((row) => JSON.stringify(before.find((old) => old.path === row.path)) !== JSON.stringify(row));
    expect(changedRows.map((row) => row.path).sort()).toEqual([member, hubPath, sourceHubPath].sort());
    // Both hubs inherit the member's new tag.
    expect(changedRows.find((row) => row.path === hubPath)?.tags).toContain('legacy');
    expect(changedRows.find((row) => row.path === sourceHubPath)?.tags).toContain('legacy');
  });
});

describe('serve-path helpers', () => {
  function row(path: string): FolderInfo {
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

  it('enrichActiveSessionCounts counts live sessions per exact folder path', () => {
    const folders = [row('/a'), row('/b')];
    enrichActiveSessionCounts(folders, [{ folderPath: '/a' }, { folderPath: '/a' }, { folderPath: null }]);
    expect(folders.map((folder) => folder.activeSessionCount)).toEqual([2, 0]);
  });
});
