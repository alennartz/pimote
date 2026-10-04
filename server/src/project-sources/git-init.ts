import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Same env guard as git-branch.ts: inherited Git env vars must not force resolution to another repo. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * `git init` in `dir` — the one operation every server-side folder creation
 * path (built-in creator, hub materialization) uses to turn a fresh directory
 * into a git repo, with the shared env guard applied.
 */
export async function gitInitDir(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir, env: gitEnv(), encoding: 'utf-8', timeout: 2000 });
}
