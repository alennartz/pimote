/** Parsed representation of a leading-bang native bash command. */
export interface ParsedBashCommand {
  command: string;
  excludeFromContext: boolean;
}

/**
 * Parse the composer's leading `!` / `!!` syntax.
 *
 * Only the outer input and the boundary between the prefix and command are
 * trimmed. Once that boundary is removed, the shell text is returned as-is so
 * quoting and internal whitespace retain their meaning.
 */
export function parseBangBashCommand(input: string): ParsedBashCommand | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('!!')) {
    const command = trimmed.slice(2).trim();
    return command ? { command, excludeFromContext: true } : null;
  }

  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    return command ? { command, excludeFromContext: false } : null;
  }

  return null;
}
