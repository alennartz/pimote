import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read the installed Pimote package version from its package manifest. */
export async function getVersion(): Promise<string> {
  const raw = await readFile(join(ROOT_DIR, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}
