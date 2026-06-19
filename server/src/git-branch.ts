import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolve the current git branch for a directory. Returns null if not a git repo or detached.
 *  Async (non-blocking): callers must not run this on the event loop synchronously. */
export async function getGitBranch(cwd: string): Promise<string | null> {
  // Guard against inherited Git env vars forcing resolution to another repo.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const runGit = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        env,
        encoding: 'utf-8',
        timeout: 2000,
      });
      const value = stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  };

  // Best signal for the checked-out branch (works with linked worktrees).
  const current = await runGit(['branch', '--show-current']);
  if (current) return current;

  // Fallback for older Git versions / unusual setups.
  const abbrevRef = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!abbrevRef || abbrevRef === 'HEAD') return null;
  return abbrevRef;
}
