import type { ProjectCreator } from './types.js';

/**
 * The built-in ProjectCreator: makes a new single-repo project from
 * `{ root, name }` — mkdir under `root` and `git init` it. Registered
 * in-process alongside user-authored creators; backs the dashboard's
 * create-project flow (root + name → mkdir + git init). Rejects when the
 * target folder already exists, creating nothing.
 */
export function createBuiltinCreator(): ProjectCreator {
  throw new Error('not implemented');
}
