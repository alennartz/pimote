import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubWorktrees } from './hub-worktrees.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let sourceRepo: string;
let hubDir: string;
let worktrees: HubWorktrees;

/** The guarded Git runner adapter the production module uses (same
 *  environment protections as the repo's other git seams). */
const gitRunner = async (args: string[], cwd: string): Promise<{ stdout: string }> => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_OPTIONAL_LOCKS = '0';
  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf-8', timeout: 2000 });
  return { stdout };
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hub-worktrees-test-'));
  sourceRepo = join(tempDir, 'repo-a');
  hubDir = join(tempDir, 'hub');
  await mkdir(sourceRepo, { recursive: true });
  await mkdir(hubDir, { recursive: true });
  const gitArgs = ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: sourceRepo });
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: sourceRepo });
  worktrees = new HubWorktrees(gitRunner);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** A nested detached worktree inside the hub, created directly through Git. */
async function addNestedWorktree(childName: string): Promise<string> {
  const worktreePath = join(hubDir, childName);
  await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd: sourceRepo });
  return worktreePath;
}

async function gitWorktreeList(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf-8' });
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

describe('HubWorktrees.inspectMember', () => {
  it('recognizes a nested detached worktree and reports its facts', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    const facts = await worktrees.inspectMember(worktreePath);

    expect(facts).toMatchObject({
      sourcePath: sourceRepo,
      worktreePath,
      branch: null,
      dirty: false,
      detached: true,
      headReachableFromBranchRef: true,
    });
  });

  it('returns null for an ordinary nested directory', async () => {
    const plain = join(hubDir, 'plain');
    await mkdir(plain);

    await expect(worktrees.inspectMember(plain)).resolves.toBeNull();
  });

  it('returns null for an independent repository with a .git directory', async () => {
    const independent = join(hubDir, 'independent');
    await mkdir(independent, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: independent });

    await expect(worktrees.inspectMember(independent)).resolves.toBeNull();
  });

  it('returns null for a path Git cannot verify', async () => {
    await expect(worktrees.inspectMember(join(hubDir, 'missing'))).resolves.toBeNull();
  });
});

describe('HubWorktrees.createDetached', () => {
  it('creates a detached worktree at the hub child from the source HEAD', async () => {
    const worktreePath = join(hubDir, 'repo-a');

    await worktrees.createDetached({ sourcePath: sourceRepo, worktreePath });

    const gitEntry = await lstat(join(worktreePath, '.git'));
    expect(gitEntry.isDirectory()).toBe(false);
    const listed = await gitWorktreeList(sourceRepo);
    expect(listed).toContain(worktreePath);
  });

  it('rejects when the target already exists', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    await expect(worktrees.createDetached({ sourcePath: sourceRepo, worktreePath })).rejects.toThrow(/already exists/i);
  });
});

describe('HubWorktrees.validateRemoval', () => {
  it('reports clean reachable state for an untouched detached worktree', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    const check = await worktrees.validateRemoval({ sourcePath: sourceRepo, worktreePath });

    expect(check).toEqual({ dirty: false, detached: true, headReachableFromBranchRef: true });
  });

  it('reports dirty when the worktree has uncommitted changes', async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    await writeFile(join(worktreePath, 'scratch.txt'), 'wip\n', 'utf8');

    const check = await worktrees.validateRemoval({ sourcePath: sourceRepo, worktreePath });

    expect(check.dirty).toBe(true);
  });

  it('reports unreachable HEAD for a commit made on detached HEAD', async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    const gitArgs = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'wip'], { cwd: worktreePath });

    const check = await worktrees.validateRemoval({ sourcePath: sourceRepo, worktreePath });

    expect(check.headReachableFromBranchRef).toBe(false);
  });
});

describe('HubWorktrees.remove', () => {
  it('removes the nested worktree and leaves the source repository intact', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    await worktrees.remove({ sourcePath: sourceRepo, worktreePath });

    expect(existsSync(worktreePath)).toBe(false);
    expect(await gitWorktreeList(sourceRepo)).not.toContain(worktreePath);
    const head = await readFile(join(sourceRepo, '.git', 'HEAD'), 'utf8');
    expect(head.trim()).toBe('ref: refs/heads/main');
  });

  it('preserves user-created branches in the source repository', async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    await execFileAsync('git', ['branch', 'feature'], { cwd: sourceRepo });

    await worktrees.remove({ sourcePath: sourceRepo, worktreePath });

    const { stdout } = await execFileAsync('git', ['branch', '--list', 'feature'], { cwd: sourceRepo, encoding: 'utf-8' });
    expect(stdout).toContain('feature');
  });
});
