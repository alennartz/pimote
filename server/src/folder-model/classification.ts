import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { FolderFs, PersonaInfo } from './index.js';
import { parsePersonaFrontMatter } from './marker.js';

/** Marker/git classification of one folder. `null` means the folder is skipped. */
export type FolderClassification = { nature: 'persona'; persona: PersonaInfo } | { nature: 'code' } | null;

/**
 * Classify one folder from its directory listing: an AGENTS.md front-matter
 * marker wins over a .git entry; neither yields null (skipped).
 *
 * Shared by discovery and the classifyFolder fallback. An unreadable marker
 * behaves as absent; `onUnreadableMarker` lets the scanner surface that as a
 * warning while the fallback stays silent.
 */
export async function classifyListing(
  fs: FolderFs,
  folderPath: string,
  listing: Dirent[],
  onUnreadableMarker?: (markerPath: string, error: unknown) => void,
): Promise<FolderClassification> {
  const hasEntry = (name: string): boolean => listing.some((dirent) => dirent.name === name);

  if (hasEntry('AGENTS.md')) {
    const markerPath = join(folderPath, 'AGENTS.md');
    const persona = await readPersonaMarker(fs, markerPath, onUnreadableMarker);
    if (persona) return { nature: 'persona', persona };
  }
  return hasEntry('.git') ? { nature: 'code' } : null;
}

async function readPersonaMarker(fs: FolderFs, markerPath: string, onUnreadableMarker?: (markerPath: string, error: unknown) => void): Promise<PersonaInfo | null> {
  try {
    return parsePersonaFrontMatter(await fs.readFile(markerPath));
  } catch (error) {
    onUnreadableMarker?.(markerPath, error);
    return null;
  }
}
