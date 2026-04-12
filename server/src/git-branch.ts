import { execFileSync } from 'node:child_process';

/** Resolve the current git branch for a directory. Returns null if not a git repo or detached. */
export function getGitBranch(cwd: string): string | null {
  // Guard against inherited Git env vars forcing resolution to another repo.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const runGit = (args: string[]): string | null => {
    try {
      const value = execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return value || null;
    } catch {
      return null;
    }
  };

  // Best signal for the checked-out branch (works with linked worktrees).
  const current = runGit(['branch', '--show-current']);
  if (current) return current;

  // Fallback for older Git versions / unusual setups.
  const abbrevRef = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!abbrevRef || abbrevRef === 'HEAD') return null;
  return abbrevRef;
}
