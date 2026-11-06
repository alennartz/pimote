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
  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf-8', timeout: 10000 });
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
  await writeFile(join(sourceRepo, 'tracked.txt'), 'original\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: sourceRepo });
  await execFileAsync('git', [...gitArgs, 'commit', '-m', 'init'], { cwd: sourceRepo });
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

describe('HubWorktrees.recognize', () => {
  it('recognizes a nested detached worktree and reports the worktree set as source candidates', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    const recognition = await worktrees.recognize(worktreePath);

    expect(recognition).toEqual({ worktreePath, sourceCandidates: [sourceRepo] });
  });

  it('lists linked worktrees after the main worktree in the source candidates', async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    const linked = join(tempDir, 'linked');
    await execFileAsync('git', ['worktree', 'add', linked], { cwd: sourceRepo });

    const recognition = await worktrees.recognize(worktreePath);

    expect(recognition?.sourceCandidates).toEqual([sourceRepo, linked]);
  });

  it('excludes a bare main worktree from the source candidates', async () => {
    const bare = join(tempDir, 'bare');
    await execFileAsync('git', ['clone', '--bare', sourceRepo, bare]);
    const child = join(hubDir, 'from-bare');
    await execFileAsync('git', ['worktree', 'add', '--detach', child, 'HEAD'], { cwd: bare });

    const recognition = await worktrees.recognize(child);

    expect(recognition?.sourceCandidates).toEqual([bare]);
  });

  it('recognizes without running status or reachability probes', async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    const calls: string[][] = [];
    const observing = new HubWorktrees(async (args, cwd) => {
      calls.push(args);
      return gitRunner(args, cwd);
    });

    await observing.recognize(worktreePath);

    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it('returns null for an ordinary nested directory', async () => {
    const plain = join(hubDir, 'plain');
    await mkdir(plain);

    await expect(worktrees.recognize(plain)).resolves.toBeNull();
  });

  it('returns null for an independent repository with a .git directory', async () => {
    const independent = join(hubDir, 'independent');
    await mkdir(independent, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: independent });

    await expect(worktrees.recognize(independent)).resolves.toBeNull();
  });

  it('returns null for a path Git cannot verify', async () => {
    await expect(worktrees.recognize(join(hubDir, 'missing'))).resolves.toBeNull();
  });
});

describe('HubWorktrees.isDirty', () => {
  it('reports a clean repository as not dirty', async () => {
    await expect(worktrees.isDirty(sourceRepo)).resolves.toBe(false);
  });

  it('reports untracked changes as dirty', async () => {
    await writeFile(join(sourceRepo, 'scratch.txt'), 'wip\n', 'utf8');
    await expect(worktrees.isDirty(sourceRepo)).resolves.toBe(true);
  });
});

describe('HubWorktrees.pruneStale', () => {
  it("drops worktree metadata left behind a checkout removed behind Git's back", async () => {
    const worktreePath = await addNestedWorktree('repo-a');
    await rm(worktreePath, { recursive: true, force: true });
    expect(await gitWorktreeList(sourceRepo)).toContain(worktreePath);

    await worktrees.pruneStale(sourceRepo);

    expect(await gitWorktreeList(sourceRepo)).not.toContain(worktreePath);
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
    const sourceHead = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo });
    const checkoutHead = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    const checkoutBranch = await execFileAsync('git', ['branch', '--show-current'], { cwd: worktreePath });
    expect(checkoutHead.stdout.trim()).toBe(sourceHead.stdout.trim());
    expect(checkoutBranch.stdout.trim()).toBe('');
  });

  it('rejects when the target already exists', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    await expect(worktrees.createDetached({ sourcePath: sourceRepo, worktreePath })).rejects.toThrow();
  });
});

describe('HubWorktrees.validateRemoval', () => {
  it('reports clean reachable state for an untouched detached worktree', async () => {
    const worktreePath = await addNestedWorktree('repo-a');

    const check = await worktrees.validateRemoval({ sourcePath: sourceRepo, worktreePath });

    expect(check).toEqual({ dirty: false, detached: true, headReachableFromBranchRef: true });
  });

  it.each(['untracked', 'unstaged', 'staged'])('reports dirty for %s changes', async (kind) => {
    const worktreePath = await addNestedWorktree('repo-a');
    const file = kind === 'untracked' ? 'scratch.txt' : 'tracked.txt';
    await writeFile(join(worktreePath, file), 'wip\n', 'utf8');
    if (kind === 'staged') await execFileAsync('git', ['add', file], { cwd: worktreePath });

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

  it.each(['refs/heads/feature', 'refs/remotes/origin/feature'])('recognizes detached HEAD reachable from %s', async (ref) => {
    const worktreePath = await addNestedWorktree('repo-a');
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'feature'], { cwd: worktreePath });
    await execFileAsync('git', ['update-ref', ref, 'HEAD'], { cwd: worktreePath });

    const check = await worktrees.validateRemoval({ sourcePath: sourceRepo, worktreePath });

    expect(check.detached).toBe(true);
    expect(check.headReachableFromBranchRef).toBe(true);
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
    await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: worktreePath });

    await worktrees.remove({ sourcePath: sourceRepo, worktreePath });

    const { stdout } = await execFileAsync('git', ['branch', '--list', 'feature'], { cwd: sourceRepo, encoding: 'utf-8' });
    expect(stdout).toContain('feature');
  });
});
