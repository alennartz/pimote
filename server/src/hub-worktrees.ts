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

export class HubWorktrees implements HubWorktreePort {
  constructor(private readonly run: WorktreeGitRunner) {}

  async inspectMember(_path: string): Promise<WorktreeMemberFacts | null> {
    throw new Error('not implemented');
  }

  async createDetached(_input: { sourcePath: string; worktreePath: string }): Promise<void> {
    throw new Error('not implemented');
  }

  async validateRemoval(_input: { sourcePath: string; worktreePath: string }): Promise<WorktreeRemovalCheck> {
    throw new Error('not implemented');
  }

  async remove(_input: { sourcePath: string; worktreePath: string }): Promise<void> {
    throw new Error('not implemented');
  }
}
