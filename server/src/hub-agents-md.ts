import { codeFolderAgentsMd, personaAgentsMd } from './folder-seeding.js';
import type { FolderNature } from './folder-model/index.js';

/**
 * The hub AGENTS.md managed-content mutator (plan: 0.15-2 dashboard folder
 * UX).
 *
 * Seeded member lines live between `<!-- pimote:members (managed block) -->`
 * and `<!-- /pimote:members -->`. One line per member, no paths; the wording
 * is decided by the member's nature and is byte-deterministic per
 * (name, nature).
 *
 * Contract:
 * - `injectMemberLine` inserts the exact line into the managed block. It
 *   never rewrites, reflows, or regenerates surrounding content. When the
 *   block markers are gone, it appends a fresh block.
 * - `removeMemberLine` deletes the line byte-exact and leaves everything else
 *   byte-identical. When the block markers are gone, it does nothing. A line
 *   not found byte-exact is left alone (dead links are acceptable; mangled
 *   user files are not).
 * - The mutator owns only the exact byte strings it seeded.
 */

/** The managed-block markers this module owns. */
const OPEN = '<!-- pimote:members (managed block) -->';
const CLOSE = '<!-- /pimote:members -->';

/** The member's exact seeded link line — byte-deterministic per (name, nature). */
export function seededMemberLine(name: string, nature: 'code' | 'persona'): string {
  return nature === 'code' ? `- ${name} (code): read nested AGENTS.md for context.` : `- ${name} (persona): always spin a sub-agent in this folder to interact with it.`;
}

/** The managed block's inner text and its absolute byte offset; null when
 *  either marker is missing (unclosed blocks count as missing). */
function managedBlock(markdown: string): { inner: string; innerStart: number } | null {
  const openAt = markdown.indexOf(OPEN);
  if (openAt === -1) return null;
  const innerStart = openAt + OPEN.length;
  const closeAt = markdown.indexOf(CLOSE, innerStart);
  if (closeAt === -1) return null;
  return { inner: markdown.slice(innerStart, closeAt), innerStart };
}

/** Offset of `<line>\n` when `line` occupies a whole line of `inner`, else
 *  -1. "Whole line" means preceded by a newline. */
function wholeLineOffset(inner: string, line: string): number {
  const at = inner.indexOf(`\n${line}\n`);
  return at === -1 ? -1 : at + 1;
}

/** The marker-gone fallback: the document verbatim plus a fresh managed
 *  block, separated by a blank line. */
function appendFreshBlock(markdown: string, line: string): string {
  const head = markdown === '' ? '' : markdown.endsWith('\n') ? `${markdown}\n` : `${markdown}\n\n`;
  return `${head}${OPEN}\n${line}\n${CLOSE}\n`;
}

/** Insert `line` into the managed block; append a fresh block when the markers are gone. */
export function injectMemberLine(markdown: string, line: string): string {
  const block = managedBlock(markdown);
  if (block === null) return appendFreshBlock(markdown, line);
  if (wholeLineOffset(block.inner, line) !== -1) return markdown;
  const closeAt = block.innerStart + block.inner.length;
  const separator = closeAt > 0 && markdown.charAt(closeAt - 1) === '\n' ? '' : '\n';
  return `${markdown.slice(0, closeAt)}${separator}${line}\n${markdown.slice(closeAt)}`;
}

/**
 * Return the nature of an exact seeded member line inside the managed block.
 *
 * This is the provenance seam for member links whose targets are absent. It
 * checks only the byte strings this module seeds. User prose and .gitignore
 * entries never authorize membership.
 */
export function managedMemberNature(markdown: string, name: string): FolderNature | undefined {
  const block = managedBlock(markdown);
  if (block === null) return undefined;
  for (const nature of ['code', 'persona'] as const) {
    if (wholeLineOffset(block.inner, seededMemberLine(name, nature)) !== -1) return nature;
  }
  return undefined;
}

/** Delete `line` byte-exact; no-op when the markers or the line are gone. */
export function removeMemberLine(markdown: string, line: string): string {
  const block = managedBlock(markdown);
  if (block === null) return markdown;
  const at = wholeLineOffset(block.inner, line);
  if (at === -1) return markdown;
  const start = block.innerStart + at;
  return markdown.slice(0, start) + markdown.slice(start + line.length + 1);
}

/**
 * Render the registry-created hub `AGENTS.md` (plan: 0.15-2 dashboard folder
 * UX). The code-hub variant leads with a `# <name>` heading and the optional
 * body; the persona-hub variant leads with persona-marker front matter and the
 * optional persona text — both from the shared seed renderers, so the folder
 * and hub paths cannot drift. Both then declare the members managed block,
 * seeded via `injectMemberLine` so creation and later removal use the same
 * byte strings. Source-listed hubs keep `agentsMarkdown` (folder-sources).
 */
export function hubAgentsMarkdown(input: {
  name: string;
  members: { name: string; nature: 'code' | 'persona' }[];
  body?: string;
  persona?: { description: string; personaText: string };
}): string {
  const head = input.persona ? personaAgentsMd(input.name, input.persona.description, input.persona.personaText) : codeFolderAgentsMd(input.name, input.body ?? '');
  const seeded = `${head}\nA hub is a folder composed of shortcuts to its members:\n\n${OPEN}\n${CLOSE}\n`;
  return input.members.reduce((markdown, member) => injectMemberLine(markdown, seededMemberLine(member.name, member.nature)), seeded);
}
