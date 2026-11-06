import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderRegistry } from './folder-registry.js';
import { RepoIndex } from './repo-index.js';
import { scanFolderModel } from './folder-model/index.js';
import type { FolderModelPort } from './manager/types.js';
import type { HubWorktreePort, WorktreeMemberFacts, WorktreeRemovalCheck } from './hub-worktrees.js';

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
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: repoPath });
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
  await writeFile(join(hubPath, MARKER_FILE), JSON.stringify({ memberRepresentation: 'worktree' }), 'utf8');
  await writeFile(join(hubPath, 'AGENTS.md'), '# platform\n', 'utf8');
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
  return hubPath;
}

async function findRow(registry: FolderRegistry, path: string): Promise<FolderInfo | undefined> {
  return (await registry.list()).find((folder) => folder.path === path);
}

describe('FolderRegistry.createHub — worktree mode', () => {
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

  it('reports the symlink hub fact on symlink-mode rows', async () => {
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree());

    const created = await registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA] });

    const row = await findRow(registry, created.path);
    expect(row?.hub).toEqual({ representation: 'symlink' });
  });

  it('rolls back created worktrees and removes the hub when materialization fails', async () => {
    const createdWorktrees: string[] = [];
    const removedWorktrees: string[] = [];
    const worktreePort: HubWorktreePort = {
      async inspectMember(): Promise<WorktreeMemberFacts | null> {
        return null;
      },
      async createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void> {
        if (input.sourcePath === repoB) throw new Error('worktree add failed');
        createdWorktrees.push(input.worktreePath);
      },
      async validateRemoval(): Promise<WorktreeRemovalCheck> {
        return { dirty: false, detached: true, headReachableFromBranchRef: true };
      },
      async remove(input: { sourcePath: string; worktreePath: string }): Promise<void> {
        removedWorktrees.push(input.worktreePath);
      },
    };
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), worktreePort);

    await expect(registry.createHub({ name: 'platform', root: rootDir, memberPaths: [repoA, repoB], memberRepresentation: 'worktree' })).rejects.toThrow('worktree add failed');

    expect(existsSync(join(rootDir, 'platform'))).toBe(false);
    expect(removedWorktrees).toEqual(createdWorktrees);
  });
});

describe('FolderRegistry.addMember — worktree hubs', () => {
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

describe('FolderRegistry.removeMember — worktree hubs', () => {
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
});

describe('FolderRegistry.disbandHub', () => {
  it('removes every nested worktree and the hub directory, reporting the removed paths', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { findBusyPaths: async () => [] });

    const result = await registry.disbandHub(hubPath);

    expect(result.removedWorktreePaths).toEqual([worktreePath]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(hubPath)).toBe(false);
    expect(await gitWorktreeList(repoA)).not.toContain(worktreePath);
  });

  it('accepts a worktree hub identified by a valid nested worktree when the marker is absent', async () => {
    const hubPath = join(rootDir, 'unmarked');
    await mkdir(hubPath, { recursive: true });
    await writeFile(join(hubPath, 'AGENTS.md'), '# unmarked\n', 'utf8');
    const worktreePath = await addNestedWorktree(hubPath, repoA, 'repo-a');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { findBusyPaths: async () => [] });

    const result = await registry.disbandHub(hubPath);

    expect(result.removedWorktreePaths).toEqual([worktreePath]);
    expect(existsSync(hubPath)).toBe(false);
  });

  it('rejects a symlink hub without a marker or nested worktree', async () => {
    const hubPath = await makeSymlinkHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { findBusyPaths: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/worktree hub/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects when a worktree has uncommitted changes and keeps the hub', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await writeFile(join(worktreePath, 'scratch.txt'), 'wip\n', 'utf8');
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { findBusyPaths: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/uncommitted|dirty|changes/i);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects when a detached HEAD is not reachable from a branch ref', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const gitArgs = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'wip'], { cwd: worktreePath });
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, { findBusyPaths: async () => [] });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/reachable|detached/i);
    expect(existsSync(hubPath)).toBe(true);
  });

  it('rejects when the activity port reports a busy path in the hub subtree', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, {
      findBusyPaths: async (paths) => paths.filter((path) => path === worktreePath),
    });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow(/active|busy|session|process/i);
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('checks the hub subtree for activity before validating worktree state', async () => {
    const { hubPath, worktreePath } = await makeWorktreeHub();
    await writeFile(join(worktreePath, 'scratch.txt'), 'wip\n', 'utf8');
    const busyCalls: ReadonlyArray<string>[] = [];
    const registry = new FolderRegistry(makeIndex(), storeDir, makeTree(), undefined, {
      findBusyPaths: async (paths) => {
        busyCalls.push(paths);
        return [worktreePath];
      },
    });

    await expect(registry.disbandHub(hubPath)).rejects.toThrow();
    // The activity guard sees the hub and the nested checkout, whatever the
    // worktree's dirty state is.
    expect(busyCalls[0]).toContain(hubPath);
    expect(busyCalls[0]).toContain(worktreePath);
    expect(existsSync(hubPath)).toBe(true);
  });
});
