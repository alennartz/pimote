import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(entry.name.endsWith('.ts') ? [path] : []);
    }),
  );
  return nested.flat();
}

describe('manager protocol cutover', () => {
  it('removes all manager-specific prompt, abort, and event vocabulary from shared source', async () => {
    const directory = fileURLToPath(new URL('../../../shared/src/', import.meta.url));
    const files = await sourceFiles(directory);
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const content = await readFile(path, 'utf8');
      expect(content, path).not.toMatch(/\bmanager_(?:prompt|abort|event)\b/);
    }
  });
});
