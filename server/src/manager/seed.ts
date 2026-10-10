import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Boot seeding of the manager root (plan: manager-lifecycle).
 *
 * Contract (`seedManagerRoot(config.managerRoot)`, run after config load,
 * before or independent of first session):
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
 */

/** The maintain-`memory.md` instruction shared by every shipped persona
 *  prompt: the manager seed and persona creation fold it into their bodies. */
export const MEMORY_MAINTENANCE_INSTRUCTION = 'Keep your long-term notes up to date in memory.md: record decisions, durable context, and anything worth remembering there.';

/** Shipped `memory.md` stub, written beside a persona `AGENTS.md` when the
 *  file is absent. */
export const MEMORY_STUB = '# Memory\n\nDurable notes for this persona. Update this file as you learn.\n';

/** The shipped manager `AGENTS.md` template: persona-marker front matter,
 *  mission statement, maintain-`memory.md` indication, no tool listing. */
const MANAGER_AGENTS_TEMPLATE = `---
kind: persona
name: manager
description: Mission statement for the manager persona of this Pimote installation.
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
