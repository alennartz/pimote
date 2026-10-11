import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codeFolderAgentsMd, MEMORY_STUB, personaAgentsMd } from '../folder-seeding.js';

/**
 * Boot seeding of the manager root and the persona/code seeding seams
 * (plans: manager-lifecycle, 0.15-2 dashboard folder UX).
 *
 * The manager-root contract (`seedManagerRoot(config.managerRoot)`, run after
 * config load, before or independent of first session):
 * - `AGENTS.md` absent  -> write the shipped seed template
 * - `AGENTS.md` present -> untouched (no merge, ever)
 * - `memory.md` absent  -> write a stub
 * - `memory.md` present -> untouched
 *
 * The seed template is a code constant in the server package: a mission
 * statement plus the maintain-`memory.md` indication; no tool listing (tools
 * are injected). YAML front matter has `kind: persona`, `name: manager`, and
 * a nonempty one-line description, so the folder model classifies the seed as
 * a persona. Filesystem errors propagate to the boot caller.
 *
 * The seeding seams below compose the shared renderers from
 * `folder-seeding.ts` — the one owner of the seeded text — so the folder and
 * hub paths cannot drift.
 */

// Re-exported for callers pinned to this module (plan: 0.15-2 Interface
// Files name `manager/seed.ts` as the seam's home).
export { MEMORY_STUB } from '../folder-seeding.js';

/** The maintain-`memory.md` instruction shared by every shipped persona
 *  prompt: the manager seed and persona creation fold it into their bodies. */
export const MEMORY_MAINTENANCE_INSTRUCTION = 'Keep your long-term notes up to date in memory.md: record decisions, durable context, and anything worth remembering there.';

/** The shipped manager `AGENTS.md` template: persona-marker front matter,
 *  mission statement, maintain-`memory.md` indication, no tool listing. */
const MANAGER_AGENTS_TEMPLATE = `---
kind: persona
name: manager
description: top level manager persona of this Pimote installation.
---

# Manager

You are the manager of this Pimote installation.
You keep the overview of its folders, personas, and sessions. Help the user
start, resume, and archive work, and create persona folders when asked.

${MEMORY_MAINTENANCE_INSTRUCTION}
`;

/** Write-if-absent seed for one file. An existing destination (including a
 *  race with another writer) stays untouched; every other error propagates. */
async function seedFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Seed the manager root: write each absent file independently, preserve
 *  existing files byte-for-byte, propagate every filesystem error other than
 *  an existing destination. */
export async function seedManagerRoot(managerRoot: string): Promise<void> {
  await seedFile(join(managerRoot, 'AGENTS.md'), MANAGER_AGENTS_TEMPLATE);
  await seedFile(join(managerRoot, 'memory.md'), MEMORY_STUB);
}

/**
 * The persona-folder seeding seam (plan: 0.15-2 dashboard folder UX). Called
 * by the `create_persona_folder` handler and the manager's
 * `pimote_create_persona` tool.
 *
 * Contract:
 * - Creates the folder under `root` named `name`, then writes `AGENTS.md`
 *   (front matter: `kind: persona`, `name`, `description`; body:
 *   `personaText`) and the `memory.md` stub.
 * - `personaText` may be empty — both files are ALWAYS written; skipping the
 *   text step never skips the files (the front matter is the persona marker,
 *   mandatory; the folder-scoped editor always has something to open).
 * - Refuses an existing destination (`mkdir` non-recursive, `EEXIST`
 *   propagates) and leaves it untouched. When a write fails after creation,
 *   the folder is removed again before the error rethrows.
 * - Returns the created folder's canonical path. `name` is not validated
 *   here; callers validate with `isValidFolderName`.
 */
export async function seedPersonaFolder(root: string, name: string, description: string, personaText: string): Promise<string> {
  const folderPath = join(root, name);
  let created = false;
  try {
    await mkdir(folderPath);
    created = true;
    await writeFile(join(folderPath, 'AGENTS.md'), personaAgentsMd(name, description, personaText), 'utf8');
    await writeFile(join(folderPath, 'memory.md'), MEMORY_STUB, 'utf8');
    return await realpath(folderPath);
  } catch (error) {
    if (created) await rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Code-folder `AGENTS.md` seed: write-if-absent — an existing `AGENTS.md`
 *  (for example one a user-authored creator wrote) stays untouched. */
export async function seedCodeFolderAgents(folderPath: string, name: string, body: string): Promise<void> {
  await seedFile(join(folderPath, 'AGENTS.md'), codeFolderAgentsMd(name, body));
}
