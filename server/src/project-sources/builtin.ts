import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidProjectName } from '../project-registry.js';
import type { ProjectCreator } from './types.js';

const execFileAsync = promisify(execFile);

/** Same env guard as git-branch.ts: inherited Git env vars must not force resolution to another repo. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * The built-in ProjectCreator: makes a new single-repo project from
 * `{ root, name }` — mkdir under `root` and `git init` it. Registered
 * in-process alongside user-authored creators; backs the dashboard's
 * create-project flow (root + name → mkdir + git init). Rejects when the
 * target folder already exists, creating nothing.
 */
export function createBuiltinCreator(): ProjectCreator {
  return {
    id: 'builtin-folder',

    describe() {
      return { label: 'New project folder', paramSchema: { root: 'string', name: 'string' } };
    },

    async create(params: Record<string, unknown>): Promise<{ path: string }> {
      const root = params.root;
      const name = params.name;

      // Validate everything before any filesystem mutation. Shared rule with
      // the registry and the WS create_project path.
      if (typeof name !== 'string' || !isValidProjectName(name)) {
        throw new Error('Invalid project name');
      }
      if (typeof root !== 'string' || !root) {
        throw new Error('Invalid project root');
      }
      try {
        await stat(root);
      } catch {
        throw new Error('Project root does not exist');
      }

      const target = join(root, name);
      try {
        await stat(target);
        throw new Error('Directory already exists');
      } catch (err) {
        if (!isMissing(err)) throw err;
        // ENOENT — target is free, proceed.
      }

      await mkdir(target, { recursive: true });
      await execFileAsync('git', ['init'], { cwd: target, env: gitEnv(), encoding: 'utf-8', timeout: 2000 });
      return { path: target };
    },
  };
}
