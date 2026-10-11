/**
 * Seeded folder text (plan: 0.15-2 dashboard folder UX): the one owner of the
 * seeded `AGENTS.md` renderers and the `memory.md` stub shared by every
 * folder-creation path — the wire's `create_persona_folder`/`create_folder`,
 * the manager's `pimote_create_persona`, and hub materialization. Seeding
 * text is rendered here once, so the folder and hub paths cannot drift.
 * `manager/seed.ts` owns the seeding seams and composes these renderers;
 * the core library modules never import `manager/`.
 */

/** Shipped `memory.md` stub, written beside a persona `AGENTS.md` when the
 *  file is absent. */
export const MEMORY_STUB = '# Memory\n\nDurable notes for this persona. Update this file as you learn.\n';

/** The persona-marker front-matter block (`---` delimited, no trailing
 *  newline). Values are JSON-quoted — JSON strings are valid YAML double-
 *  quoted scalars — so `parsePersonaFrontMatter` round-trips them exactly on
 *  one line each. */
export function personaFrontMatter(name: string, description: string): string {
  return ['---', 'kind: persona', `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description)}`, '---'].join('\n');
}

/** One optional body section: a blank line plus the trimmed text plus its
 *  trailing newline; empty when the text is blank. */
function bodySection(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `\n${trimmed}\n` : '';
}

/** Persona `AGENTS.md` text: marker front matter plus the verbatim (trimmed)
 *  persona body. Pure: input in, text out. */
export function personaAgentsMd(name: string, description: string, personaText: string): string {
  return `${personaFrontMatter(name, description)}\n${bodySection(personaText)}`;
}

/** Code-folder `AGENTS.md` text: a `# <name>` heading plus the (trimmed) body. */
export function codeFolderAgentsMd(name: string, body: string): string {
  return `# ${name}\n${bodySection(body)}`;
}
