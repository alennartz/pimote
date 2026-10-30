import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidFolderName } from '../folder-registry.js';
import { gitInitDir } from './git-init.js';

export interface BuiltinCodeFolderCreator {
  readonly id: string;
  describe(): { label: string; paramSchema: Record<string, 'string' | 'string[]'> };
  create(params: Record<string, unknown>): Promise<{ path: string }>;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * The built-in folder creator makes a new single-repo folder from
 * `{ root, name }` — mkdir under `root` and `git init` it. It backs the
 * dashboard's core create-folder flow (root + name → mkdir + git init).
 * It rejects an existing target and returns the new folder's canonical
 * filesystem identity.
 */
export function createBuiltinCreator(): BuiltinCodeFolderCreator {
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
      // Folder-model identity is canonical, even when the configured root
      // reaches the new folder through a symlink alias.
      return { path: await realpath(target) };
    },
  };
}
