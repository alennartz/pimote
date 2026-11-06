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
 * - `recognize` accepts only a top-level hub child. It recognizes a worktree
 *   when the child has a `.git` file and `git worktree list --porcelain`
 *   confirms the exact checkout. It rejects ordinary nested directories,
 *   independent repositories with `.git` directories, and paths that Git
 *   cannot verify. It runs no status probes, so the listing path never
 *   blocks on Git beyond the one recognition command.
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

/** Recognition facts for one nested worktree member, without status probes. */
export interface WorktreeRecognition {
  /** The nested checkout inside the hub. */
  worktreePath: string;
  /** Candidate canonical sources from Git's worktree set, excluding this
   *  checkout. The registry resolves the member's canonical identity against
   *  known folders, preferring a basename match to preserve a selected linked
   *  worktree's identity. Bare repositories remain candidates. */
  sourceCandidates: string[];
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
  /** Recognize a nested worktree at a top-level hub child without probing
   *  status; null for ordinary directories, independent repositories, and
   *  unverifiable paths. */
  recognize(path: string): Promise<WorktreeRecognition | null>;
  /** Create a detached worktree at `worktreePath` from `sourcePath`'s HEAD. */
  createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void>;
  /** Validate removal preconditions without mutating anything. */
  validateRemoval(input: { sourcePath: string; worktreePath: string }): Promise<WorktreeRemovalCheck>;
  /** Remove the nested worktree through Git; the source stays untouched. */
  remove(input: { sourcePath: string; worktreePath: string }): Promise<void>;
  /** Whether the Git repository at `path` carries uncommitted changes after
   *  ignoring the named generated top-level files. */
  isDirty(path: string, allowedPaths?: ReadonlySet<string>): Promise<boolean>;
  /** Drop stale worktree metadata left behind when a checkout was removed
   *  behind Git's back. */
  pruneStale(sourcePath: string): Promise<void>;
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

/** Non-empty `git status --porcelain` — staged, unstaged, and untracked
 *  changes all count as dirty. */
async function isDirty(run: WorktreeGitRunner, cwd: string, allowedPaths: ReadonlySet<string> = new Set()): Promise<boolean> {
  const { stdout } = await run(['status', '--porcelain', '--untracked-files=all'], cwd);
  return stdout.split('\n').some((line) => {
    if (line.trim() === '') return false;
    const path = line.slice(3).trim().replace(/\/$/, '');
    // Fresh generated files are intentionally untracked. A staged new
    // generated file is also safe. Once a generated file is modified or
    // deleted after staging, it is hub-owned dirty content and must block
    // destructive disband.
    const status = line.slice(0, 2);
    return !allowedPaths.has(path) || (status !== '??' && status !== 'A ');
  });
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

  async recognize(path: string): Promise<WorktreeRecognition | null> {
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
    // Exclude the selected checkout itself. Keep bare entries: a bare source
    // repository is a valid canonical member even though it has no working
    // tree of its own.
    const sourceCandidates = entries.filter((entry) => resolve(entry.path) !== resolve(own.path)).map((entry) => entry.path);
    return { worktreePath: own.path, sourceCandidates };
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

  async isDirty(path: string, allowedPaths?: ReadonlySet<string>): Promise<boolean> {
    return isDirty(this.run, path, allowedPaths);
  }

  async pruneStale(sourcePath: string): Promise<void> {
    await this.run(['worktree', 'prune'], sourcePath);
  }

  private async isDetached(cwd: string): Promise<boolean> {
    const { stdout } = await this.run(['branch', '--show-current'], cwd);
    return stdout.trim() === '';
  }
}
