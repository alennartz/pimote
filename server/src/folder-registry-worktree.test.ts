import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat, readlink, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderRegistry } from './folder-registry.js';
import { RepoIndex } from './repo-index.js';
import { scanFolderModel } from './folder-model/index.js';
import type { FolderModelPort } from './manager/types.js';
import { HubWorktrees, defaultWorktreeGitRunner, type HubWorktreePort, type WorktreeRecognition, type WorktreeRemovalCheck } from './hub-worktrees.js';
import { HubActivity } from './hub-activity.js';
import { hubAgentsMarkdown } from './hub-agents-md.js';

const execFileAsync = promisify(execFile);

// The worktree-hub mode marker this topic owns.
const MARKER_FILE = '.pimote-hub.json';

let tempDir: string;
let storeDir: string;
let rootDir: string;
let secondRoot: string;
let repoA: string;
let repoB: string;
let persona: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'folder-registry-worktree-test-'));
  storeDir = join(tempDir, 'registry');
  rootDir = join(tempDir, 'root');
  secondRoot = join(tempDir, 'second-root');
  repoA = join(rootDir, 'repo-a');
  repoB = join(rootDir, 'repo-b');
  persona = join(rootDir, 'ada');
  await mkdir(rootDir, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await initRepo(repoA);
  await initRepo(repoB);
  await mkdir(persona, { recursive: true });
  await writeFile(join(persona, 'AGENTS.md'), '---\nkind: persona\nname: Ada\ndescription: Greets everyone\n---\n\nBody.\n', 'utf8');
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
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: repoPath });
  await writeFile(join(repoPath, 'tracked.txt'), 'original\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoPath });
  await execFileAsync('git', [...gitArgs, 'commit', '-m', 'init'], { cwd: repoPath });
}

function makeIndex(): RepoIndex {
  return new RepoIndex([rootDir, secondRoot], { now: () => 0, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
}

function makeTree(): FolderModelPort {
  return { tree: () => scanFolderModel({ roots: [rootDir, secondRoot] }) };
}

/** A nested detached worktree inside `hubDir`, created directly through Git. */
async function addNestedWorktree(hubDir: string, sourcePath: string, childName: string): Promise<string> {
  const worktreePath = join(hubDir, childName);
  await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd: sourcePath });
  return worktreePath;
}

async function gitWorktreeList(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf-8' });
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

/** A hand-built worktree hub on disk: the mode marker plus a nested detached
 *  worktree for repo-a. This is the shape the implementation must produce. */
async function makeWorktreeHub(name = 'platform'): Promise<{ hubPath: string; worktreePath: string }> {
  const hubPath = join(rootDir, name);
  await mkdir(hubPath, { recursive: true });
  const gitArgs = ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: hubPath });
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: hubPath });
  await writeFile(join(hubPath, MARKER_FILE), JSON.stringify({ memberRepresentation: 'worktree' }), 'utf8');
  await writeFile(join(hubPath, 'AGENTS.md'), hubAgentsMarkdown({ name, members: [{ name: 'repo-a', nature: 'code' }], representation: 'worktree' }), 'utf8');
  await writeFile(join(hubPath, '.gitignore'), '/.pimote-hub.json\n/repo-a\n', 'utf8');
  await new HubWorktrees(defaultWorktreeGitRunner).stageGenerated(hubPath, ['AGENTS.md', '.gitignore'], true);
  const worktreePath = await addNestedWorktree(hubPath, repoA, 'repo-a');
  return { hubPath, worktreePath };
}

/** A hand-built symlink hub on disk: symlinks only, no mode marker. */
async function makeSymlinkHub(name = 'plain'): Promise<string> {
  const hubPath = join(rootDir, name);
  await mkdir(hubPath, { recursive: true });
  await writeFile(join(hubPath, 'AGENTS.md'), '# plain\n', 'utf8');
  const gitArgs = ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: hubPath });
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: hubPath });
  await symlink(repoA, join(hubPath, 'repo-a'));
  return hubPath;
}

async function findRow(registry: FolderRegistry, path: string): Promise<FolderInfo | undefined> {
  return (await registry.list()).find((folder) => folder.path === path);
}

describe('FolderRegistry.createHub — worktree mode', () => {
  it('preserves a selected linked-worktree source identity', async () => {
    const linkedSource = join(rootDir, 'linked-source');
    await execFileAsync('git', ['worktree', 'add', linkedSource], { cwd: repoA });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform-linked', root: rootDir, memberPaths: [linkedSource], memberRepresentation: 'worktree' });
    const row = await findRow(registry, created.path);

    expect(row?.members?.find((member) => member.name === 'linked-source')?.path).toBe(linkedSource);
    expect(row?.repos?.find((repo) => repo.worktreePath === join(created.path, 'linked-source'))?.path).toBe(linkedSource);
  });

  it('allows a second hub from the same canonical repository', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    await registry.createHub({ name: 'first', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });
    const second = await registry.createHub({ name: 'second', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });

    const row = await findRow(registry, second.path);
    expect(row?.members?.find((member) => member.path === repoA)?.worktreePath).toBe(join(second.path, 'repo-a'));
  });

  it('rejects equal-basename linked sources before publishing an ambiguous hub', async () => {
    const linkedSource = join(secondRoot, 'repo-a');
    await execFileAsync('git', ['worktree', 'add', linkedSource], { cwd: repoA });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await expect(registry.createHub({ name: 'ambiguous', root: rootDir, memberPaths: [linkedSource], memberRepresentation: 'worktree' })).rejects.toThrow(/ambiguous/i);

    expect(existsSync(join(rootDir, 'ambiguous'))).toBe(false);
    expect(await gitWorktreeList(repoA)).not.toContain(join(rootDir, 'ambiguous', 'repo-a'));
  });

  it('materializes code members as detached worktrees and persona members as symlinks', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA, persona], memberRepresentation: 'worktree' });

    const hubPath = created.path;
    const marker = JSON.parse(await readFile(join(hubPath, MARKER_FILE), 'utf8')) as { memberRepresentation: string };
    expect(marker).toEqual({ memberRepresentation: 'worktree' });
    // The code member is a real nested checkout, not a symlink.
    const codeChild = join(hubPath, 'repo-a');
    expect((await lstat(codeChild)).isSymbolicLink()).toBe(false);
    expect((await lstat(join(codeChild, '.git'))).isDirectory()).toBe(false);
    expect(await gitWorktreeList(repoA)).toContain(codeChild);
    // The persona member remains a symlink.
    const personaChild = join(hubPath, 'ada');
    expect((await lstat(personaChild)).isSymbolicLink()).toBe(true);
    expect(await readlink(personaChild)).toBe(persona);
  });

  it('reports the worktree hub fact and per-member representation on the row', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA, persona], memberRepresentation: 'worktree' });

    const row = await findRow(registry, created.path);
    expect(row?.hub).toEqual({ representation: 'worktree' });
    const codeMember = row?.members?.find((member) => member.path === repoA);
    expect(codeMember?.representation).toBe('worktree');
    expect(codeMember?.worktreePath).toBe(join(created.path, 'repo-a'));
    const personaMember = row?.members?.find((member) => member.path === persona);
    expect(personaMember?.representation).toBe('symlink');
  });

  it('enriches code member repos with the nested checkout path', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });

    const row = await findRow(registry, created.path);
    const repoRow = row?.repos?.find((repo) => repo.path === repoA);
    expect(repoRow?.worktreePath).toBe(join(created.path, 'repo-a'));
  });

  it('starts at the source HEAD without changing its uncommitted files', async () => {
    await writeFile(join(repoA, 'tracked.txt'), 'source changes\n', 'utf8');
    await writeFile(join(repoA, 'untracked.txt'), 'source only\n', 'utf8');
    const before = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoA });
    const sourceHead = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoA });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });

    const child = join(created.path, 'repo-a');
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: child });
    const branch = await execFileAsync('git', ['branch', '--show-current'], { cwd: child });
    const after = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoA });
    expect(head.stdout.trim()).toBe(sourceHead.stdout.trim());
    expect(branch.stdout.trim()).toBe('');
    expect(after.stdout).toBe(before.stdout);
    expect(await readFile(join(repoA, 'tracked.txt'), 'utf8')).toBe('source changes\n');
    expect(await readFile(join(repoA, 'untracked.txt'), 'utf8')).toBe('source only\n');
  });

  it('ignores the marker and member children in the hub repository', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA, persona], memberRepresentation: 'worktree' });

    const ignored = await execFileAsync('git', ['check-ignore', '.pimote-hub.json', 'repo-a', 'ada'], { cwd: created.path });

    expect(ignored.stdout.split('\n')).toEqual(expect.arrayContaining(['.pimote-hub.json', 'repo-a', 'ada']));
  });

  it('uses checkout status on the hub row while retaining canonical repo identity', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });
    const child = join(created.path, 'repo-a');
    await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: child });
    await writeFile(join(child, 'scratch.txt'), 'wip\n', 'utf8');

    const row = await findRow(registry, created.path);
    expect(row).toBeDefined();
    await registry.enrichRows([row!]);
    const repo = row?.repos?.find((entry) => entry.path === repoA);
    expect(repo).toMatchObject({ path: repoA, worktreePath: child, branch: 'feature', dirty: true });
  });

  it('reports the symlink hub fact on symlink-mode rows', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA] });

    const row = await findRow(registry, created.path);
    expect(row?.hub).toEqual({ representation: 'symlink' });
    expect((await lstat(join(created.path, 'repo-a'))).isSymbolicLink()).toBe(true);
    expect(existsSync(join(created.path, MARKER_FILE))).toBe(false);
  });

  it('rolls back created worktrees and removes the hub when materialization fails', async () => {
    const worktreesPresentBeforeRemoval: string[] = [];
    const worktreePort: HubWorktreePort = {
      async recognize(): Promise<WorktreeRecognition | null> {
        return null;
      },
      async createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void> {
        if (input.sourcePath === repoB) throw new Error('worktree add failed');
        await execFileAsync('git', ['worktree', 'add', '--detach', input.worktreePath, 'HEAD'], { cwd: input.sourcePath });
      },
      async validateRemoval(): Promise<WorktreeRemovalCheck> {
        return { dirty: false, detached: true, headReachableFromBranchRef: true };
      },
      async remove(input: { sourcePath: string; worktreePath: string }): Promise<void> {
        if (existsSync(input.worktreePath)) worktreesPresentBeforeRemoval.push(input.worktreePath);
        await execFileAsync('git', ['worktree', 'remove', input.worktreePath], { cwd: input.sourcePath });
      },
      async stageGenerated(): Promise<void> {},
      async isDirty(): Promise<boolean> {
        return false;
      },
      async pruneStale(): Promise<void> {},
    };
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), worktreePort);

    await expect(registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA, repoB], memberRepresentation: 'worktree' })).rejects.toThrow('worktree add failed');

    expect(worktreesPresentBeforeRemoval).toContain(join(rootDir, 'platform', 'repo-a'));
    expect(await gitWorktreeList(repoA)).not.toContain(join(rootDir, 'platform', 'repo-a'));
    expect(existsSync(join(rootDir, 'platform'))).toBe(false);
  });
});

describe('FolderRegistry.addMember — worktree hubs', () => {
  it('rejects equal-basename linked sources before creating an ambiguous checkout', async () => {
    const linkedSource = join(secondRoot, 'repo-a');
    await execFileAsync('git', ['worktree', 'add', linkedSource], { cwd: repoA });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    const created = await registry.createHub({ name: 'empty', root: rootDir, memberPaths: [], memberRepresentation: 'worktree' });

    await expect(registry.addMember(created.path, linkedSource)).rejects.toThrow(/ambiguous/i);

    expect(await gitWorktreeList(repoA)).not.toContain(join(created.path, 'repo-a'));
  });

  it('materializes a code member as a detached worktree in a worktree hub', async () => {
    const { hubPath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await registry.addMember(hubPath, repoB);

    const child = join(hubPath, 'repo-b');
    expect((await lstat(child)).isSymbolicLink()).toBe(false);
    expect((await lstat(join(child, '.git'))).isDirectory()).toBe(false);
    expect(await gitWorktreeList(repoB)).toContain(child);
    const row = await findRow(registry, hubPath);
    const member = row?.members?.find((entry) => entry.path === repoB);
    expect(member?.representation).toBe('worktree');
    expect(member?.worktreePath).toBe(child);
  });
});

describe('FolderRegistry.addMember — rollback', () => {
  it('removes a newly created checkout through Git when a later hub file update fails', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const created = join(hubPath, 'repo-b');
    let createdCheckout = false;
    const worktrees: HubWorktreePort = {
      async recognize(path) {
        const sourcePath = path === worktreePath ? repoA : path === created ? repoB : undefined;
        return sourcePath && existsSync(path) ? { worktreePath: path, sourceCandidates: [sourcePath] } : null;
      },
      async createDetached({ sourcePath, worktreePath: child }) {
        await execFileAsync('git', ['worktree', 'add', '--detach', child, 'HEAD'], { cwd: sourcePath });
        createdCheckout = existsSync(child);
        await rm(join(hubPath, 'AGENTS.md'));
        await mkdir(join(hubPath, 'AGENTS.md'));
      },
      async validateRemoval() {
        return { dirty: false, detached: true, headReachableFromBranchRef: true };
      },
      async remove({ sourcePath, worktreePath: child }) {
        await execFileAsync('git', ['worktree', 'remove', child], { cwd: sourcePath });
      },
      async stageGenerated(): Promise<void> {},
      async isDirty(): Promise<boolean> {
        return false;
      },
      async pruneStale(): Promise<void> {},
    };
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), worktrees);

    await expect(registry.addMember(hubPath, repoB)).rejects.toThrow();

    expect(createdCheckout).toBe(true);
    expect(await gitWorktreeList(repoB)).not.toContain(created);
    expect(existsSync(created)).toBe(false);
    expect(await gitWorktreeList(repoA)).toContain(worktreePath);
  });
});

describe('FolderRegistry.addMember — persona members', () => {
  it('adds personas as symlinks in a worktree hub', async () => {
    const { hubPath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await registry.addMember(hubPath, persona);

    expect((await lstat(join(hubPath, 'ada'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(hubPath, 'ada'))).toBe(persona);
  });
});

describe('FolderRegistry.removeMember — worktree hubs', () => {
  it('does not stage user prose when removing a symlink member', async () => {
    const hubPath = await makeSymlinkHub('symlink-prose');
    await execFileAsync('git', ['add', 'AGENTS.md'], { cwd: hubPath });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'generated'], { cwd: hubPath });
    await writeFile(join(hubPath, 'AGENTS.md'), '# plain\nUser prose\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await registry.removeMember(hubPath, repoA);

    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: hubPath });
    expect(status.stdout).toContain(' M AGENTS.md');
  });

  it("removes a worktree member's nested checkout and preserves the source repository", async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await registry.removeMember(hubPath, repoA);

    expect(existsSync(worktreePath)).toBe(false);
    expect(await gitWorktreeList(repoA)).not.toContain(worktreePath);
    // The canonical source checkout stays untouched.
    expect(existsSync(join(repoA, '.git'))).toBe(true);
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoA, encoding: 'utf-8' });
    expect(stdout.trim()).toBe('main');
    const row = await findRow(registry, hubPath);
    expect(row?.members?.some((member) => member.path === repoA)).toBe(false);
  });

  it.each(['untracked', 'unstaged', 'staged'])('refuses to remove a member with %s changes', async (kind) => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const file = kind === 'untracked' ? 'scratch.txt' : 'tracked.txt';
    await writeFile(join(worktreePath, file), 'wip\n', 'utf8');
    if (kind === 'staged') await execFileAsync('git', ['add', file], { cwd: worktreePath });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    expect((await findRow(registry, hubPath))?.members?.some((member) => member.path === repoA)).toBe(true);
    await expect(registry.removeMember(hubPath, repoA)).rejects.toThrow(/dirty|uncommitted|changes/i);

    expect(existsSync(worktreePath)).toBe(true);
    expect(await readFile(join(worktreePath, file), 'utf8')).toBe('wip\n');
    expect(await gitWorktreeList(repoA)).toContain(worktreePath);
  });

  it('keeps worktree mode after removing the last code member', async () => {
    const { hubPath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    await registry.removeMember(hubPath, repoA);
    expect((await findRow(registry, hubPath))?.hub?.representation).toBe('worktree');
    await registry.addMember(hubPath, repoB);

    expect((await lstat(join(hubPath, 'repo-b'))).isSymbolicLink()).toBe(false);
    expect(await gitWorktreeList(repoB)).toContain(join(hubPath, 'repo-b'));
  });
});

describe('FolderRegistry.disbandHub', () => {
  it('removes every nested worktree and the hub directory, reporting the removed paths', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });
    const changes: Array<{ changedPaths: string[]; removedPaths: string[] }> = [];
    registry.onChange((change) => changes.push(change));

    const result = await registry.disbandHub(hubPath);

    expect(changes).toHaveLength(1);
    expect(changes[0].removedPaths).toContain(hubPath);
    expect(result.removedWorktreePaths).toEqual([worktreePath]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(hubPath)).toBe(false);
    expect(await gitWorktreeList(repoA)).not.toContain(worktreePath);
  });

  it('rejects a worktree-shaped directory when the marker is absent', async () => {
    const hubPath = join(rootDir, 'unmarked');
    await initRepo(hubPath);
    await writeFile(join(hubPath, 'AGENTS.md'), '# unmarked\n', 'utf8');
    const worktreePath = await addNestedWorktree(hubPath, repoA, 'repo-a');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/marked worktree hub/i);

    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('rejects a symlink hub without a marker or nested worktree', async () => {
    const hubPath = await makeSymlinkHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/worktree hub/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects unexpected hub content and keeps the hub', async () => {
    const { hubPath } = await makeWorktreeHub();
    await writeFile(join(hubPath, 'notes.txt'), 'keep me\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/unrecognized content/i);
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(join(hubPath, 'notes.txt'))).toBe(true);
  });

  it('does not rebaseline user prose when adding a worktree member', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    const created = await registry.createHub({ name: 'created', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });
    await writeFile(join(created.path, 'AGENTS.md'), `${await readFile(join(created.path, 'AGENTS.md'), 'utf8')}\nUser prose\n`, 'utf8');

    await registry.addMember(created.path, repoB);

    await expect(registry.disbandHub(created.path)).rejects.toThrow(/generated hub instructions|hub repository has uncommitted changes/i);
    expect(existsSync(created.path)).toBe(true);
  });

  it('rejects edits to generated files from registry creation', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());
    const created = await registry.createHub({ name: 'created', root: rootDir, memberPaths: [repoA], memberRepresentation: 'worktree' });
    await writeFile(join(created.path, 'AGENTS.md'), '# changed by user\n', 'utf8');

    await expect(registry.disbandHub(created.path)).rejects.toThrow(/generated hub instructions|hub repository has uncommitted changes/i);
    expect(existsSync(created.path)).toBe(true);
  });

  it('rejects tracked edits to generated hub files', async () => {
    const { hubPath } = await makeWorktreeHub();
    await execFileAsync('git', ['add', 'AGENTS.md'], { cwd: hubPath });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'generated'], { cwd: hubPath });
    await writeFile(join(hubPath, 'AGENTS.md'), '# changed by user\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/generated hub instructions|hub repository has uncommitted changes/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it.each(['AGENTS.md', 'memory.md'])('rejects a generated entry with the wrong type: %s', async (name) => {
    const { hubPath } = await makeWorktreeHub();
    await rm(join(hubPath, name), { force: true, recursive: true });
    await mkdir(join(hubPath, name));
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/generated hub entry has the wrong type/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects edited untracked persona memory content', async () => {
    const { hubPath } = await makeWorktreeHub();
    await writeFile(join(hubPath, 'memory.md'), 'edited\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/persona memory was edited/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects an edited generated gitignore', async () => {
    const { hubPath } = await makeWorktreeHub();
    await writeFile(join(hubPath, '.gitignore'), '/.pimote-hub.json\n/repo-a\n/notes.txt\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/gitignore was edited/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('allows generated hub files and managed worktree children', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await writeFile(join(hubPath, '.gitignore'), '/.pimote-hub.json\n/repo-a\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await registry.disbandHub(hubPath);

    expect(existsSync(hubPath)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('rejects when a worktree has uncommitted changes and keeps the hub', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await writeFile(join(worktreePath, 'scratch.txt'), 'wip\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/uncommitted|dirty|changes/i);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects when a detached HEAD is not reachable from a branch ref', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const gitArgs = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'wip'], { cwd: worktreePath });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/reachable|detached/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('validates every worktree before removing any', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const second = await addNestedWorktree(hubPath, repoB, 'repo-b');
    await writeFile(
      join(hubPath, 'AGENTS.md'),
      hubAgentsMarkdown({
        name: 'platform',
        members: [
          { name: 'repo-a', nature: 'code' },
          { name: 'repo-b', nature: 'code' },
        ],
        representation: 'worktree',
      }),
      'utf8',
    );
    await writeFile(join(hubPath, '.gitignore'), '/.pimote-hub.json\n/repo-a\n/repo-b\n', 'utf8');
    await new HubWorktrees(defaultWorktreeGitRunner).stageGenerated(hubPath, ['AGENTS.md', '.gitignore'], false, true);
    await writeFile(join(second, 'scratch.txt'), 'wip\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/dirty|uncommitted|changes/i);

    expect(existsSync(hubPath)).toBe(true);
    expect(await gitWorktreeList(repoA)).toContain(worktreePath);
    expect(await gitWorktreeList(repoB)).toContain(second);
  });

  it.each(['refs/heads/feature', 'refs/remotes/origin/feature'])('allows detached commits reachable from %s', async (ref) => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'feature'], { cwd: worktreePath });
    await execFileAsync('git', ['update-ref', ref, 'HEAD'], { cwd: worktreePath });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { closeIdleSessionsAt: async () => [] });

    await registry.disbandHub(hubPath);

    expect(existsSync(hubPath)).toBe(false);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: repoA });
    expect(stdout.trim()).not.toBe('');
  });

  it('leaves the hub and remaining checkout discoverable after a removal failure, so retry succeeds', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const second = await addNestedWorktree(hubPath, repoB, 'repo-b');
    await writeFile(
      join(hubPath, 'AGENTS.md'),
      hubAgentsMarkdown({
        name: 'platform',
        members: [
          { name: 'repo-a', nature: 'code' },
          { name: 'repo-b', nature: 'code' },
        ],
        representation: 'worktree',
      }),
      'utf8',
    );
    await writeFile(join(hubPath, '.gitignore'), '/.pimote-hub.json\n/repo-a\n/repo-b\n', 'utf8');
    await new HubWorktrees(defaultWorktreeGitRunner).stageGenerated(hubPath, ['AGENTS.md', '.gitignore'], false, true);
    const sources = new Map([
      [worktreePath, repoA],
      [second, repoB],
    ]);
    let removedOne = false;
    let failed = false;
    const worktrees: HubWorktreePort = {
      async recognize(path) {
        const sourcePath = sources.get(path);
        return sourcePath && existsSync(path) ? { worktreePath: path, sourceCandidates: [sourcePath] } : null;
      },
      async createDetached() {
        throw new Error('unexpected creation');
      },
      async validateRemoval() {
        return { dirty: false, detached: true, headReachableFromBranchRef: true };
      },
      async stageGenerated(): Promise<void> {},
      async isDirty(): Promise<boolean> {
        return false;
      },
      async pruneStale(): Promise<void> {},
      async remove({ sourcePath, worktreePath: child }) {
        if (removedOne && !failed) {
          failed = true;
          throw new Error('temporary removal failure');
        }
        await execFileAsync('git', ['worktree', 'remove', child], { cwd: sourcePath });
        removedOne = true;
      },
    };
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), worktrees, { closeIdleSessionsAt: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow();
    expect(existsSync(hubPath)).toBe(true);
    const remaining = [worktreePath, second].filter(existsSync);
    expect(remaining).toHaveLength(1);
    const row = await findRow(registry, hubPath);
    expect(row?.members?.some((member) => member.worktreePath === remaining[0])).toBe(true);
    expect(await readFile(join(hubPath, '.gitignore'), 'utf8')).not.toContain('/repo-a\n');

    await registry.disbandHub(hubPath);
    expect(existsSync(hubPath)).toBe(false);
    expect(await gitWorktreeList(repoA)).not.toContain(worktreePath);
    expect(await gitWorktreeList(repoB)).not.toContain(second);
  });

  it.each(['session', 'external pi'])('keeps the hub when a %s remains in a checkout descendant', async (kind) => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const cwd = join(worktreePath, 'src');
    await mkdir(cwd);
    const activity = new HubActivity({
      // The close source reports the session as remaining (working or
      // observed); external pi processes stay out of its reach.
      closeIdleSessionsAt: async () => (kind === 'session' ? [cwd] : []),
      externalPiWorkingDirectories: async () => (kind === 'external pi' ? [cwd] : []),
    });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, activity);

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/active|busy|session|process/i);

    expect(existsSync(hubPath)).toBe(true);
    expect(await gitWorktreeList(repoA)).toContain(worktreePath);
  });

  it('rejects when the activity port reports a busy path in the hub subtree', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, {
      closeIdleSessionsAt: async (paths) => paths.filter((path) => path === worktreePath),
    });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/active|busy|session|process/i);
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('closes an idle observerless session before the remaining guards run', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await writeFile(join(worktreePath, 'scratch.txt'), 'wip\n', 'utf8');
    const closeRequests: ReadonlyArray<string>[] = [];
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, {
      closeIdleSessionsAt: async (paths) => {
        // The idle session slot was closed; nothing remains busy.
        closeRequests.push(paths);
        return [];
      },
    });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/uncommitted|dirty|changes/i);
    // The close request covers the hub and the nested checkout, whatever the
    // worktree's dirty state is, and the dirty guard still keeps the hub.
    expect(closeRequests[0]).toContain(hubPath);
    expect(closeRequests[0]).toContain(worktreePath);
    expect(existsSync(hubPath)).toBe(true);
  });
});
