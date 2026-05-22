import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardColor } from '../../../shared/dist/index.js';

/** One persisted entry; the in-memory `StaticHostRegistration.sessionId` is implicit from the filename. */
export interface StaticHostStoreEntry {
  slug: string;
  folderPath: string;
  cardMetadata: { title: string; tag?: string; color?: CardColor };
}

/** The on-disk shape of `<storeDir>/<sessionId>.json`. */
export interface StaticHostStoreFile {
  version: 1;
  entries: StaticHostStoreEntry[];
}

/**
 * Per-session JSON persistence for the static-host extension.
 *
 * Files live at `${storeDir}/${sessionId}.json`. Writes are atomic
 * (write-to-tmp + rename) so a crash mid-write never leaves a half-written file.
 */
export interface StaticHostStore {
  /** Read state for a session, or `undefined` if no file exists. */
  read(sessionId: string): Promise<StaticHostStoreFile | undefined>;

  /** Atomically write state. Creates the directory tree if missing. */
  write(sessionId: string, file: StaticHostStoreFile): Promise<void>;

  /** Delete the file for a session. No-op if absent. */
  remove(sessionId: string): Promise<void>;
}

/**
 * Filesystem-backed `StaticHostStore`. One file per sessionId under `storeDir`.
 */
export class FileStaticHostStore implements StaticHostStore {
  constructor(private readonly storeDir: string) {}

  private pathFor(sessionId: string): string {
    return join(this.storeDir, `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<StaticHostStoreFile | undefined> {
    const path = this.pathFor(sessionId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return JSON.parse(raw) as StaticHostStoreFile;
  }

  async write(sessionId: string, file: StaticHostStoreFile): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const finalPath = this.pathFor(sessionId);
    const tmpPath = finalPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, finalPath);
  }

  async remove(sessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(sessionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}
