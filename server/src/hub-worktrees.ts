import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The hub worktree Git adapter (plan: hub-member-representation). A deep
 * server module that owns the Git CLI seam for detached worktree creation,
 * nested-worktree recognition, status/reachability validation, and removal
 * for worktree hubs.
 *
 * Contract:
 * - It never creates, names, attaches, merges, deletes, or fetches branches.
 *   Worktree hubs are disposable feature workspaces: users or agents own
 *   branch creation and remote PR work.
 * - `createDetached` runs `git worktree add --detach <hub-child> HEAD` from
 *   the canonical code member. It does not inspect or modify the member's
 *   branch, stash changes, move changes, or use the pi extension's shared
 *   `.git-worktrees` directory.
 * - `inspectMember` accepts only a top-level hub child. It recognizes a
 *   worktree when the child has a `.git` file and `git worktree list
 *   --porcelain` confirms the exact checkout. It rejects ordinary nested
 *   directories, independent repositories with `.git` directories, and
 *   paths Git cannot verify.
 * - `validateRemoval` for ordinary member removal requires an empty
 *   `git status --porcelain`. Disband adds the stronger detached-`HEAD`
 *   reachability check: `HEAD` must be reachable from a local
 *   `refs/heads/*` or remote-tracking `refs/remotes/*` ref. Neither path
 *   fetches or performs branch operations.
 * - It accepts a guarded `execFile` adapter in tests and uses the
 *   repository's existing environment protections and command timeouts.
 */

/** The guarded Git CLI seam: one command run inside `cwd`. Adapters apply
 *  the repo's environment protections (no inherited GIT_DIR/GIT_WORK_TREE)
 *  and command timeouts. */
export type WorktreeGitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

/** Status facts for one nested worktree member, derived from Git. */
export interface WorktreeMemberFacts {
  /** The canonical source checkout, resolved from Git's worktree set. */
  sourcePath: string;
  /** The nested checkout inside the hub. */
  worktreePath: string;
  /** The checked-out branch; null when detached. */
  branch: string | null;
  dirty: boolean;
  detached: boolean;
  /** True when `HEAD` is reachable from a local or remote-tracking branch ref. */
  headReachableFromBranchRef: boolean;
}

/** Removal-guard facts for one nested worktree: clean state plus, for
 *  disband, detached-`HEAD` reachability. */
export interface WorktreeRemovalCheck {
  dirty: boolean;
  detached: boolean;
  headReachableFromBranchRef: boolean;
}

/** The worktree seam the folder registry consumes. */
export interface HubWorktreePort {
  /** Recognize a nested detached worktree at a top-level hub child; null
   *  for ordinary directories, independent repositories, and unverifiable
   *  paths. */
  inspectMember(path: string): Promise<WorktreeMemberFacts | null>;
  /** Create a detached worktree at `worktreePath` from `sourcePath`'s HEAD. */
  createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void>;
  /** Validate removal preconditions without mutating anything. */
  validateRemoval(input: { sourcePath: string; worktreePath: string }): Promise<WorktreeRemovalCheck>;
  /** Remove the nested worktree through Git; the source stays untouched. */
  remove(input: { sourcePath: string; worktreePath: string }): Promise<void>;
}

const GIT_TIMEOUT_MS = 30_000;

/** The production runner: same environment protections as the repo's other
 *  Git seams (no inherited GIT_DIR/GIT_WORK_TREE, no optional locks) and a
 *  command timeout, so a stalled Git CLI cannot hang a registry mutation. */
export const defaultWorktreeGitRunner: WorktreeGitRunner = async (args, cwd) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_OPTIONAL_LOCKS = '0';
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
  return { stdout };
};

/** One entry of `git worktree list --porcelain`. */
interface WorktreeListEntry {
  path: string;
  /** `refs/heads/<name>` when attached; absent when detached. */
  branchRef: string | null;
  detached: boolean;
  bare: boolean;
}

function parseWorktreeList(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line === '') {
      current = null;
      continue;
    }
    const spaceIndex = line.indexOf(' ');
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
    if (key === 'worktree') {
      current = { path: value, branchRef: null, detached: false, bare: false };
      entries.push(current);
    } else if (current) {
      if (key === 'branch') current.branchRef = value;
      else if (key === 'detached') current.detached = true;
      else if (key === 'bare') current.bare = true;
    }
  }
  return entries;
}

function branchNameFromRef(branchRef: string | null): string | null {
  const prefix = 'refs/heads/';
  return branchRef?.startsWith(prefix) ? branchRef.slice(prefix.length) : null;
}

/** Non-empty `git status --porcelain` — staged, unstaged, and untracked
 *  changes all count as dirty. */
async function isDirty(run: WorktreeGitRunner, cwd: string): Promise<boolean> {
  const { stdout } = await run(['status', '--porcelain'], cwd);
  return stdout.trim() !== '';
}

/** True when `HEAD` is reachable from some local or remote-tracking branch
 *  ref: rev-list with `--not --branches --remotes` must come up empty. No
 *  fetch, no branch operations. */
async function isHeadReachableFromBranchRef(run: WorktreeGitRunner, cwd: string): Promise<boolean> {
  const { stdout } = await run(['rev-list', 'HEAD', '--not', '--branches', '--remotes'], cwd);
  return stdout.trim() === '';
}

export class HubWorktrees implements HubWorktreePort {
  constructor(private readonly run: WorktreeGitRunner) {}

  async inspectMember(path: string): Promise<WorktreeMemberFacts | null> {
    // A linked worktree carries `.git` as a file; an independent repository
    // carries it as a directory and never counts as a hub member.
    const gitEntry = await lstat(join(path, '.git')).catch(() => null);
    if (!gitEntry?.isFile()) return null;

    const resolved = await realpath(path).catch(() => null);
    if (!resolved) return null;

    let entries: WorktreeListEntry[];
    try {
      entries = parseWorktreeList((await this.run(['worktree', 'list', '--porcelain'], path)).stdout);
    } catch {
      // Git cannot verify this checkout (broken .git file, corrupt repo).
      return null;
    }
    const own = entries.find((entry) => resolve(entry.path) === resolve(resolved));
    if (!own) return null;
    // The main worktree is listed first; that checkout is the canonical
    // source repository the member was detached from.
    const source = entries.find((entry) => !entry.bare);
    if (!source) return null;

    return {
      sourcePath: source.path,
      worktreePath: own.path,
      branch: branchNameFromRef(own.branchRef),
      dirty: await isDirty(this.run, path),
      detached: own.detached || own.branchRef === null,
      headReachableFromBranchRef: await isHeadReachableFromBranchRef(this.run, path),
    };
  }

  async createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void> {
    await this.run(['worktree', 'add', '--detach', input.worktreePath, 'HEAD'], input.sourcePath);
  }

  async validateRemoval(input: { sourcePath: string; worktreePath: string }): Promise<WorktreeRemovalCheck> {
    const [dirty, detached, headReachableFromBranchRef] = await Promise.all([
      isDirty(this.run, input.worktreePath),
      this.isDetached(input.worktreePath),
      isHeadReachableFromBranchRef(this.run, input.worktreePath),
    ]);
    return { dirty, detached, headReachableFromBranchRef };
  }

  async remove(input: { sourcePath: string; worktreePath: string }): Promise<void> {
    // No --force: the clean-state guard is authoritative, and Git's own
    // dirty-worktree refusal is the second line of defense.
    await this.run(['worktree', 'remove', input.worktreePath], input.sourcePath);
  }

  private async isDetached(cwd: string): Promise<boolean> {
    const { stdout } = await this.run(['branch', '--show-current'], cwd);
    return stdout.trim() === '';
  }
}
