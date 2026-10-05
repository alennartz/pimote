import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidFolderName } from '../folder-registry.js';
import type { FolderCreator } from '@pimote/sdk/folders';
import { gitInitDir } from './git-init.js';

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * The built-in FolderCreator: makes a new single-repo folder from
 * `{ root, name }` — mkdir under `root` and `git init` it. Registered
 * in-process alongside user-authored creators; backs the dashboard's
 * create-folder flow (root + name → mkdir + git init). Rejects when the
 * target folder already exists, creating nothing.
 */
export function createBuiltinCreator(): FolderCreator {
  return {
    id: 'builtin-folder',

    describe() {
      return { label: 'New code folder', paramSchema: { root: 'string', name: 'string' } };
    },

    async create(params: Record<string, unknown>): Promise<{ path: string }> {
      const root = params.root;
      const name = params.name;

      // Validate everything before any filesystem mutation. Shared rule with
      // the registry and the WS create_folder path.
      if (typeof name !== 'string' || !isValidFolderName(name)) {
        throw new Error('Invalid folder name');
      }
      if (typeof root !== 'string' || !root) {
        throw new Error('Invalid root');
      }
      try {
        await stat(root);
      } catch {
        throw new Error('Root does not exist');
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
      await gitInitDir(target);
      return { path: target };
    },
  };
}
