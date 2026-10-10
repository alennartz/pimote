import { parse as parseYaml } from 'yaml';
import type { PersonaInfo } from './index.js';

/**
 * Parse an AGENTS.md's leading YAML front-matter block into persona info.
 *
 * Pure: content in, value out. Returns null whenever the file carries no
 * usable marker — no front matter, an unclosed block, malformed YAML, a
 * non-object document, or a `kind` that is not `persona`. `name` and
 * `description` are captured when present as YAML strings. Callers treat
 * null as "no marker" and fall back to git classification.
 */
export function parsePersonaFrontMatter(content: string): PersonaInfo | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  // The close delimiter must sit at column 0: a whitespace-trimmed match would
  // also close on an indented `---` inside a YAML block scalar, silently
  // truncating the document.
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  if (close === -1) return null;

  let document: unknown;
  try {
    document = parseYaml(lines.slice(1, close).join('\n'));
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;

  const { kind, name, description } = document as Record<string, unknown>;
  if (kind !== 'persona') return null;
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof description === 'string' ? { description } : {}),
  };
}
