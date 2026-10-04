import { parse as parseYaml } from 'yaml';
import type { PersonaInfo } from './index.js';

/**
 * Parse an AGENTS.md's leading YAML front-matter block into persona info.
 *
 * Pure: content in, value out. Returns null whenever the file carries no
 * usable marker — no front matter, an unclosed block, malformed YAML, a
 * non-object document, or a `name:` that is not a YAML string. Callers treat
 * null as "no marker" and fall back to git classification.
 */
export function parsePersonaFrontMatter(content: string): PersonaInfo | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return null;

  let document: unknown;
  try {
    document = parseYaml(lines.slice(1, close).join('\n'));
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;

  const { name, description } = document as Record<string, unknown>;
  if (typeof name !== 'string') return null;
  return typeof description === 'string' ? { name, description } : { name };
}
