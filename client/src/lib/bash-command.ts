/** Parsed representation of a leading-bang native bash command. */
export interface ParsedBashCommand {
  command: string;
  excludeFromContext: boolean;
}

/**
 * Parse the composer's trimmed leading `!` / `!!` syntax.
 *
 * The implementation is intentionally deferred to the implementation phase;
 * this module is the stable seam used by the composer and its behavioral tests.
 */
export function parseBangBashCommand(_input: string): ParsedBashCommand | null {
  throw new Error('not implemented');
}
