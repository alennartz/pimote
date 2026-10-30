import { realpath } from 'node:fs/promises';
import { createBuiltinCreator } from './folder-sources/builtin.js';
import { seedCodeFolderAgents } from './manager/seed.js';

/**
 * Code-folder creation routing shared by the ws-handler `create_folder`
 * command and the manager's `pimote_create_folder` tool (DR-062).
 *
 * Pimote core owns code-folder creation. The built-in creator makes the
 * directory and initializes git. This boundary resolves the created path to
 * its canonical identity and seeds the new folder's AGENTS.md.
 *
 * The seed is best-effort after a successful creation: the creator owns
 * folder existence and may write its own AGENTS.md — a seed failure must not
 * report an already-created folder as failed. Discovery invalidation and the
 * `folders_changed` broadcast stay the caller's contract (each surface pairs
 * them the way its command twin does).
 */
export async function createCodeFolder(root: string, name: string, body?: string): Promise<{ folderPath: string }> {
  const created = await createBuiltinCreator().create({ root, name });
  // Resolve the lexical path before any seed, broadcast, or session open so
  // every downstream folder identity matches traversal's canonical path.
  const folderPath = await realpath(created.path);
  await seedCodeFolderAgents(folderPath, name, body ?? '').catch((err) => {
    console.warn('[pimote] AGENTS.md seed skipped:', err instanceof Error ? err.message : String(err));
  });
  return { folderPath };
}
