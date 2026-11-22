import { fuzzyFilter } from '../fuzzy.js';
import type { LauncherCategory, LauncherCommand, LauncherPrefix, ParsedLauncherQuery } from './contracts.js';

const PREFIX_MAP: Readonly<Record<LauncherPrefix, LauncherCategory>> = {
  '>': 'commands',
  '@': 'sessions',
  '#': 'folders',
};

function isLauncherPrefix(char: string): char is LauncherPrefix {
  return char === '>' || char === '@' || char === '#';
}

export function parseLauncherQuery(raw: string): ParsedLauncherQuery {
  const trimmed = raw.trim();
  if (trimmed.length > 0 && isLauncherPrefix(trimmed[0])) {
    const prefix = trimmed[0];
    return {
      raw,
      category: PREFIX_MAP[prefix],
      prefix,
      term: trimmed.slice(1).trim(),
    };
  }
  return {
    raw,
    category: 'all',
    prefix: null,
    term: trimmed,
  };
}

export function filterLauncherCommands(commands: readonly LauncherCommand[], term: string): LauncherCommand[] {
  const available = commands.filter((command) => (command.isAvailable ? command.isAvailable() : true));
  const trimmed = term.trim();
  if (!trimmed) return available;
  return fuzzyFilter(available, trimmed, (command) => (command.keywords?.length ? `${command.label} ${command.keywords.join(' ')}` : command.label));
}
