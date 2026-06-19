/**
 * Boot-time garbage collection of the per-session static-host persistence dir.
 *
 * Reads `storeDir`, deletes any `<sessionId>.json` whose sessionId is not in
 * `validSessionIds`. The directory not existing is not an error (returns OK
 * without doing anything). Has no knowledge of the registry, the extension,
 * or the HTTP layer.
 *
 * Called from `server/src/index.ts` after `FolderIndex` initialisation and
 * before `server.start()` so the HTTP route never sees a stale slug pointing
 * at a folder that the agent has long since deleted.
 */
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function gcStaticHostStore(args: { storeDir: string; validSessionIds: Set<string> }): Promise<void> {
  const { storeDir, validSessionIds } = args;
  let entries: string[];
  try {
    entries = await readdir(storeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const suffix = '.json';
  for (const name of entries) {
    // Orphan write tmp file (`<sessionId>.json.tmp`) left by a crash between
    // writeFile and rename. GC runs at boot before any write, so a leftover
    // .tmp is always stale — unlink unconditionally.
    if (name.endsWith('.json.tmp')) {
      try {
        await unlink(join(storeDir, name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      continue;
    }
    if (!name.endsWith(suffix)) continue;
    const sessionId = name.slice(0, -suffix.length);
    if (validSessionIds.has(sessionId)) continue;
    try {
      await unlink(join(storeDir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}
