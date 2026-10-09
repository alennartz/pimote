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
 * are injected). YAML front matter has `name: manager` and a nonempty one-line
 * description, so the folder model classifies the seed as a persona.
 * Filesystem errors propagate to the boot caller.
 */
export async function seedManagerRoot(_managerRoot: string): Promise<void> {
  throw new Error('not implemented');
}
