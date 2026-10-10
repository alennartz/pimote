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

/** The member's exact seeded link line — byte-deterministic per (name, nature). */
export function seededMemberLine(name: string, nature: 'code' | 'persona'): string {
  void [name, nature];
  throw new Error('not implemented');
}

/** Insert `line` into the managed block; append a fresh block when the markers are gone. */
export function injectMemberLine(markdown: string, line: string): string {
  void [markdown, line];
  throw new Error('not implemented');
}

/** Delete `line` byte-exact; no-op when the markers or the line are gone. */
export function removeMemberLine(markdown: string, line: string): string {
  void [markdown, line];
  throw new Error('not implemented');
}
