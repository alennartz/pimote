import type { FolderCreator } from '@pimote/sdk/folders';
import { seedCodeFolderAgents } from './manager/seed.js';

/**
 * Code-folder creation routing shared by the ws-handler `create_folder`
 * command and the manager's `pimote_create_folder` tool (DR-062).
 *
 * Routes through the first registered creator whose param schema accepts
 * `{ root, name }` — the built-in creator (mkdir + git init), or a
 * user-authored one taking its slot — then seeds the new folder's AGENTS.md.
 *
 * The seed is best-effort after a successful creation: the creator owns
 * folder existence and may write its own AGENTS.md — a seed failure must not
 * report an already-created folder as failed. Discovery invalidation and the
 * `folders_changed` broadcast stay the caller's contract (each surface pairs
 * them the way its command twin does).
 */
export async function createCodeFolderViaCreators(creators: readonly FolderCreator[], root: string, name: string, body?: string): Promise<{ folderPath: string }> {
  const creator = creators.find((candidate) => {
    const schema = candidate.describe().paramSchema;
    return 'root' in schema && 'name' in schema;
  });
  if (!creator) {
    throw new Error('No folder creator available');
  }
  const created = await creator.create({ root, name });
  await seedCodeFolderAgents(created.path, name, body ?? '').catch((err) => {
    console.warn('[pimote] AGENTS.md seed skipped:', err instanceof Error ? err.message : String(err));
  });
  return { folderPath: created.path };
}
